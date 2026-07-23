// Interactive terminal chat for the Qwen proxy.
//
// Starts the proxy server in-process (by importing ./server.js) and then opens a
// streaming REPL against it. Everything runs through the OpenAI-compatible layer,
// locked to qwen3.8-max-preview.
//
// Usage:
//   node --env-file=.env chat.js
//   (or)  QWEN_TOKEN=xxxxx node chat.js
//
// Commands inside the chat:
//   /reset   clear the conversation history
//   /exit    quit (Ctrl+C also works)

import readline from "node:readline";
import { randomUUID } from "node:crypto";

// Importing the server starts it listening (it calls server.listen at module load).
import "./server.js";

const PORT = Number(process.env.PORT || 8787);
const BASE = `http://localhost:${PORT}`;
const MODEL = "qwen3.8-max-preview";

// Wait until the freshly-started server answers /health.
async function waitForServer(timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return await r.json();
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 150));
  }
  throw new Error(`Proxy did not become ready on ${BASE} within ${timeoutMs}ms`);
}

// The proxy remembers the conversation server-side, keyed by this id, so we only
// send the newest user message each turn (not the whole history).
let conversationId = randomUUID();

// Stream one assistant turn, printing tokens as they arrive. Returns full text.
async function streamReply(userText) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Conversation-Id": conversationId },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: userText }],
      stream: true,
    }),
  });

  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      msg = j?.error?.message || msg;
    } catch {}
    throw new Error(msg);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return full;
      try {
        const evt = JSON.parse(data);
        const piece = evt?.choices?.[0]?.delta?.content;
        if (typeof piece === "string" && piece.length) {
          process.stdout.write(piece);
          full += piece;
        }
      } catch {
        /* ignore keep-alive / partial */
      }
    }
  }
  return full;
}

async function main() {
  const health = await waitForServer();
  if (!health.tokenSet) {
    console.log(
      "\n⚠️  QWEN_TOKEN is not set — chats will fail. Set it and restart:" +
        "\n   node --env-file=.env chat.js\n"
    );
  }

  console.log(`\nQwen chat ready (model: ${MODEL}).`);
  console.log("Type a message. Commands: /reset  /exit\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = () => rl.question("you › ", async (input) => {
    const text = input.trim();

    if (text === "/exit" || text === "/quit") {
      rl.close();
      return;
    }
    if (text === "/reset") {
      // Clear the server-side memory, then start a fresh conversation.
      try {
        await fetch(`${BASE}/v1/conversations/${conversationId}`, { method: "DELETE" });
      } catch {
        /* best effort */
      }
      conversationId = randomUUID();
      console.log("(memory cleared)\n");
      return ask();
    }
    if (!text) return ask();

    process.stdout.write("qwen › ");
    try {
      await streamReply(text);
      process.stdout.write("\n\n");
    } catch (e) {
      process.stdout.write(`\n[error: ${e.message}]\n\n`);
    }
    ask();
  });

  rl.on("close", () => {
    console.log("\nbye.");
    process.exit(0);
  });

  ask();
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
