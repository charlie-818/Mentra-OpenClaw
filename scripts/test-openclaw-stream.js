#!/usr/bin/env node
/**
 * Send a real query to the OpenClaw gateway (streaming) and print the full response.
 * Uses OPENCLAW_GATEWAY_URL and OPENCLAW_GATEWAY_TOKEN from .env (same as the bridge).
 * Run: node scripts/test-openclaw-stream.js [query]
 * Default query: "Tell me about bacon."
 * VERBOSE=1 to log full payloads for response.output_text.done and response.completed.
 * Exit 0 if we received response text; 1 if no text; 2+ on connection/auth errors.
 */
import "dotenv/config";

const verbose = process.env.VERBOSE === "1";
const baseUrl = process.env.OPENCLAW_GATEWAY_URL?.replace(/\/$/, "");
const token = process.env.OPENCLAW_GATEWAY_TOKEN;
const agentId = process.env.OPENCLAW_AGENT_ID || "main";

const query = process.argv[2] || "Tell me about bacon.";

if (!baseUrl || !token) {
  console.error("Missing OPENCLAW_GATEWAY_URL or OPENCLAW_GATEWAY_TOKEN in .env");
  process.exit(2);
}

const url = `${baseUrl}/v1/responses`;
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "x-openclaw-agent-id": agentId,
};
const body = {
  model: "openclaw",
  stream: true,
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: query }],
    },
  ],
};

console.error(`POST ${url}`);
console.error(`Query: "${query}"`);
console.error("---");

let res;
try {
  res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
} catch (err) {
  console.error("Connection failed:", err.message);
  process.exit(3);
}

if (res.status === 401) {
  console.error("OpenClaw returned 401: invalid or missing token");
  process.exit(4);
}
if (!res.ok) {
  const text = await res.text();
  console.error(`OpenClaw returned ${res.status}: ${text.slice(0, 500)}`);
  process.exit(5);
}

const reader = res.body?.getReader();
if (!reader) {
  console.error("No response body");
  process.exit(6);
}

const decoder = new TextDecoder();
let buffer = "";
let currentEvent = "";
let currentData = "";
let fullText = "";
let eventCount = 0;

try {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        currentData = line.slice(5).trim();
        if (currentData === "[DONE]") {
          eventCount++;
          console.error(`[SSE] event: done`);
          currentEvent = "";
          currentData = "";
          continue;
        }
        let data;
        try {
          data = JSON.parse(currentData);
        } catch {
          data = currentData;
        }
        eventCount++;
        if (currentEvent === "response.output_text.delta") {
          const chunk = data?.delta ?? data?.text ?? "";
          if (typeof chunk === "string" && chunk.length > 0) {
            fullText += chunk;
            process.stdout.write(chunk);
          }
          console.error(`[SSE] ${currentEvent} (+${typeof chunk === "string" ? chunk.length : 0} chars)`);
        } else if (currentEvent === "response.output_text.done") {
          if (typeof data?.text === "string" && data.text.length > 0 && !fullText) {
            fullText = data.text;
            process.stdout.write(data.text);
          }
          if (verbose && data) console.error(`[SSE] ${currentEvent} payload:`, JSON.stringify(data, null, 2));
          else console.error(`[SSE] ${currentEvent}`);
        } else if (currentEvent === "response.completed" && verbose && data) {
          console.error(`[SSE] ${currentEvent} payload:`, JSON.stringify(data, null, 2));
        } else {
          console.error(`[SSE] ${currentEvent} keys: ${data && typeof data === "object" ? Object.keys(data).join(", ") : "(raw)"}`);
        }
        currentEvent = "";
        currentData = "";
      }
    }
  }
} finally {
  reader.releaseLock();
}

console.error("---");
console.error(`Events received: ${eventCount}`);
console.error(`Response length: ${fullText.length} chars`);

if (fullText.length === 0) {
  console.error("No response text received. Check gateway sends response.output_text.delta or response.output_text.done with delta/text.");
  process.exit(1);
}
process.exit(0);
