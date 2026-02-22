# Development process: testing Mentra SDK on the glasses

Use this flow to confirm the Mentra SDK is integrated and that you can see content on your Even G1 glasses **before** wiring up OpenClaw.

---

## Configuration checklist & full testing

Use this checklist to verify configuration and run through a full test.

| Step | Check | How to verify |
|------|--------|----------------|
| 1 | `.env` exists with `PACKAGE_NAME`, `MENTRAOS_API_KEY` | Same as in MentraOS console. Optional: `OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN` for voice → AI. |
| 2 | Build and health | Run `npm run check` (builds and hits `/health`), or manually: `npm run build` then `npm run dev` and in another terminal `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/health` (expect 200). |
| 3 | Bridge running | `npm run dev` starts without "MENTRAOS_API_KEY required". The app loads `.env` automatically. |
| 4 | ngrok exposing port 3000 | In a second terminal: `ngrok http 3000`. Note the **HTTPS** URL (e.g. `https://abc123.ngrok-free.app`). |
| 5 | Webhook URL in MentraOS | In [console.mentra.glass](https://console.mentra.glass), set your app’s **Webhook URL** to `https://<your-ngrok-host>/webhook`. |
| 6 | Test on glasses (Mentra only) | Open your app on the G1 glasses. You should see **"Mentra connected. You should see this on your glasses."** |
| 7 | Test with OpenClaw (optional) | Ensure OpenClaw gateway is running with Responses API enabled and `.env` has gateway URL and token. Restart bridge, open app on glasses; you should see **"Connected. Say something or press the button."** Then speak; the reply should stream on the glasses. |

**Quick local verification (no glasses):** From the project root run `npm run check`.

**Two-sided test (bridge + OpenClaw machine):** If the OpenClaw gateway is on another host and connectivity fails, use the prompts in [docs/TWO_SIDED_TEST.md](docs/TWO_SIDED_TEST.md) so Claude on each machine can verify and fix the connection together. It builds and checks that the bridge health endpoint returns 200.

**Test OpenClaw from this machine:** Run `npm run test:openclaw`. It POSTs to your OpenClaw gateway using `.env`; if it prints "OpenClaw gateway: reachable and authorized", the bridge can talk to OpenClaw. If you see "Connection failed", the gateway is unreachable (firewall, different network, or wrong URL). Use **http://** in `OPENCLAW_GATEWAY_URL` (this bridge uses the HTTP Responses API, not WebSocket). If OpenClaw is on another host (e.g. 100.84.26.71), ensure this machine can reach it (e.g. same LAN, or Tailscale on both).

**Quick curl from bridge machine (optional):** To verify the gateway is reachable before starting the bridge:
```bash
curl -s -o /dev/null -w "%{http_code}" http://100.84.26.71:18789/ -H "Authorization: Bearer YOUR_TOKEN"
```
Expect 200 (or another non-connection-error code). Replace `YOUR_TOKEN` with your `OPENCLAW_GATEWAY_TOKEN` or use `npm run test:openclaw` which reads it from `.env`.

---

## Overview

1. Run the bridge on your machine (only Mentra env vars needed).
2. Expose it to the internet so MentraOS Cloud can reach it (e.g. ngrok).
3. Register the app in the MentraOS console with that public webhook URL.
4. Open the app on the glasses; you should see text on the display.

No OpenClaw configuration is required for this test.

---

## Step 1: MentraOS API key and package name

1. Go to **[console.mentra.glass](https://console.mentra.glass)** (or the Mentra developer portal you use).
2. Create or select an app and get its **API key**.
3. Note the app’s **package name** (e.g. `com.yourname.mentra-openclaw-bridge`). It must match exactly what you run the bridge with.

---

## Step 2: Environment (Mentra only)

From the project root:

```bash
cp .env.example .env
```

Edit `.env` and set **only** (leave OpenClaw vars unset for this test):

- `PORT=3000`
- `PACKAGE_NAME=com.yourname.mentra-openclaw-bridge`  (must match console)
- `MENTRAOS_API_KEY=<your_api_key>`

Do **not** set `OPENCLAW_GATEWAY_URL` or `OPENCLAW_GATEWAY_TOKEN` yet.

---

## Step 3: Expose the bridge (ngrok)

MentraOS Cloud must reach your app over HTTPS. For local development use a tunnel.

### Setting up ngrok

1. **Install ngrok**
   - **macOS (Homebrew):** `brew install ngrok/ngrok/ngrok`
   - **Or:** download from [ngrok.com/download](https://ngrok.com/download) and put the binary in your PATH.

2. **Sign up and get your auth token**
   - Go to [ngrok.com](https://ngrok.com) and sign up (free account is enough).
   - In the dashboard: **Your Authtoken** → copy the token.
   - In a terminal, run once:
     ```bash
     ngrok config add-authtoken YOUR_TOKEN
     ```

3. **Start the bridge and run ngrok**
   - Terminal 1 — start the bridge:
     ```bash
     npm run dev
     ```
   - Terminal 2 — expose port 3000:
     ```bash
     ngrok http 3000
     ```

4. **Copy the public URL**
   - In the ngrok terminal you’ll see a line like `Forwarding  https://abc123.ngrok-free.app -> http://localhost:3000`.
   - Your webhook URL is that **HTTPS** URL + `/webhook`, e.g. **`https://abc123.ngrok-free.app/webhook`**.
   - (Free tier: the URL changes each time you restart ngrok; update the webhook in the MentraOS console if it changes.)

---

## Step 4: Register the app in MentraOS

1. In the MentraOS developer console, open your app (or create one).
2. Set **Webhook URL** to the ngrok URL + `/webhook`:
   - Example: `https://abc123.ngrok-free.app/webhook`
3. Save. Ensure **package name** and **API key** match your `.env`.

The cloud will send session requests to this URL when a user opens your app on the glasses.

---

## Step 5: Run the app on the glasses

1. Put on the Even G1 glasses (MentraOS).
2. Open the **MentraOS app list** and launch **your app** (the one you registered).
3. The glasses connect to the cloud, which calls your webhook and establishes a session with the bridge.

You should see on the glasses:

- **“Mentra connected. You should see this on your glasses.”**

That confirms the SDK is working and content is reaching the display. After that you can add OpenClaw env vars and test voice → OpenClaw → display.

---

## Step 6: Iterate

- **Change copy in code** (e.g. the text in `showTextWall(...)` in `src/index.ts`), save. With `npm run dev`, the server restarts.
- **Restart the app on the glasses** (or reconnect) to start a new session and see the new text.
- Keep **ngrok** and **npm run dev** running while testing. If you restart ngrok, the URL changes; update the webhook URL in the MentraOS console.

---

## Troubleshooting

| Issue | What to check |
|-------|----------------|
| Nothing on glasses | App actually opened on the glasses? Webhook URL in console is HTTPS and ends with `/webhook`? Bridge and ngrok are running? |
| “Connection failed” on glasses | ngrok URL correct in console? No firewall blocking ngrok or your port 3000? |
| Webhook errors in console | Bridge running and reachable at the webhook URL? `PACKAGE_NAME` and `MENTRAOS_API_KEY` match the app in the console? |
| Wrong / old text on glasses | New session: close and reopen the app on the glasses so the cloud creates a new session to your bridge. |

### Nothing on the glasses (checklist)

1. **Bridge running** — In the terminal where you ran `npm run dev`, leave it running. When you open the app on the glasses, you should see a log line like `New session: ... for user ...`. If you see **nothing** when you open the app, MentraOS is not reaching your bridge.
2. **ngrok running** — In a **second** terminal, run `ngrok http 3000`. Leave it running. The HTTPS URL (e.g. `https://abc123.ngrok-free.app`) must be the one you use in the console.
3. **Webhook URL exact** — In [console.mentra.glass](https://console.mentra.glass), your app’s **Webhook URL** must be exactly: `https://<your-ngrok-host>/webhook` (HTTPS, no trailing slash before `/webhook`, path is `/webhook`). If you restarted ngrok, the host changed; update the webhook URL.
4. **Package name match** — In the console, the app’s **package name** must match your `.env` exactly (e.g. `cbcopenclaw`). Case-sensitive.
5. **API key match** — The **API key** in the console must match `MENTRAOS_API_KEY` in your `.env`.
6. **Force new session** — On the glasses, fully close your app and open it again. If the bridge was fixed after you first opened the app, the glasses may still be in an old session.
7. **MentraOS dashboard** — In the console, check for webhook delivery errors or logs when you open the app; they can show “connection refused” or 4xx/5xx if the URL or bridge is wrong.

---

## Next: add OpenClaw

Once you see the test message on the glasses:

1. Set `OPENCLAW_GATEWAY_URL` and `OPENCLAW_GATEWAY_TOKEN` (and optionally `OPENCLAW_AGENT_ID`) in `.env`.
2. Restart the bridge.
3. Open the app on the glasses again; you should see “Connected. Say something or press the button.” and voice prompts will go to OpenClaw and responses will stream to the display.
