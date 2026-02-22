# OpenClaw Debug: No Response on Glasses

Use this guide when the glasses show "Connected" but you get no AI response after speaking.

## 1. Verify OpenClaw connectivity from the bridge machine

Run from the project root (the Mac running the bridge):

```bash
npm run test:openclaw
```

- **Success:** `OpenClaw gateway: reachable and authorized`
- **Connection failed / hangs:** The bridge machine cannot reach OpenClaw (e.g. `100.84.26.71:18789`). Check:
  - Both machines on same LAN or both on Tailscale
  - Firewall on the OpenClaw host allows inbound TCP port 18789
  - `OPENCLAW_GATEWAY_URL` in `.env` uses `http://` (not `ws://`)
- **401:** Invalid `OPENCLAW_GATEWAY_TOKEN`; verify against OpenClaw config

## 2. Watch bridge logs while testing

Restart the bridge and keep the terminal visible:

```bash
npm start
```

Then open the app on the glasses and speak. Look for:

| Log message | Meaning |
|-------------|---------|
| `Final transcription received: ...` | Voice reached the bridge; transcription is working |
| `Sending to OpenClaw: ... text="..."` | Bridge is POSTing to OpenClaw |
| `[OpenClaw] POST ... → 200` | OpenClaw accepted the request |
| `OpenClaw request failed` (with err in logs) | OpenClaw returned an error or fetch failed |

## 3. Diagnose by log presence

- **No "Final transcription received"** – Transcription is not reaching the bridge. Check Mentra subscription (transcription stream) and microphone permissions.
- **"Final transcription" and "Sending" but no output and no error** – OpenClaw may return 200 with empty or invalid SSE. Inspect OpenClaw logs on the gateway host.
- **"OpenClaw error" on glasses** – See full error in bridge logs; common causes: connection refused, timeout, 401, 5xx.
- **"Thinking..." then "Done." with no response** – The bridge received no streamed text. Ensure (1) the bridge sends `type: "text"` in message content (not `input_text`); (2) the OpenClaw gateway sends `response.output_text.delta` events with a `delta` or `text` string in the payload; (3) run the bridge with `DEBUG=1` or `LOG_SSE=1` and check which SSE event names and payload keys appear in the logs.

## 4. OpenClaw on a different host (SSH machine)

If OpenClaw runs on another machine (e.g. `100.84.26.71`):

- Ensure the **bridge machine** can reach it: `curl -s -o /dev/null -w "%{http_code}" http://100.84.26.71:18789/ -H "Authorization: Bearer YOUR_TOKEN"`
- Gateway must listen on `0.0.0.0:18789` (or equivalent) so the bridge can connect
- Both hosts should be on the same network (LAN or Tailscale)

See [TWO_SIDED_TEST.md](TWO_SIDED_TEST.md) for joint bridge/OpenClaw debugging.
