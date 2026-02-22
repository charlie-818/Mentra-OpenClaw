# Comprehensive Prompt: Design OpenClaw Computer for Mentra Glasses

**Use this prompt with Claude** (on the OpenClaw machine or in a design session) to design and verify the structures so that the OpenClaw computer gateway successfully receives prompts from Mentra glasses (via the Mentra+OpenClaw bridge) and successfully streams output back to the glasses.

---

## Copy-paste prompt for Claude

```
You are helping design and configure the **OpenClaw computer** so that Mentra glasses (Even G1) can send voice prompts to OpenClaw and receive streaming text responses. The flow is:

  **Mentra glasses** → (voice) → **MentraOS Cloud** → (webhook) → **Bridge** (Mentra+OpenClaw app) → (HTTP) → **OpenClaw Gateway** (this machine) → (SSE stream) → **Bridge** → (display) → **Glasses**

The bridge is a separate app that runs elsewhere (or on this machine). It speaks to OpenClaw over HTTP. Your job is to make this OpenClaw host correctly implement the **gateway API** that the bridge expects, and to document the setup so prompts from the glasses are received and output is successfully provided.

---

### 1. Gateway API contract (what the bridge sends and expects)

**Endpoint:** `POST {baseUrl}/v1/responses`  
- Base URL is typically `http://<this-host>:18789` (bridge uses `OPENCLAW_GATEWAY_URL`).
- The bridge may run on the same machine (localhost) or a remote machine; if remote, this host must be reachable on port 18789.

**Request:**
- **Headers:**  
  - `Authorization: Bearer <gateway_token>` (required)  
  - `Content-Type: application/json`  
  - Optional: `x-openclaw-agent-id: <agent_id>` (default `main`)
- **Body (JSON):**
  - `model`: `"openclaw"`
  - `stream`: `true` (bridge always streams)
  - `input`: array of messages. Each message: `{ "type": "message", "role": "user"|"assistant"|"system", "content": [ { "type": "text", "text": "<string>" } ] }`
  - Optional: `user`: string (e.g. Mentra user id)

**Response (when stream: true):**
- HTTP status 200.
- Body: **Server-Sent Events (SSE)** with `Content-Type: text/event-stream`.
- The bridge parses these event types:
  - **`response.output_text.delta`** — data is JSON with a `delta` string (piece of assistant text). Send these as the model streams.
  - **`response.output_text.done`** — no more text deltas for this turn.
  - **`response.completed`** — request completed successfully.
  - **`response.failed`** — request failed; data can describe the error.

**Non-streaming (for sanity checks):** The bridge’s test script may send `stream: false`. In that case the response can be a single JSON object with the full assistant reply; the bridge’s main flow uses streaming only.

**Auth:** If the token is wrong or missing, return **401 Unauthorized** so the bridge can report "invalid token" instead of connection errors.

---

### 2. OpenClaw computer: what must be running and how it must be configured

- **Gateway process** that:
  - Listens for HTTP on **port 18789** (or the port you document).
  - Binds to **0.0.0.0** (or equivalent “all interfaces”) if the bridge runs on another machine; if the bridge runs only on this host, 127.0.0.1 is enough.
  - Exposes the **Responses API** at `POST /v1/responses` as above.
  - Uses a **gateway token** (or password) from config; the same token must be set in the bridge’s `OPENCLAW_GATEWAY_TOKEN`.

- **Config:** Enable the HTTP Responses API in the OpenClaw gateway config (e.g. `gateway.http.responses.enabled: true` or equivalent). Document where this config lives (file path or env) and the exact key names.

- **Firewall:** If the bridge is on another host, **allow inbound TCP on port 18789** from the bridge’s IP (or 0.0.0/0 for testing). List what you use (ufw, firewalld, iptables, cloud security group) and the exact rule or change.

- **Reachability:** Document this host’s IP that the bridge should use:
  - Same machine: `OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789`
  - Same LAN or Tailscale: `OPENCLAW_GATEWAY_URL=http://<this-machine-ip>:18789`

---

### 3. End-to-end flow (for verification)

1. **Glasses** — User opens the Mentra app and speaks.
2. **MentraOS** — Sends final transcription to the bridge via webhook.
3. **Bridge** — POSTs to this OpenClaw gateway at `POST /v1/responses` with the transcript as a user message, `stream: true`.
4. **OpenClaw gateway (this machine)** — Authenticates, runs the model (or forwards to the model service), and streams SSE events: `response.output_text.delta` (with `delta` text), then `response.output_text.done`, then `response.completed` (or `response.failed` on error).
5. **Bridge** — Accumulates deltas, throttles display updates, and sends text to the glasses via MentraOS.
6. **Glasses** — User sees the streamed reply.

Failure points to check on the OpenClaw computer: gateway not listening, bound to localhost only, Responses API disabled, wrong port, firewall blocking, or wrong/missing token (401).

---

### 4. Deliverables

Produce the following:

**A. Gateway design / config summary**
- Where is the gateway config (file or env)?
- Exact setting(s) to enable the HTTP Responses API and the port (18789 or other).
- How the gateway token is set and validated.

**B. Request/response structures**
- Short spec: URL, method, headers, request JSON shape, and the SSE event names and payload shapes the bridge expects (as in section 1 above). If your OpenClaw stack uses different event names, either adapt the gateway to emit the names above or document the mapping for the bridge.

**C. “Report for bridge operator”**
A block the bridge operator can copy:
- `OPENCLAW_GATEWAY_URL=http://<ip>:<port>` (use the IP the bridge will use).
- `OPENCLAW_GATEWAY_TOKEN=<actual token from config>` (or note “from file X”).
- One-line test command they can run from the bridge machine to verify connectivity and auth (e.g. curl or a one-liner with the token).
- Short troubleshooting: if “connection refused” → binding/firewall; if “timed out” → network/firewall; if “401” → token.

**D. Checklist: OpenClaw computer ready for Mentra glasses**
- [ ] Gateway listening on the chosen port (e.g. 0.0.0.0:18789 if bridge is remote).
- [ ] HTTP Responses API enabled; `POST /v1/responses` accepts the request format above.
- [ ] SSE response sends at least: `response.output_text.delta` (with `delta`), `response.output_text.done`, `response.completed` (or `response.failed`).
- [ ] Auth: invalid/missing token returns 401.
- [ ] If bridge is remote: firewall allows inbound TCP on the gateway port; “Report for bridge operator” uses the reachable IP.
- [ ] Local sanity check: from this host, `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:18789/ -H "Authorization: Bearer <token>"` returns 200 (or equivalent for your root path).

**E. Optional: same-machine setup**
- If the bridge (Mentra+OpenClaw app) will run on this same computer, note that the bridge can use `OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789` and no remote firewall is needed; the gateway can bind to 127.0.0.1 for that case.

---

### 5. References (for context)

- The bridge expects **HTTP** (not WebSocket) for the Responses API: `http://...` in `OPENCLAW_GATEWAY_URL`.
- The bridge sends one user message per final transcription from the glasses and displays streamed text on the glasses (throttled to ~4 updates per second).
- A minimal connectivity test from the bridge is: POST to `{OPENCLAW_GATEWAY_URL}/v1/responses` with `stream: false`, body `{ "model": "openclaw", "stream": false, "input": [ { "type": "message", "role": "user", "content": [ { "type": "text", "text": "Hi" } ] } ] }`, and `Authorization: Bearer <token>`. Success: 200 and valid response; 401: wrong token.
```

---

## How to use this prompt

1. **On the OpenClaw computer:** Open your OpenClaw project (or the machine where the gateway runs) and paste the **entire prompt above** (from "You are helping design..." through "...wrong token.") into Claude. Claude will produce the gateway design, config summary, report for the bridge operator, and checklist.

2. **Apply the checklist** on the OpenClaw host (binding, firewall, config, token).

3. **On the bridge side:** Use the "Report for bridge operator" to set `OPENCLAW_GATEWAY_URL` and `OPENCLAW_GATEWAY_TOKEN` in `.env`, then run `npm run test:openclaw` from the Mentra+OpenClaw repo. If it passes, run the bridge, expose it (e.g. ngrok), set the MentraOS webhook, and test on the glasses.

4. **If the bridge fails:** Use the two-sided test in [TWO_SIDED_TEST.md](TWO_SIDED_TEST.md): run Prompt A on the OpenClaw machine and Prompt B on the bridge machine, and exchange reports until connectivity and auth succeed.

---

## Quick reference: bridge ↔ OpenClaw contract

| Item | Value |
|------|--------|
| Protocol | HTTP (not WebSocket for this bridge) |
| URL | `{OPENCLAW_GATEWAY_URL}/v1/responses` (e.g. `http://host:18789/v1/responses`) |
| Method | POST |
| Auth | `Authorization: Bearer <OPENCLAW_GATEWAY_TOKEN>` |
| Request body | `{ "model": "openclaw", "stream": true, "input": [ { "type": "message", "role": "user", "content": [ { "type": "text", "text": "<user message>" } ] } ], "user": "<optional>" }` |
| Response (stream) | SSE: `response.output_text.delta` (data: `{ "delta": "<text>" }`), `response.output_text.done`, `response.completed`, or `response.failed` |
| 401 | Invalid or missing token |

This document lives in the Mentra+OpenClaw repo; the prompt is intended for use with Claude on the OpenClaw computer or in a design session to implement or verify the gateway side.
