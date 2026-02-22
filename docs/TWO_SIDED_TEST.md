# Two-sided integration test: Bridge machine ↔ OpenClaw machine

Use this so both machines (and Claude on each) can verify connectivity and fix issues together.

**Flow:** Run **Prompt A** on the OpenClaw machine, then **Prompt B** on the bridge machine (this repo). If the bridge test fails, paste **Prompt B’s report** into the OpenClaw chat and re-run or ask for fixes; repeat until both sides report success.

---

## Alternative: run the bridge on the OpenClaw machine

If you prefer to avoid cross-machine connectivity (firewall, Tailscale, etc.), **deploy this repo on the same host as OpenClaw**. Then the bridge talks to the gateway over localhost and no remote access to port 18789 is needed.

1. On the OpenClaw machine: clone this repo, `cp .env.example .env`, and set:
   - `PACKAGE_NAME`, `MENTRAOS_API_KEY` (from MentraOS console)
   - `OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789`
   - `OPENCLAW_GATEWAY_TOKEN=<gateway token from OpenClaw config>`
2. Run `npm run check` then `npm run test:openclaw` — should pass (localhost).
3. Run `npm run dev`, expose the bridge (e.g. `ngrok http 3000`), set the MentraOS webhook URL to the public ngrok URL, then test on the glasses.

You can skip the two-sided test (Prompt A / Prompt B) when bridge and OpenClaw are on the same machine.

---

## Prompt A — OpenClaw machine (server)

Copy and paste this into the chat **on the OpenClaw host** (100.84.26.71 or wherever OpenClaw runs):

```
You are the "server side" of a two-sided integration test. A Mentra+OpenClaw bridge on another machine will connect to this OpenClaw gateway over HTTP. Your job is to make this host ready and produce a short report for the bridge operator.

**1. Verify gateway**
- Confirm the OpenClaw gateway is running and listening on 0.0.0.0:18789 (all interfaces). If it's bound only to 127.0.0.1, change config to bind to 0.0.0.0 or "lan".
- Confirm the HTTP Responses API is enabled (path /v1/responses).
- Note this host's reachable IPs (e.g. Tailscale IP, LAN IP). Prefer the IP that the bridge machine can use (e.g. if both have Tailscale, use the Tailscale IP).

**2. Firewall**
- Ensure inbound TCP port 18789 is allowed from external IPs (or at least from 0.0.0.0/0 for testing). If the bridge operator will send you their IP, you can restrict to that later.
- List what you checked or changed (ufw, firewalld, iptables, cloud security group).

**3. Local sanity check**
- From this host, run: curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:18789/ -H "Authorization: Bearer <gateway_token>". Expect 200. Use the real gateway token from this host's OpenClaw config.

**4. Output "Report for bridge operator"**
Produce a block the bridge operator can copy. Include:
- OPENCLAW_GATEWAY_URL=http://<this-machine-ip>:18789  (use the IP the bridge will use: Tailscale IP if both use Tailscale, else LAN or public IP)
- OPENCLAW_GATEWAY_TOKEN=<the actual token from config>
- One-line test command they can run from the bridge machine (curl or node), with the token in place, so they can verify connectivity.
- "If the bridge reports 'fetch failed' or 'ECONNREFUSED': gateway may be bound to localhost only, or firewall is blocking. If 'ETIMEDOUT': network path or firewall. Ask the bridge operator to send you their public IP so you can allow it on port 18789."
- "If the bridge reports '401': token is wrong; re-check OPENCLAW_GATEWAY_TOKEN against this host's config."

**5. Output "Checklist (OpenClaw side)"**
- [ ] Gateway listening on 0.0.0.0:18789
- [ ] Responses API enabled
- [ ] Firewall allows inbound TCP 18789
- [ ] Local curl to 127.0.0.1:18789 returns 200
- [ ] Report for bridge operator generated
```

---

## Prompt B — Bridge machine (this repo)

Copy and paste this into the chat **on the machine where the Mentra+OpenClaw bridge runs** (your Mac / this project):

```
You are the "bridge side" of a two-sided integration test. The OpenClaw gateway runs on another machine. Your job is to run the integration tests and produce a short report for the OpenClaw operator.

**1. Use the report from the OpenClaw machine**
- If the user pasted a "Report for bridge operator" from the OpenClaw machine, update this project's .env with OPENCLAW_GATEWAY_URL and OPENCLAW_GATEWAY_TOKEN from that report (use http://, not ws://).
- If not, use the existing .env.

**2. Run these checks in order**
- Step 1: Verify .env has PACKAGE_NAME, MENTRAOS_API_KEY, OPENCLAW_GATEWAY_URL, OPENCLAW_GATEWAY_TOKEN.
- Step 2: Run `npm run check` (build + bridge health). Expect Health: 200.
- Step 3: Run `npm run test:openclaw` (POST to OpenClaw gateway). Note the result: PASS ("reachable and authorized") or FAIL (exact error message: "Connection failed: fetch failed", "401", etc.).

**3. If test:openclaw fails**
- Run: curl -v http://<OPENCLAW_GATEWAY_URL from .env>/ -H "Authorization: Bearer <token from .env>" 2>&1 | head -30
- Note the exact error (e.g. "Connection refused", "Timed out", "Could not resolve host").

**4. Output "Report for OpenClaw operator"**
Produce a block they can paste back into the OpenClaw chat. Include:
- Bridge test result: PASS or FAIL.
- If FAIL: exact error (e.g. "fetch failed", "ECONNREFUSED", "ETIMEDOUT", "401") and the curl output summary.
- This machine's outbound IP (run: curl -s ifconfig.me or similar) so the OpenClaw operator can whitelist it in their firewall if needed.
- "Checklist (bridge side): [x] .env set, [x] npm run check passed, [ ] npm run test:openclaw passed."

**5. If PASS**
- Say "Integration test passed. Bridge can reach OpenClaw. Next: run npm run dev, ngrok http 3000, set MentraOS webhook, test on glasses."
```

---

## Handshake steps (you)

1. **On OpenClaw machine:** Run **Prompt A**. Copy the "Report for bridge operator" and the "Checklist (OpenClaw side)".
2. **On this machine (bridge):** Paste the report into .env (or ensure OPENCLAW_GATEWAY_URL and OPENCLAW_GATEWAY_TOKEN match the report). Then run **Prompt B**. Copy the "Report for OpenClaw operator" and the "Checklist (bridge side)".
3. **If bridge side FAIL:** Paste the "Report for OpenClaw operator" into the OpenClaw machine chat and ask: "The bridge still can't connect. Please fix using this report (open firewall for the bridge IP, or confirm binding to 0.0.0.0)." Then re-run Prompt A if needed, and Prompt B again with the new report.
4. **If both PASS:** Run `npm run dev`, start ngrok, set the MentraOS webhook, and test on the glasses.

---

## Quick reference

| Side    | Prompt | Main output for the other |
|---------|--------|----------------------------|
| OpenClaw | A     | URL, token, test command; checklist |
| Bridge   | B     | PASS/FAIL, error details, bridge IP; checklist |

Both sides use the reports to fix firewall, binding, or token until `npm run test:openclaw` on the bridge reports "OpenClaw gateway: reachable and authorized".
