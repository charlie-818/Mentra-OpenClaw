# Mentra OpenClaw Bridge

Connects **Even G1 glasses** (running MentraOS) to your **OpenClaw** gateway: speak into the glasses to send prompts to OpenClaw, and stream OpenClaw’s responses back as text on the glasses.

## Two ways to connect G1 to OpenClaw

- **This repo (minimal bridge)** — Voice to OpenClaw, streaming text on glasses. Uses OpenClaw **HTTP Responses API** (`/v1/responses`). One port (3000). Easiest setup when you only need direct voice chat.
- **[HexMentraBridge](https://github.com/johannboehme/HexMentraBridge)** — Full-featured bridge: same voice flow plus **copilot mode**, **push API** (reminders, bitmaps), **transcript logging**, **LLM pre-filter**, head-up mic toggle, etc. Uses OpenClaw **Gateway WebSocket**. Ports 3000 + 3001.

**When to use which:** Use this repo for the simplest setup (HTTP only). Use HexMentraBridge when you want copilot, push, transcripts, or Tasker/WearOS integration.

**Gateway:** The same OpenClaw instance can serve both. This repo needs `responses: { enabled: true }` and `OPENCLAW_GATEWAY_URL` (HTTP). HexMentraBridge needs `OPENCLAW_WS_URL=ws://...` (e.g. `ws://127.0.0.1:18789`) and `OPENCLAW_GW_TOKEN`.

| This repo (.env) | HexMentraBridge (.env) |
|------------------|-------------------------|
| `OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789` | `OPENCLAW_WS_URL=ws://127.0.0.1:18789` (same host/port, `ws` scheme) |
| `OPENCLAW_GATEWAY_TOKEN=...` | `OPENCLAW_GW_TOKEN=...` |
| `PACKAGE_NAME`, `MENTRAOS_API_KEY` | Same names |
| — | `PUSH_PORT`, `PUSH_BIND`, `PUSH_TOKEN`, `FILTER_LLM_*`, `NOTIF_BLOCKLIST`, `ASSISTANT_NAME` as needed |

To run HexMentraBridge with the same gateway and MentraOS app, clone it and use the launcher script: see [Running HexMentraBridge](#running-hexmentrabridge) below.

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

## Flow

1. User puts on Even G1 glasses and opens your app (MentraOS connects to the bridge via the cloud).
2. User **speaks**; final transcriptions are sent to OpenClaw as user messages.
3. OpenClaw’s **streaming** response is shown on the glasses (throttled to ~4 updates per second to respect display limits).
4. If the user speaks again while a response is in progress, the glasses show “Busy. Wait for the current response.”

## Running HexMentraBridge

To use the full-featured bridge (copilot, push API, transcripts) with the same OpenClaw gateway and MentraOS app:

1. Clone [HexMentraBridge](https://github.com/johannboehme/HexMentraBridge) next to this repo (e.g. `../HexMentraBridge`) or into this repo as `hex-bridge`.
2. From this repo, run:
   ```bash
   ./scripts/run-hex-bridge.sh
   ```
   The script reads `.env` from this repo, derives `OPENCLAW_WS_URL` from `OPENCLAW_GATEWAY_URL`, and starts HexMentraBridge with Bun. If you cloned HexMentraBridge elsewhere, set `HEX_BRIDGE_DIR` to that path.

## License

MIT
