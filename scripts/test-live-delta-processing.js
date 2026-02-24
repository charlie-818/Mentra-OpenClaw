#!/usr/bin/env node
/**
 * Test live delta processing: capture raw deltas from OpenClaw stream,
 * process them through the FIXED logic, and verify word boundaries are preserved.
 */
import "dotenv/config";

const SUFFIX_MERGE_BLOCKLIST = new Set(
  "a,the,he,she,we,me,be,to,of,in,on,at,is,or,so,no,go,do,up,us,as,an,am".split(",")
);

function formatResponseText(text) {
  return text
    .replace(/(\S)\*+(\S)/g, "$1 $2")
    .replace(/\*+/g, "")
    .replace(/(\S)#+\s*(\S)/g, "$1 $2")
    .replace(/#+\s*/g, "")
    .replace(/(\S)"(\S)/g, "$1 $2")
    .replace(/"/g, "")
    .replace(/  +/g, " ")
    .replace(/(\w+)\s+('(?:t|s|re|ve|ll|d|m)\b)/gi, "$1$2")
    .replace(/(\w+) (ly|ed|ing|ness|er|est|ful|less|ment|able|ible|tion|sion|'s)\b/gi, (_, word, suffix) =>
      SUFFIX_MERGE_BLOCKLIST.has(word.toLowerCase()) ? `${word} ${suffix}` : word + suffix
    )
    .replace(/([.!?])\s+(\d+\.)\s/g, "$1\n$2 ")
    .replace(/([a-z])\s+(\d+\.)\s/g, "$1\n$2 ")
    .replace(/([.!?a-z])\s+-\s+/gi, "$1\n- ")
    .replace(/\n\n+/g, "\n")
    .trim();
}

function processDeltasFixed(deltas) {
  let responseBuffer = "";
  let pendingSpace = false;

  for (const delta of deltas) {
    const bufferHadTrailingSpace = /\s$/.test(responseBuffer);
    const deltaHasLeadingSpace = /^\s/.test(delta);
    const needsSpace = pendingSpace || bufferHadTrailingSpace || deltaHasLeadingSpace;
    responseBuffer = responseBuffer.replace(/\s+$/, "");
    if (delta.startsWith("'")) {
      pendingSpace = false;
      responseBuffer += delta;
      responseBuffer = formatResponseText(responseBuffer);
      continue;
    }
    const deltaTrimmed = delta.replace(/^\s+/, "");
    if (deltaTrimmed.length === 0) {
      pendingSpace = true;
      responseBuffer = formatResponseText(responseBuffer);
      continue;
    }
    if (responseBuffer.length > 0 && needsSpace) {
      responseBuffer += " ";
    }
    pendingSpace = false;
    responseBuffer += deltaTrimmed;
    responseBuffer = formatResponseText(responseBuffer);
  }
  return responseBuffer;
}

function processDeltasOld(deltas) {
  let responseBuffer = "";
  for (const delta of deltas) {
    responseBuffer = responseBuffer.replace(/\s+$/, "");
    if (delta.startsWith("'")) {
      responseBuffer += delta;
      responseBuffer = formatResponseText(responseBuffer);
      continue;
    }
    const deltaTrimmed = delta.replace(/^\s+/, "");
    if (deltaTrimmed.length === 0) {
      responseBuffer = formatResponseText(responseBuffer);
      continue;
    }
    if (responseBuffer.length > 0) {
      responseBuffer += " ";
    }
    responseBuffer += deltaTrimmed;
    responseBuffer = formatResponseText(responseBuffer);
  }
  return responseBuffer;
}

async function fetchAndProcessDeltas(query) {
  const baseUrl = process.env.OPENCLAW_GATEWAY_URL?.replace(/\/$/, "");
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  const agentId = process.env.OPENCLAW_AGENT_ID || "main";
  if (!baseUrl || !token) {
    console.error("Missing OPENCLAW_GATEWAY_URL or OPENCLAW_GATEWAY_TOKEN");
    process.exit(2);
  }

  console.log(`Query: "${query}"`);
  console.log("---");

  const res = await fetch(`${baseUrl}/v1/responses`, {
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
    console.error(`OpenClaw HTTP ${res.status}`);
    process.exit(3);
  }

  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deltas = [];
  let currentEvent = "";
  let currentData = "";

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
          if (typeof chunk === "string" && chunk.length > 0) {
            deltas.push(chunk);
          }
        }
        currentEvent = "";
        currentData = "";
      }
    }
  }
  reader.releaseLock();
  return deltas;
}

const query = process.argv[2] || "What is OpenClaw in one sentence?";
const deltas = await fetchAndProcessDeltas(query);

console.log(`\n=== Raw deltas received (${deltas.length} total) ===\n`);
deltas.forEach((d, i) => {
  const escaped = JSON.stringify(d);
  console.log(`  ${i + 1}. ${escaped}`);
});

const rawConcatenated = deltas.join("");
const fixedResult = processDeltasFixed(deltas);
const oldResult = processDeltasOld(deltas);

console.log("\n=== Raw concatenated (no processing) ===\n");
console.log(rawConcatenated);

console.log("\n=== Processed with FIXED logic ===\n");
console.log(fixedResult);

console.log("\n=== Processed with OLD (buggy) logic ===\n");
console.log(oldResult);

// Check for issues
const issues = [];

// Check for split words (spaces where there shouldn't be)
const splitWordPattern = /\b(\w{2,})\s+(\w{1,3})\b/g;
let match;
while ((match = splitWordPattern.exec(oldResult)) !== null) {
  const combined = match[1] + match[2];
  if (rawConcatenated.includes(combined) && !fixedResult.includes(match[1] + " " + match[2])) {
    issues.push(`OLD split word: "${match[1]} ${match[2]}" should be "${combined}"`);
  }
}

console.log("\n=== Analysis ===\n");

if (fixedResult === oldResult) {
  console.log("Both results are identical - no difference in this response.");
} else {
  console.log("FIXED and OLD results differ!");
  console.log("\nDifferences:");

  // Find first difference
  for (let i = 0; i < Math.max(fixedResult.length, oldResult.length); i++) {
    if (fixedResult[i] !== oldResult[i]) {
      const contextStart = Math.max(0, i - 10);
      const contextEnd = Math.min(Math.max(fixedResult.length, oldResult.length), i + 20);
      console.log(`  First diff at position ${i}:`);
      console.log(`    FIXED: "...${fixedResult.slice(contextStart, contextEnd)}..."`);
      console.log(`    OLD:   "...${oldResult.slice(contextStart, contextEnd)}..."`);
      break;
    }
  }
}

if (issues.length > 0) {
  console.log("\nDetected issues in OLD logic:");
  issues.forEach(issue => console.log(`  - ${issue}`));
}

// Verify key words are not split
const keyWords = ["OpenClaw", "self‑hosted", "open‑source", "long‑term", "one‑off"];
console.log("\nWord integrity check (FIXED result):");
for (const word of keyWords) {
  if (rawConcatenated.includes(word.replace("‑", "")) || rawConcatenated.includes(word)) {
    const inFixed = fixedResult.includes(word) || fixedResult.includes(word.replace("‑", "-"));
    console.log(`  "${word}": ${inFixed ? "✓ intact" : "✗ broken"}`);
  }
}

console.log("\n=== Test complete ===");
