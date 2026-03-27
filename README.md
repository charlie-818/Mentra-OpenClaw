<!-- 
  Mentra OpenClaw Bridge
  
  A bridge service that connects Even G1 smart glasses (MentraOS) with OpenClaw AI gateway.
  Enables voice-controlled AI interaction through the glasses with features like copilot mode,
  head gesture controls, and real-time streaming responses. The bridge handles webhook events
  from MentraOS, processes voice transcripts, sends them to OpenClaw, and streams AI responses
  back to the glasses display.
-->

# Mentra OpenClaw Bridge

Connects **Even G1 glasses** (running MentraOS) to your **OpenClaw** gateway: speak into the glasses to send prompts to OpenClaw, and stream OpenClaw’s responses back as text on the glasses.

**Quick start:** Clone the repo, `npm install`, `cp .env.example .env`, then set `PACKAGE_NAME`, `MENTRAOS_API_KEY`, `OPENCLAW_GATEWAY_URL`, and `OPENCLAW_GATEWAY_TOKEN` in `.env`. Register your app in [MentraOS](https://console.mentra.glass) with the webhook URL pointing at this bridge (e.g. `https://your-host/webhook`). Run `npm run dev`. See [Setup](#setup) and [DEVELOPMENT.md](DEVELOPMENT.md) for details.

## Features

- **Voice → OpenClaw → display** — Speak into the glasses; prompts are sent to OpenClaw and streaming responses appear on the display.
- **Head gestures** — Look **up** to start recording your prompt; look **down** to send (or to clear and return to welcome). Trigger words (e.g. "send", "mac") also send.
- **Copilot mode** — Say "copilot mode" or "copilot on/off" to toggle. In copilot mode, transcripts are batched (3s debounce) and optionally filtered by a cheap LLM (e.g. Haiku) before being sent to OpenClaw; the AI can reply with `NO_REPLY` to stay silent.
- **Transcript logging** — All transcripts (normal and copilot) are appended to `transcripts/YYYY-MM-DD.md`.
- **Push API** — Same port as the webhook: `POST /push`, `GET /status`, `GET /debug`, `POST /mic`, `POST /copilot`, `GET /copilot`. Optional `PUSH_TOKEN` for auth.

**[HexMentraBridge](https://github.com/johannboehme/HexMentraBridge)** is an alternative that uses OpenClaw’s Gateway WebSocket and a separate push port; this repo uses the HTTP Responses API and a single port. To run HexMentraBridge with the same gateway, see [Running HexMentraBridge](#running-hexmentrabridge) below.

## Testing Mentra first (no OpenClaw)

To confirm the Mentra SDK works and you can see content on the glasses before integrating OpenClaw, follow **[DEVELOPMENT.md](DEVELOPMENT.md)**. In short: set only `MENTRAOS_API_KEY` and `PACKAGE_NAME`, expose the app with ngrok, register the webhook URL in the MentraOS console, then open the app on the glasses. You should see *"Mentra connected. You should see this on your glasses."*

---

## Prerequisites (full bridge with OpenClaw)

- **Node.js 18+** (or Bun)
- **MentraOS API key** from [console.mentra.glass](https://console.mentra.glass)
- **OpenClaw Gateway** running with the Responses API enabled

## Setup

### 1. Clone and install

```bash
cd Mentra+OpenClaw
npm install
```

### 2. Environment variables

Copy the example env and fill in your values:

```bash
cp .env.example .env
```

| Variable | Description |
|----------|-------------|
| `PORT` | Port the bridge listens on (default `3000`) |
| `PACKAGE_NAME` | App identifier, must match the one you register in MentraOS (e.g. `com.yourname.mentra-openclaw-bridge`) |
| `MENTRAOS_API_KEY` | API key from [console.mentra.glass](https://console.mentra.glass) |
| `OPENCLAW_GATEWAY_URL` | OpenClaw gateway base URL (e.g. `http://127.0.0.1:18789`) |
| `OPENCLAW_GATEWAY_TOKEN` | Bearer token for the gateway |
| `OPENCLAW_AGENT_ID` | Optional; agent id (default `main`) |
| `OPENCLAW_TRIGGER_WORDS` | Optional; comma-separated trigger phrases to send the transcript to OpenClaw (e.g. `go,send,execute,big mac`). |
| `OPENCLAW_CLEAR_WORDS` | Optional; comma-separated phrases to clear or cancel (e.g. `clear,stop,reset,cancel`). |
| `PUSH_TOKEN` | Optional; if set, Push API endpoints require `Authorization: Bearer <token>` or `?token=<token>`. |
| `FILTER_LLM_URL`, `FILTER_LLM_API_KEY`, `FILTER_LLM_MODEL` | Optional; for copilot pre-filter (e.g. OpenAI-compatible chat endpoint and `haiku`). |
| `NOTIF_BLOCKLIST` | Optional; comma-separated app names to suppress (for future notification handling). |

### 3. MentraOS (glasses) side

1. Get your **API key** from [console.mentra.glass](https://console.mentra.glass).
2. **Register your app** with MentraOS Cloud and set the **webhook URL** to the public URL of this bridge (e.g. `https://your-server.com/webhook`). The bridge serves the webhook on the same port as the app (default 3000).
3. For local development, expose the bridge with a tunnel (e.g. [ngrok](https://ngrok.com)) so MentraOS Cloud can reach it:
   ```bash
   ngrok http 3000
   ```
   Use the generated `https://...` URL as the app’s webhook URL in the MentraOS console.

### 4. OpenClaw Gateway

1. Enable the Responses HTTP endpoint in your gateway config:
   ```json5
   {
     gateway: {
       http: {
         endpoints: {
           responses: { enabled: true },
         },
       },
     },
   }
   ```
2. Ensure you have a valid **gateway token** (or password) and set `OPENCLAW_GATEWAY_URL` and `OPENCLAW_GATEWAY_TOKEN` in `.env`.

### 5. Security

Do not commit `.env` or any real API keys or tokens. Use environment variables only; see [SECURITY.md](SECURITY.md).

## Run

- **Development** (watch mode):
  ```bash
  npm run dev
  ```
- **Production**:
  ```bash
  npm run build
  npm start
  ```

The bridge listens on `PORT` and exposes:

- **Webhook** (for MentraOS Cloud): path used when registering the app (e.g. `/webhook`).
- **Health**: `GET /health` returns 200 for MentraOS heartbeat checks.
- **Push API** (same port): `POST /push` (body: `{ "text": "...", "duration": 10000 }`), `POST /push-bitmap` (stub), `POST /mic` (toggle listening), `POST /copilot`, `GET /copilot`, `GET /status`, `GET /debug`. If `PUSH_TOKEN` is set, use `Authorization: Bearer <token>` or `?token=<token>`.
- **Preview API & page**:
  - `POST /preview/prompt` — starts a preview run for a given `prompt` using the same OpenClaw pipeline as the glasses.
  - `GET /preview/state` — returns the latest preview state (status, content, error).
  - `GET /preview` — simple test webpage that lets you send prompts and see what would be rendered on the glasses.

## Testing

- **Unit + integration tests** (Vitest):
  ```bash
  npm test
  ```
- **Unit tests only**:
  ```bash
  npm run test:unit
  ```
- **HTTP + preview integration tests**:
  ```bash
  npm run test:integration
  ```
- **CI mode with coverage**:
  ```bash
  npm run test:ci
  ```
- **Preview browser tests (Playwright)**:
  ```bash
  npm run test:preview
  ```

OpenClaw-dependent paths use a synthetic **test mode** when `OPENCLAW_TEST_MODE=1`, so the tests and preview endpoints can run without a live gateway.

Existing scripts are still available:

- `npm run check` — project health check (lint/format/etc).
- `npm run test:openclaw` — smoke test against a real OpenClaw gateway (requires `OPENCLAW_GATEWAY_URL` and `OPENCLAW_GATEWAY_TOKEN`).
- `npm run test:full` — runs checks and the OpenClaw smoke test (skipping gateway tests if not configured).

### Preview webpage

To quickly see what would be shown on the Even G1 display for a given prompt:

1. Start the dev server:
   ```bash
   npm run dev
   ```
2. Visit `http://localhost:3000/preview` in your browser.
3. Enter a prompt and click **Send to Preview** (or press <kbd>Cmd/Ctrl + Enter</kbd>).

In development you can optionally set:

- `OPENCLAW_TEST_MODE=1` to use a synthetic response (no real OpenClaw gateway required).

The preview (and glasses) output is formatted by a shared formatter in [`src/display-format.ts`](src/display-format.ts) which:

- Strips markdown markers and emojis.
- Preserves word boundaries (no fused or split words).
- Emits a short uppercase heading per paragraph and numbered list lines below it.

The Playwright tests for `/preview` in [`tests/playwright/preview.spec.ts`](tests/playwright/preview.spec.ts) define the expected structure; any changes made there are enforced against the same formatter used for the glasses output.

## Flow

1. User puts on Even G1 glasses and opens your app (MentraOS connects to the bridge via the cloud).
2. User **looks up** to start recording; **looks down** to send the prompt (or says a trigger word like “send”). In **copilot mode**, transcripts are batched and optionally filtered before being sent.
3. OpenClaw’s **streaming** response is shown on the glasses (throttled to ~4 updates per second).
4. If the user speaks again while a response is in progress, the glasses show “Busy. Wait for the current response.”

Transcripts are logged to `transcripts/YYYY-MM-DD.md`. Use the Push API to show reminders or status on the glasses from scripts or other services.

## Repository structure

- **`src/`** — Bridge app: [index.ts](src/index.ts) (server, webhook, sessions), [openclaw.ts](src/openclaw.ts) (OpenClaw HTTP client), [session-registry.ts](src/session-registry.ts), [push-routes.ts](src/push-routes.ts), [transcript-log.ts](src/transcript-log.ts), [copilot-filter.ts](src/copilot-filter.ts).
- **`scripts/`** — Check, tests, deploy (Railway), Cloudflare tunnel setup, HexMentraBridge launcher.
- **`docs/`** — OpenClaw and gateway debugging/setup guides; see [docs/README.md](docs/README.md) for an index.
- **Config:** `package.json`, `tsconfig.json`, [.env.example](.env.example), `railway.json`, `nixpacks.toml`.

## Deployment

- **Deploying the bridge:** The repo includes [railway.json](railway.json) and [nixpacks.toml](nixpacks.toml) for [Railway](https://railway.app). Production environment variables are set in Railway (dashboard or `railway variables set`), not from repo `.env`. For a one-shot deploy from this repo, see [scripts/deploy-railway.sh](scripts/deploy-railway.sh) (requires Railway CLI and the required env vars).
- **Exposing OpenClaw:** If the bridge runs remotely (e.g. on Railway) and OpenClaw is on your machine, expose it with a tunnel. [scripts/setup-cloudflare-tunnel.sh](scripts/setup-cloudflare-tunnel.sh) sets up a Cloudflare Tunnel and prints the URL to use as `OPENCLAW_GATEWAY_URL`.

### Railway + tests

With the [Railway CLI](https://railway.app/docs/cli) installed and the project linked:

- Run the full test suite inside Railway (using the app's production-like environment):
  ```bash
  railway run npm run test:ci
  ```
- Trigger a deploy with tests enforced:
  ```bash
  # Required env vars (see scripts/deploy-railway.sh header)
  OPENCLAW_GATEWAY_URL=... \
  OPENCLAW_GATEWAY_TOKEN=... \
  MENTRAOS_API_KEY=... \
  PACKAGE_NAME=... \
  bash scripts/deploy-railway.sh
  ```

The deploy script will:

- Ensure the Railway CLI is installed and authenticated.
- Link/init the project and push environment variables.
- Run `railway run npm run test:ci` and **abort the deploy if tests fail**.
- Call `railway up --detach` to trigger the deployment.

To skip the test run for a one-off deploy (not recommended), set:

```bash
SKIP_TESTS=1 bash scripts/deploy-railway.sh
```

## Running HexMentraBridge

To use the full-featured bridge (copilot, push API, transcripts) with the same OpenClaw gateway and MentraOS app:

1. Clone [HexMentraBridge](https://github.com/johannboehme/HexMentraBridge) next to this repo (e.g. `../HexMentraBridge`) or into this repo as `hex-bridge`.
2. From this repo, run:
   ```bash
   ./scripts/run-hex-bridge.sh
   ```
   The script reads `.env` from this repo, derives `OPENCLAW_WS_URL` from `OPENCLAW_GATEWAY_URL`, and starts HexMentraBridge with Bun. If you cloned HexMentraBridge elsewhere, set `HEX_BRIDGE_DIR` to that path.

## License

[LICENSE](LICENSE) (MIT)
