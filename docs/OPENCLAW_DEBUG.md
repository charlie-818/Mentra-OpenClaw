# OpenClaw Debug: No Response on Glasses

Use this guide when the glasses show "Connected" but you get no AI response after speaking.

## 1. Verify OpenClaw connectivity from the bridge machine

Run from the project root (the Mac running the bridge):

```bash
npm run test:openclaw
```

To send a real streaming query and print the full response (same URL/token as the bridge, e.g. through your tunnel/Railway):

```bash
npm run test:openclaw:stream
# Or with a custom query:
node scripts/test-openclaw-stream.js "Tell me about bacon."
```

Stdout = response text; stderr = SSE event log. Exit 0 only if response text was received. Use `VERBOSE=1 npm run test:openclaw:stream` to log full payloads for `response.output_text.done` and `response.completed` (helps debug placeholder replies).

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
- **"OpenClaw HTTP 400" / "Invalid input"** – The gateway rejected the request body. The bridge sends OpenResponses-format input: message content uses `type: "input_text"` (per [OpenResponses spec](https://www.openresponses.org/specification)). Ensure your OpenClaw gateway accepts that. Run `npm run test:openclaw` to verify connectivity and request format.
- **"Thinking..." then "Done." with no response** – The bridge received no streamed text. Ensure the OpenClaw gateway sends `response.output_text.delta` events with a `delta` or `text` string. Run the bridge with `DEBUG=1` or `LOG_SSE=1` and check which SSE event names and payload keys appear in the logs.
 - **Gateway returns 200 but reply is "No response from OpenClaw." or placeholder / empty** – The gateway is reachable but the **OpenClaw agent or model** is not producing a real reply. Fix this on the **OpenClaw host** (see section 5 below).

**Trigger words:** Dictated text is sent to OpenClaw only when you say a **trigger phrase** (e.g. "go", "send", "execute", "big mac"). All dictated text is logged on the glasses; saying a trigger sends the current transcript (minus the trigger) to OpenClaw and clears the log. Set `OPENCLAW_TRIGGER_WORDS` in `.env` to a comma-separated list to change triggers (default: `go,send,execute,big mac`). If you speak but never say a trigger, you will see "Final transcription received" in logs but no "Sending to OpenClaw" until you say a trigger.

### Debugging spacing or fused/split words on the glasses

If text on the glasses shows words run together (e.g. "copypaste") or oddly split (e.g. "Cl aw"), inspect what the bridge is receiving and building:

- **Railway:** Set env `DEBUG=1` or `LOG_SSE=1` in the Railway project, redeploy, then run `railway logs` (or use the Railway dashboard Logs / Log Explorer). Each streamed chunk is logged with `onDelta` and the current buffer tail.
- **Local:** Run the bridge with `DEBUG=1` or `LOG_SSE=1` and watch the terminal; you’ll see `deltaLen`, `bufferLen`, and `tail` for each chunk so you can see how spacing is applied between deltas.

The bridge always inserts a space between two non-whitespace chunks so words do not fuse; it trims a trailing space only when the next chunk is a contraction apostrophe (e.g. `'t`, `'s`) so "don't" stays correct.

## 4. OpenClaw on a different host (SSH machine)

If OpenClaw runs on another machine (e.g. `100.84.26.71`):

- Ensure the **bridge machine** can reach it: `curl -s -o /dev/null -w "%{http_code}" http://100.84.26.71:18789/ -H "Authorization: Bearer YOUR_TOKEN"`
- Gateway must listen on `0.0.0.0:18789` (or equivalent) so the bridge can connect
- Both hosts should be on the same network (LAN or Tailscale)

See [TWO_SIDED_TEST.md](TWO_SIDED_TEST.md) for joint bridge/OpenClaw debugging.

## 5. Getting a real model response (not placeholder / "No response from OpenClaw.")

When `npm run test:openclaw:stream` returns HTTP 200 and the response text is something like **"No response from OpenClaw."** or empty, the bridge and gateway are fine — the **OpenClaw server** (the machine behind the tunnel) is not running a model that actually replies. Fix it on that host.

**On the OpenClaw machine** (SSH into the host that runs the gateway, or the machine that Cloudflare tunnel forwards to):

1. **Quick triage**
   ```bash
   openclaw status
   openclaw models status
   openclaw gateway logs --follow
   ```
   Send a test message from the bridge or stream test, then watch the logs for errors (e.g. 401 from the provider, "no model", "no output").

2. **Model and auth**
   - Ensure a default model is set and the provider is authenticated:
     ```bash
   openclaw models status
   openclaw onboard   # or re-run if needed
   ```
   - For **remote/VPS**, use **API keys** in `~/.openclaw/.env`, not OAuth (OAuth tokens are host-specific):
     ```bash
   # e.g. on the OpenClaw host
   echo 'ANTHROPIC_API_KEY=sk-ant-...' >> ~/.openclaw/.env
   openclaw gateway restart
   ```
   - Config should have a valid primary model, e.g. in `~/.openclaw/openclaw.json`:
     ```json
   { "agents": { "defaults": { "model": { "primary": "anthropic/claude-sonnet-4-5" } } } }
   ```
   - **Switch to another model (e.g. Azure OpenAI):** On the OpenClaw host run:
     ```bash
   openclaw models list
   openclaw models aliases list
   openclaw models set <model-or-alias>   # e.g. azure-open-ai-5.2 or azure-openai/<deployment>
   openclaw gateway restart
   ```
     Use the exact model id or alias shown by `list` / `aliases list`. If the id has a `/`, use the full form (e.g. `azure-openai/gpt-4o`).

3. **Auto-repair**
   ```bash
   openclaw doctor --fix
   openclaw gateway restart
   ```

4. **Responses API**
   - Ensure the HTTP Responses endpoint is enabled (bridge uses `POST /v1/responses`):
     ```json
   { "gateway": { "http": { "endpoints": { "responses": { "enabled": true } } } } }
   ```

5. **Test from the OpenClaw host**
   ```bash
   openclaw test
   ```
   If the model responds in the TUI or CLI but not via the bridge, the issue is likely gateway/Responses API config or how the agent is invoked for HTTP requests.

After fixing, run `npm run test:openclaw:stream` again from the bridge machine; you should see a real model reply on stdout.

## 6. OpenRouter 402: “more credits, or fewer max_tokens” (no response)

If gateway logs show the agent run failing with **402** and a message like:

- **“This request requires more credits, or fewer max_tokens. You requested up to 30000 tokens, but can only afford 9788.”**

then the **OpenRouter** key or account limit is the cause. OpenClaw may log this as “context overflow” and retry with compaction; compaction does not fix a 402, so you get no response.

**Fixes (on the OpenClaw host):**

1. **Add credits or raise limits**  
   Go to [OpenRouter → Settings → Keys](https://openrouter.ai/settings/keys), add credits or create a key with higher limits so requests for your usual context + 30k max_tokens are allowed.

2. **Lower `max_tokens`**  
   So the request stays within what OpenRouter allows (e.g. 9788 or 8000). In OpenClaw config (e.g. `~/.openclaw/openclaw.json` or agent defaults), set a lower `max_tokens` (e.g. `8000`) for the OpenRouter/auto agent. Then restart the gateway:
   ```bash
   openclaw gateway restart
   ```

3. **Optional: different model**  
   If you switch to a different OpenRouter model or provider with different pricing/limits, ensure that key has enough credits and that `max_tokens` is still within the allowed budget.

After applying 1 and/or 2, run `npm run test:openclaw:stream` again; you should get a real reply.

---

**Control UI “no response” (separate):**  
If the **dashboard Control UI** cannot connect (logs: `control-ui-insecure-auth`, `token_missing`), that does not stop the glasses from getting a response. To fix the Control UI: open the dashboard URL, copy the gateway token, and paste it in Control UI settings. For access via IP (e.g. `http://192.168.x.x:18789`), you may need to allow insecure auth in the gateway config.
