#!/usr/bin/env node
/**
 * Test asterisk stripping: current (words can fuse) vs fixed (insert space when * between non-space).
 * Run: node scripts/test-asterisk-strip.js
 *      node scripts/test-asterisk-strip.js --live [query]   # real OpenClaw response, then strip comparison
 */
import "dotenv/config";

function currentStrip(text) {
  return text.replace(/\*+/g, "");
}

function fixedStrip(text) {
  return text
    .replace(/(\S)\*+(\S)/g, "$1 $2")
    .replace(/\*+/g, "");
}

/** Find where fixed strip added a space (asterisk run between two non-whitespace). Returns array of { index, before, after }. */
function spacesAddedByFix(text) {
  const out = [];
  const re = /(\S)\*+(\S)/g;
  let m;
  let offset = 0;
  while ((m = re.exec(text)) !== null) {
    out.push({
      index: m.index + m[1].length,
      snippet: `"${m[0]}" → "${m[1]} ${m[2]}"`,
    });
  }
  return out;
}

const args = process.argv.slice(2);
const liveIdx = args.indexOf("--live");
const isLive = liveIdx !== -1;
const query = isLive ? (args[liveIdx + 1] || "List three short tips for productivity.") : null;

if (isLive && query) {
  const baseUrl = process.env.OPENCLAW_GATEWAY_URL?.replace(/\/$/, "");
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  const agentId = process.env.OPENCLAW_AGENT_ID || "main";
  if (!baseUrl || !token) {
    console.error("Missing OPENCLAW_GATEWAY_URL or OPENCLAW_GATEWAY_TOKEN in .env");
    process.exit(2);
  }
  const url = `${baseUrl}/v1/responses`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-openclaw-agent-id": agentId,
    },
    body: JSON.stringify({
      model: "openclaw",
      stream: true,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: query }] }],
    }),
  });
  if (!res.ok) {
    console.error(`OpenClaw HTTP ${res.status}: ${await res.text().then((t) => t.slice(0, 300))}`);
    process.exit(3);
  }
  const reader = res.body?.getReader();
  if (!reader) {
    console.error("No response body");
    process.exit(4);
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let currentEvent = "";
  let currentData = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("event:")) currentEvent = line.slice(6).trim();
        else if (line.startsWith("data:")) {
          currentData = line.slice(5).trim();
          if (currentData === "[DONE]") {
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
          if (currentEvent === "response.output_text.delta") {
            const chunk = data?.delta ?? data?.text ?? "";
            if (typeof chunk === "string" && chunk.length > 0) fullText += chunk;
          } else if (currentEvent === "response.output_text.done" && typeof data?.text === "string" && data.text.length > 0 && !fullText) {
            fullText = data.text;
          }
          currentEvent = "";
          currentData = "";
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!fullText) {
    console.error("No response text from OpenClaw.");
    process.exit(1);
  }

  const current = currentStrip(fullText);
  const fixed = fixedStrip(fullText);
  const added = spacesAddedByFix(fullText);

  console.log("=== Real OpenClaw response (raw) ===\n");
  console.log(fullText);
  console.log("\n=== Current strip (words may be fused) ===\n");
  console.log(current);
  console.log("\n=== Fixed strip (space added at * boundaries) ===\n");
  console.log(fixed);
  if (added.length > 0) {
    console.log("\n=== Spaces added strategically (where * was between two non-space chars) ===\n");
    added.forEach((a, i) => console.log(`  ${i + 1}. ${a.snippet}`));
  } else {
    console.log("\n(No asterisks between words in this response; no extra spaces needed.)");
  }
  process.exit(0);
}

const examples = [
  "*bold*",
  " * bold * ",
  "a * b",
  "word*bold",
  "word**bold",
  "a*b*c",
  "Hello *world*today",
  "something*like*this",
  "No asterisk here",
  "*leading* and *trailing*",
];

console.log("Asterisk strip: original -> current (fused?) -> fixed (space added)\n");

for (const original of examples) {
  const current = currentStrip(original);
  const fixed = fixedStrip(original);
  const fused = current !== fixed ? " [FUSED]" : "";
  console.log(`Original:  "${original}"`);
  console.log(`Current:   "${current}"${fused}`);
  console.log(`Fixed:     "${fixed}"`);
  console.log("");
}
