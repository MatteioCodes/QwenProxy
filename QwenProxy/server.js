// OpenAI-compatible proxy for chat.qwen.ai
//
// Exposes ONLY the `qwen3.8-max-preview` model and forwards requests to your own
// authenticated chat.qwen.ai session. Zero external dependencies (Node 18+).
//
// Endpoints:
//   GET    /v1/models                     -> lists the single allowed model
//   POST   /v1/chat/completions           -> OpenAI chat completions (streaming or not)
//   DELETE /v1/conversations/{id}         -> clear one conversation's memory
//   POST   /v1/conversations/{id}/reset   -> same, as a POST
//   GET    /health                        -> quick liveness/token check
//
// Memory: the proxy keeps its own role-tagged history per conversation (see
// store.js) and is authoritative. Each request runs in a throwaway Qwen chat that
// is created, used, then deleted — so your chat.qwen.ai sidebar stays clean while
// the model still "remembers" via the stored history.

import http from "node:http";
import { randomUUID } from "node:crypto";
import { getHistory, saveHistory, clearConversation, MEMORY_FILE } from "./store.js";
import { fetchImageBytes, uploadImage } from "./upload.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const QWEN_BASE = "https://chat.qwen.ai";
const ALLOWED_MODEL = "qwen3.8-max-preview";

const PORT = Number(process.env.PORT || 8787);
const QWEN_TOKEN = process.env.QWEN_TOKEN || "";
// Optional: some deployments require the device id cookie/header. Grab it from
// localStorage["qwen_chat_device_id"] in the browser if requests fail.
const QWEN_DEVICE_ID = process.env.QWEN_DEVICE_ID || randomUUID();
// The web client sends a "Version" header equal to the frontend app version.
// This is REQUIRED — without it the completions endpoint returns "Internal error".
// If Qwen updates their frontend and this breaks, bump it (see the "Version"
// header the real chat.qwen.ai client sends in DevTools > Network).
const QWEN_CLIENT_VERSION = process.env.QWEN_CLIENT_VERSION || "0.2.74";
// Whether to include the model's chain-of-thought (the "think" phase) in the
// output. Off by default so the OpenAI-style output only contains the final
// answer. NOTE: qwen3.8-max-preview requires thinking to be *enabled* in the
// request (thinking_enabled:false is rejected with "invalid_input"), so we always
// request it and merely filter the reasoning out of the response when this is off.
const QWEN_THINKING = /^(1|true|yes)$/i.test(process.env.QWEN_THINKING || "");
// Qwen auto-extracts persistent "memories" from chats. Since this proxy owns
// memory itself and throws the chats away, we also wipe Qwen's saved memories so
// nothing lingers on their side. Set to "false" to leave Qwen's memories alone.
const QWEN_FORGET_MEMORIES = !/^(0|false|no)$/i.test(process.env.QWEN_FORGET_MEMORIES || "");

if (!QWEN_TOKEN) {
  console.warn(
    "[qwen-proxy] WARNING: QWEN_TOKEN is not set. Requests will fail.\n" +
      "  Get it from chat.qwen.ai: DevTools > Application > Local Storage > 'token'."
  );
}

// Headers matching the real web client. These are the honest, standard headers
// the browser sends (auth via Bearer token, app Version, source, timezone) — we
// do NOT compute any anti-bot signature. The "Version" header in particular is
// required by the completions endpoint.
function qwenHeaders(extra = {}) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${QWEN_TOKEN}`,
    Origin: QWEN_BASE,
    Referer: `${QWEN_BASE}/`,
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "X-Request-Id": randomUUID(),
    Version: QWEN_CLIENT_VERSION,
    source: "web",
    Timezone: new Date().toString().replace(/\s*\(.+\)$/, ""),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Qwen API helpers
// ---------------------------------------------------------------------------

// Detects Qwen's "Access Verification" / CAPTCHA response so we can surface a
// clear error instead of hanging or pretending it worked.
function looksLikeChallenge(status, bodyText) {
  if (status === 403 || status === 401) return true;
  if (!bodyText) return false;
  return /access verification|verify that you are|captcha|risk|please complete the operation/i.test(
    bodyText
  );
}

// Create a fresh Qwen chat and return its id.
async function createChat() {
  const res = await fetch(`${QWEN_BASE}/api/v2/chats/new`, {
    method: "POST",
    headers: qwenHeaders(),
    body: JSON.stringify({
      title: "New Chat",
      models: [ALLOWED_MODEL],
      chat_mode: "normal",
      chat_type: "t2t",
      timestamp: Date.now(),
    }),
  });
  const text = await res.text();
  if (looksLikeChallenge(res.status, text)) {
    const err = new Error(
      "Qwen anti-bot challenge triggered while creating a chat. Open chat.qwen.ai " +
        "in your browser, complete the verification, then refresh QWEN_TOKEN."
    );
    err.challenge = true;
    throw err;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Unexpected /chats/new response (${res.status}): ${text.slice(0, 300)}`);
  }
  const id = json?.data?.id || json?.id || json?.data?.chat?.id;
  if (!id) throw new Error(`Could not find chat id in response: ${text.slice(0, 300)}`);
  return id;
}

// Best-effort delete of a throwaway chat (DELETE /api/v2/chats/{id}). Never throws
// — cleanup failures shouldn't fail the user's request.
async function deleteChat(chatId) {
  if (!chatId) return;
  try {
    await fetch(`${QWEN_BASE}/api/v2/chats/${encodeURIComponent(chatId)}`, {
      method: "DELETE",
      headers: qwenHeaders(),
    });
  } catch (e) {
    console.warn(`[qwen-proxy] could not delete temp chat ${chatId}: ${e.message}`);
  }
}

// Best-effort wipe of Qwen's server-side saved memories (forget_all). Never
// throws. No-op when QWEN_FORGET_MEMORIES is disabled.
async function forgetAllMemories() {
  if (!QWEN_FORGET_MEMORIES) return;
  try {
    await fetch(`${QWEN_BASE}/api/v2/memories/delete`, {
      method: "POST",
      headers: qwenHeaders(),
      body: JSON.stringify({ forget_all: true }),
    });
  } catch (e) {
    console.warn(`[qwen-proxy] could not clear Qwen memories: ${e.message}`);
  }
}

// Normalize an OpenAI role to what we store.
function normalizeRole(role) {
  return role === "assistant" ? "assistant" : role === "system" ? "system" : "user";
}

// Extract plain text from an OpenAI message's content (string or parts array).
// Image parts contribute no text.
function messageText(m) {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content))
    return m.content.map((p) => (typeof p === "string" ? p : p.text || "")).join("");
  return String(m.content ?? "");
}

// Pull image_url parts out of an OpenAI message's content array. Returns the raw
// url strings (data: or http(s)).
function imageUrlsIn(m) {
  if (!Array.isArray(m.content)) return [];
  const urls = [];
  for (const part of m.content) {
    if (part && part.type === "image_url") {
      const u = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (u) urls.push(u);
    }
  }
  return urls;
}

// Qwen's completions endpoint keeps conversation state server-side and expects
// exactly ONE message per call (more than one -> "too many messages"). OpenAI
// clients, however, resend the full history every turn. So we collapse the whole
// OpenAI conversation into a single Qwen user message: system prompts first, then
// a labeled transcript of the prior turns, ending with the latest user turn.
// `files` are image attachments for this turn (see uploadImage).
function buildQwenMessages(openaiMessages, files = []) {
  const now = Math.floor(Date.now() / 1000);

  const systemParts = [];
  const turns = [];
  for (const m of openaiMessages) {
    const text = messageText(m);
    if (!text) continue;
    if (m.role === "system") systemParts.push(text);
    else turns.push({ role: m.role === "assistant" ? "assistant" : "user", text });
  }

  let content;
  if (systemParts.length === 0 && turns.length <= 1) {
    // Single-shot: send the user's text verbatim (cleanest prompt).
    content = turns[0]?.text ?? "";
  } else {
    const lines = [];
    if (systemParts.length) lines.push(systemParts.join("\n\n"), "");
    for (const t of turns) {
      lines.push(`${t.role === "assistant" ? "Assistant" : "User"}: ${t.text}`);
    }
    // Cue the model to produce the next assistant turn.
    lines.push("Assistant:");
    content = lines.join("\n");
  }

  // Exactly one message, mirroring the web client's createUserMessage shape.
  // thinking_enabled MUST be true — the model rejects false with "invalid_input".
  return [
    {
      id: null,
      fid: randomUUID(),
      parentId: null,
      childrenIds: [],
      role: "user",
      content,
      user_action: "chat",
      files,
      timestamp: now,
      models: [ALLOWED_MODEL],
      model: "",
      chat_type: "t2t",
      feature_config: { thinking_enabled: true, output_schema: "phase", research_mode: "normal" },
      extra: {},
      sub_chat_type: "t2t",
      parent_id: null,
    },
  ];
}

// Open the streaming completion against Qwen. Returns the raw fetch Response.
async function openQwenStream(chatId, qwenMessages) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    stream: true,
    version: "2.1",
    incremental_output: true,
    chat_id: chatId,
    chat_mode: "normal",
    model: ALLOWED_MODEL,
    parent_id: null,
    messages: qwenMessages,
    timestamp: now,
  };
  const res = await fetch(
    `${QWEN_BASE}/api/v2/chat/completions?chat_id=${encodeURIComponent(chatId)}`,
    {
      method: "POST",
      headers: qwenHeaders({ Accept: "text/event-stream" }),
      body: JSON.stringify(payload),
    }
  );
  const ct = res.headers.get("content-type") || "";
  // Qwen returns HTTP 200 even for errors — the failure shows up as a JSON body
  // (content-type application/json) instead of an event-stream. Detect that so we
  // don't silently return an empty completion.
  if (!res.ok || !res.body || !ct.includes("event-stream")) {
    const text = await res.text().catch(() => "");
    if (looksLikeChallenge(res.status, text)) {
      const err = new Error(
        "Qwen anti-bot challenge triggered on completion. Complete verification at " +
          "chat.qwen.ai in your browser and refresh QWEN_TOKEN."
      );
      err.challenge = true;
      throw err;
    }
    // Surface Qwen's own error detail when present.
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      detail = j?.data?.details || j?.error?.details || j?.data?.code || detail;
    } catch {}
    throw new Error(`Qwen completion failed (${res.status}): ${detail}`);
  }
  return res;
}

// Parse Qwen's SSE stream. Calls onDelta(text) for each new chunk of the final
// answer (phase === "answer"). Skips "think" phase unless QWEN_THINKING is on.
async function consumeQwenSSE(res, onDelta) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line || !line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      let evt;
      try {
        evt = JSON.parse(data);
      } catch {
        continue;
      }
      // In-stream error event, e.g. {"error":{"code":"invalid_input",...}}.
      if (evt?.error) {
        throw new Error(
          `Qwen stream error: ${evt.error.details || evt.error.code || "unknown"}`
        );
      }
      // Ignore control events like {"response.created": {...}}.
      const delta = evt?.choices?.[0]?.delta;
      if (!delta) continue;
      const phase = delta.phase;
      const piece = delta.content;
      if (typeof piece !== "string" || piece.length === 0) continue;
      if (phase === "think" && !QWEN_THINKING) continue;
      onDelta(piece, phase);
    }
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible HTTP layer
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function sendError(res, status, message, type = "invalid_request_error") {
  sendJson(res, status, { error: { message, type } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function modelsPayload() {
  return {
    object: "list",
    data: [
      {
        id: ALLOWED_MODEL,
        object: "model",
        created: 0,
        owned_by: "qwen",
      },
    ],
  };
}

// Which conversation does this request belong to? Header wins, then body fields,
// then a shared default so simple callers need nothing.
function conversationIdFor(req, body) {
  return (
    req.headers["x-conversation-id"] ||
    body.conversation_id ||
    body.user ||
    "default"
  );
}

// Merge the incoming request into stored history and return the full history to
// prompt with. The proxy is authoritative: if we've never seen this conversation
// we seed it from everything the client sent; otherwise we only take the client's
// newest message (avoids duplicating history the model already remembers).
function buildEffectiveHistory(conversationId, incoming) {
  const history = getHistory(conversationId);
  if (history.length === 0) {
    for (const m of incoming) {
      const content = messageText(m);
      if (content) history.push({ role: normalizeRole(m.role), content });
    }
  } else {
    const last = incoming[incoming.length - 1];
    const content = messageText(last);
    if (content) history.push({ role: normalizeRole(last.role), content });
  }
  return history;
}

async function handleChatCompletions(req, res) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return sendError(res, 400, "Request body must be valid JSON.");
  }

  // Enforce that ONLY the allowed model can be used through this proxy.
  if (body.model && body.model !== ALLOWED_MODEL) {
    return sendError(
      res,
      404,
      `Model '${body.model}' is not available. This proxy only serves '${ALLOWED_MODEL}'.`,
      "model_not_found"
    );
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) {
    return sendError(res, 400, "'messages' must be a non-empty array.");
  }
  const wantStream = body.stream === true;

  const conversationId = conversationIdFor(req, body);
  const history = buildEffectiveHistory(conversationId, messages);

  // Vision: upload any images attached to the latest user turn. They apply only
  // to this turn (the throwaway chat is deleted afterwards).
  let files = [];
  try {
    const imageUrls = imageUrlsIn(messages[messages.length - 1]);
    for (const u of imageUrls) {
      const { bytes, mime } = await fetchImageBytes(u);
      files.push(await uploadImage(qwenHeaders, QWEN_BASE, bytes, mime));
    }
  } catch (e) {
    return sendError(res, 400, `Image upload failed: ${e.message}`, "invalid_request_error");
  }

  let chatId, qwenRes;
  try {
    chatId = await createChat();
    qwenRes = await openQwenStream(chatId, buildQwenMessages(history, files));
  } catch (e) {
    // Failed before/at stream open: clean up the temp chat, don't persist.
    await deleteChat(chatId);
    const status = e.challenge ? 503 : 502;
    return sendError(
      res,
      status,
      e.message || String(e),
      e.challenge ? "upstream_challenge" : "upstream_error"
    );
  }

  const id = "chatcmpl-" + randomUUID();
  const created = Math.floor(Date.now() / 1000);

  // Persist the assistant reply and delete the throwaway chat. Called once the
  // full answer is known. `history` already includes the user's new turn.
  const finalize = async (assistantContent) => {
    if (assistantContent) {
      history.push({ role: "assistant", content: assistantContent });
      try {
        saveHistory(conversationId, history);
      } catch (e) {
        console.warn(`[qwen-proxy] failed to save memory: ${e.message}`);
      }
    }
    // Throw away the temp chat and wipe any memory Qwen auto-saved from it.
    await Promise.all([deleteChat(chatId), forgetAllMemories()]);
  };

  if (wantStream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    // First chunk announces the role, per OpenAI streaming convention.
    const first = {
      id,
      object: "chat.completion.chunk",
      created,
      model: ALLOWED_MODEL,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(first)}\n\n`);

    let content = "";
    try {
      await consumeQwenSSE(qwenRes, (piece) => {
        content += piece;
        const chunk = {
          id,
          object: "chat.completion.chunk",
          created,
          model: ALLOWED_MODEL,
          choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      });
    } catch (e) {
      // Stream already started; emit the error as a final content note.
      res.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model: ALLOWED_MODEL,
          choices: [{ index: 0, delta: { content: `\n[proxy error: ${e.message}]` }, finish_reason: null }],
        })}\n\n`
      );
    }

    await finalize(content);

    const done = {
      id,
      object: "chat.completion.chunk",
      created,
      model: ALLOWED_MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
    res.write(`data: ${JSON.stringify(done)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  // Non-streaming: accumulate the whole answer, then return one JSON object.
  let content = "";
  try {
    await consumeQwenSSE(qwenRes, (piece) => {
      content += piece;
    });
  } catch (e) {
    await deleteChat(chatId); // clean up; don't persist a failed turn
    const status = e.challenge ? 503 : 502;
    return sendError(res, status, e.message, e.challenge ? "upstream_challenge" : "upstream_error");
  }

  await finalize(content);

  sendJson(res, 200, {
    id,
    object: "chat.completion",
    created,
    model: ALLOWED_MODEL,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

// Clear one conversation's stored memory (and Qwen's server-side memories).
async function handleClearConversation(res, conversationId) {
  const existed = clearConversation(conversationId);
  await forgetAllMemories();
  return sendJson(res, 200, { ok: true, conversation_id: conversationId, cleared: existed });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Conversation-Id",
    });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true, model: ALLOWED_MODEL, tokenSet: Boolean(QWEN_TOKEN) });
    }
    if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      return sendJson(res, 200, modelsPayload());
    }
    if (
      req.method === "POST" &&
      (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")
    ) {
      return await handleChatCompletions(req, res);
    }
    // Conversation memory reset: DELETE /v1/conversations/{id}
    //                        or  POST   /v1/conversations/{id}/reset
    const convMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+?)(?:\/reset)?$/);
    if (convMatch && (req.method === "DELETE" || req.method === "POST")) {
      return await handleClearConversation(res, decodeURIComponent(convMatch[1]));
    }
    return sendError(res, 404, `No route for ${req.method} ${url.pathname}`, "not_found");
  } catch (e) {
    console.error("[qwen-proxy] Unhandled error:", e);
    if (!res.headersSent) sendError(res, 500, e.message || "Internal error", "server_error");
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`[qwen-proxy] OpenAI-compatible proxy listening on http://localhost:${PORT}`);
  console.log(`[qwen-proxy] Model exposed: ${ALLOWED_MODEL}`);
  console.log(`[qwen-proxy] Token set: ${Boolean(QWEN_TOKEN)}  Thinking: ${QWEN_THINKING}`);
  console.log(`[qwen-proxy] Memory file: ${MEMORY_FILE}`);
  console.log(`[qwen-proxy] Wipe Qwen memories each turn: ${QWEN_FORGET_MEMORIES}`);
});
