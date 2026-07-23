# Qwen Proxy

A small, zero-dependency **OpenAI-compatible** proxy in front of
[chat.qwen.ai](https://chat.qwen.ai). It exposes **exactly one model** —
`qwen3.8-max-preview` — and forwards requests to *your own* authenticated Qwen
session.

## What it does

| Endpoint | Behaviour |
| --- | --- |
| `GET /v1/models` | Returns only `qwen3.8-max-preview`. |
| `POST /v1/chat/completions` | Standard OpenAI chat completions, streaming or not. Supports **vision** (image inputs). Any other model id is rejected with a 404. |
| `DELETE /v1/conversations/{id}` | Clear one conversation's stored memory. |
| `POST /v1/conversations/{id}/reset` | Same as above, as a POST. |
| `GET /health` | Liveness + whether a token is configured. |

Each request runs in a **throwaway Qwen chat**: the proxy creates a chat, streams
the completion (`/api/v2/chat/completions`), translates Qwen's phase-based SSE into
OpenAI-style chunks, then **deletes the chat** and wipes any memory Qwen auto-saved
— so your chat.qwen.ai sidebar and memories stay clean.

## Conversation memory

The proxy keeps its **own** role-tagged history per conversation (in `memory.json`)
and is authoritative, so the model remembers across turns even though each Qwen
chat is thrown away. Callers don't have to resend history — just the new message —
though resending full history also works.

- **Conversation id** comes from (in order) the `X-Conversation-Id` header, a
  `conversation_id` body field, the OpenAI `user` field, or `"default"`.
- First request for a conversation seeds memory from whatever you send; later
  requests append only your newest message.
- Clear a conversation with `DELETE /v1/conversations/{id}`.

## Vision (images)

Send images with the standard OpenAI `image_url` content parts — both base64 data
URLs and `http(s)` URLs work:

```json
{
  "model": "qwen3.8-max-preview",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "What's in this image?" },
      { "type": "image_url", "image_url": { "url": "data:image/png;base64,iVBORw0..." } }
    ]
  }]
}
```

The proxy uploads the image to Qwen's storage (OSS) and attaches it to the turn.
Images apply to the turn they're sent on (the chat is ephemeral).

## Setup

1. **Node 18+** required (uses the built-in `fetch`).
2. Get your Qwen token:
   - Log in at <https://chat.qwen.ai>
   - DevTools → **Application → Local Storage → https://chat.qwen.ai**
   - Copy the value of the **`token`** key.
3. Configure and run:

   ```bash
   cp .env.example .env      # then paste your token into QWEN_TOKEN
   node --env-file=.env server.js
   # or: QWEN_TOKEN=xxxxx node server.js
   ```

   You should see:
   ```
   [qwen-proxy] OpenAI-compatible proxy listening on http://localhost:8787
   [qwen-proxy] Model exposed: qwen3.8-max-preview
   ```

## Usage

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.8-max-preview",
    "messages": [{"role": "user", "content": "Say hi in one word"}]
  }'
```

Point any OpenAI SDK at it:

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8787/v1", api_key="unused")
r = client.chat.completions.create(
    model="qwen3.8-max-preview",
    messages=[{"role": "user", "content": "Hello"}],
)
print(r.choices[0].message.content)
```

Streaming works too (`stream: true`).

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `QWEN_TOKEN` | — | **Required.** Bearer token from localStorage. |
| `PORT` | `8787` | Port to listen on. |
| `QWEN_THINKING` | `false` | Include the model's chain-of-thought in the output (see below). |
| `QWEN_CLIENT_VERSION` | `0.2.74` | The `Version` header value (see "If it breaks"). |
| `MEMORY_FILE` | `./memory.json` | Where conversation memory is stored. |
| `QWEN_FORGET_MEMORIES` | `true` | Wipe Qwen's auto-saved memories after each turn. |
| `QWEN_DEVICE_ID` | random | Only needed if requests fail; from `localStorage["qwen_chat_device_id"]`. |

## Two things that make this actually work

These were reverse-engineered from the chat.qwen.ai web client and are handled
for you — documented here so you understand the moving parts:

1. **The `Version` request header is required.** Without it (`Version: 0.2.74`,
   the frontend app version), the completions endpoint returns a generic
   `Internal error` with HTTP 200. The proxy always sends it.
2. **`qwen3.8-max-preview` requires thinking to be enabled.** Sending
   `thinking_enabled: false` is rejected with `invalid_input`. The proxy always
   requests thinking, and then — unless `QWEN_THINKING=true` — filters the
   reasoning (`phase: "think"`) out of the response so you get a clean answer.

## Thinking / reasoning output

- `QWEN_THINKING=false` (default): the response contains only the final answer.
- `QWEN_THINKING=true`: the response also contains the model's reasoning, inline
  before the answer.

## If it breaks

- **`Qwen completion failed: unauthorized` / session expired** — your token
  rolled over. Grab a fresh `token` from localStorage and update `.env`.
- **`Internal error` after a Qwen site update** — they likely bumped the frontend
  version. Open DevTools → Network on chat.qwen.ai, copy the `Version` request
  header value, and set `QWEN_CLIENT_VERSION` to it.
- Errors are surfaced clearly (HTTP 502/503 with Qwen's own detail) rather than
  returning an empty completion.

## Notes

- The token is your personal session credential — keep `.env` out of version
  control (`.gitignore` already excludes it).
- This is for personal use with your own account. Respect Qwen's Terms of Service.
