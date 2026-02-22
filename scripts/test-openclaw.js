#!/usr/bin/env node
/**
 * Test OpenClaw gateway connectivity and auth from .env (no glasses needed).
 * Exit 0 if reachable and authorized; non-zero otherwise.
 */
import "dotenv/config";

const baseUrl = process.env.OPENCLAW_GATEWAY_URL?.replace(/\/$/, "");
const token = process.env.OPENCLAW_GATEWAY_TOKEN;

if (!baseUrl || !token) {
  console.error("Missing OPENCLAW_GATEWAY_URL or OPENCLAW_GATEWAY_TOKEN in .env");
  process.exit(1);
}

const url = `${baseUrl}/v1/responses`;
const res = await fetch(url, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "openclaw",
    stream: false,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] }],
  }),
}).catch((err) => {
  console.error("Connection failed:", err.message);
  process.exit(2);
});

if (res.status === 401) {
  console.error("OpenClaw returned 401: invalid or missing token");
  process.exit(3);
}
if (!res.ok) {
  console.error(`OpenClaw returned ${res.status}: ${await res.text().catch(() => "")}`);
  process.exit(4);
}

console.log("OpenClaw gateway: reachable and authorized");
process.exit(0);
