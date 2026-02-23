#!/usr/bin/env node
/**
 * Emulate the exact text shown on the glasses: format -> tokenize -> wrap -> join.
 * Detect when words become concatenated (no space) in the displayed string.
 *
 * Run: node scripts/emulate-glasses-display.js [text or --live "query"]
 * Uses same logic as src/index.ts: formatResponseText, split(/(\n)| +/), strict-word wrap, joinViewportLinesWithSpaces.
 */
import "dotenv/config";

const G1_MAX_LINES = 5;
/** Plausible G1 line width in characters (wrap to this). */
const G1_LINE_CHARS = 22;

function formatResponseText(text, insertSpaceAtAsterisks = true) {
  let t = text;
  if (insertSpaceAtAsterisks) {
    t = t.replace(/(\S)\*+(\S)/g, "$1 $2");
  }
  return t
    .replace(/\*+/g, "")
    .replace(/(\S)#+\s*(\S)/g, "$1 $2")
    .replace(/#+\s*/g, "")
    .replace(/(\S)"(\S)/g, "$1 $2")
    .replace(/"/g, "")
    .replace(/  +/g, " ")
    .replace(/([.!?])\s+(\d+\.)\s/g, "$1\n$2 ")
    .replace(/([a-z])\s+(\d+\.)\s/g, "$1\n$2 ")
    .replace(/([.!?a-z])\s+-\s+/gi, "$1\n- ")
    .replace(/\n\n+/g, "\n")
    .trim();
}

function joinViewportLinesWithSpaces(lines) {
  return lines.join("\n").replace(/([^\s])\n(?=[^\s])/g, "$1 \n");
}

/** Strict-word wrap: break at spaces/newlines only; no mid-word break. Returns up to maxLines lines. */
function wrapToViewport(content, lineChars, maxLines) {
  const lines = [];
  const paragraphs = content.split("\n");
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    let currentLine = "";
    for (const word of words) {
      const candidate = currentLine ? `${currentLine} ${word}` : word;
      if (candidate.length <= lineChars) {
        currentLine = candidate;
      } else {
        if (currentLine) {
          lines.push(currentLine);
          if (lines.length >= maxLines) return lines;
        }
        currentLine = word;
      }
    }
    if (currentLine) {
      lines.push(currentLine);
      if (lines.length >= maxLines) return lines;
      currentLine = "";
    }
  }
  return lines;
}

/** Same tokenization as renderNextWord: split on newlines or spaces. */
function tokenize(buffer) {
  return buffer.split(/(\n)| +/).filter(Boolean);
}

/** Build full content string as the app does (space between word tokens, newlines preserved). */
function buildTextToShow(tokens) {
  let text = "";
  for (const token of tokens) {
    if (token === "\n") {
      text += "\n";
    } else {
      if (text.length > 0 && !text.endsWith("\n")) text += " ";
      text += token;
    }
  }
  return text;
}

/** Extract display "words" from final string (split by any whitespace). */
function displayWords(displayString) {
  return displayString.split(/\s+/).filter(Boolean);
}

/**
 * Find concatenations: display words that equal two or more expected (space-fixed) tokens.
 * Compares tokens from format with vs without space-at-asterisks.
 * Returns array of { merged: "wordword", tokens: ["word","word"] }.
 */
function findConcatenationsFromExpected(actualTokens, expectedTokens) {
  const actualWords = actualTokens.filter((t) => t !== "\n");
  const expectedWords = expectedTokens.filter((t) => t !== "\n");
  const concats = [];
  let i = 0;
  let j = 0;
  while (j < actualWords.length) {
    const actual = actualWords[j];
    if (i >= expectedWords.length) {
      j++;
      continue;
    }
    if (actual === expectedWords[i]) {
      i++;
      j++;
      continue;
    }
    if (actual.startsWith(expectedWords[i])) {
      let built = expectedWords[i];
      let k = i;
      while (built.length < actual.length && k + 1 < expectedWords.length) {
        k++;
        built += expectedWords[k];
        if (built === actual) {
          concats.push({
            merged: actual,
            tokens: expectedWords.slice(i, k + 1),
          });
          i = k + 1;
          j++;
          break;
        }
      }
      if (built !== actual) {
        i++;
        j++;
      }
      continue;
    }
    i++;
    j++;
  }
  return concats;
}

async function fetchLiveResponse(query) {
  const baseUrl = process.env.OPENCLAW_GATEWAY_URL?.replace(/\/$/, "");
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  const agentId = process.env.OPENCLAW_AGENT_ID || "main";
  if (!baseUrl || !token) {
    console.error("Missing OPENCLAW_GATEWAY_URL or OPENCLAW_GATEWAY_TOKEN");
    process.exit(2);
  }
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
  let fullText = "";
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
          if (typeof chunk === "string" && chunk.length > 0) fullText += chunk;
        } else if (currentEvent === "response.output_text.done" && typeof data?.text === "string" && data.text.length > 0 && !fullText) {
          fullText = data.text;
        }
        currentEvent = "";
        currentData = "";
      }
    }
  }
  reader.releaseLock();
  return fullText;
}

function run(rawText) {
  const formattedWithFix = formatResponseText(rawText, true);
  const formattedNoFix = formatResponseText(rawText, false);
  const tokensWithFix = tokenize(formattedWithFix);
  const tokensNoFix = tokenize(formattedNoFix);
  const concatsFromStrip = findConcatenationsFromExpected(tokensNoFix, tokensWithFix);

  const textToShow = buildTextToShow(tokensWithFix);
  const viewportLines = wrapToViewport(textToShow, G1_LINE_CHARS, G1_MAX_LINES);
  const displayString = joinViewportLinesWithSpaces(viewportLines);
  const displayWordsList = displayWords(displayString);

  console.log("=== Formatted buffer (with space-at-* fix; what app uses) ===\n");
  console.log(formattedWithFix);
  console.log("\n=== If we did NOT add space when stripping * (simulated) ===\n");
  console.log(formattedNoFix);
  console.log("\n=== Tokens with fix (words + newlines) ===\n");
  console.log(JSON.stringify(tokensWithFix));
  console.log("\n=== Viewport lines (wrapped, max " + G1_MAX_LINES + " lines, " + G1_LINE_CHARS + " chars) ===\n");
  viewportLines.forEach((line, i) => console.log(`  ${i + 1}: "${line}"`));
  console.log("\n=== Text shown on glasses (joinViewportLinesWithSpaces) ===\n");
  console.log(displayString);
  console.log("\n=== Display words (split by whitespace) ===\n");
  console.log(JSON.stringify(displayWordsList));

  if (concatsFromStrip.length > 0) {
    console.log("\n=== CONCATENATIONS (would occur if * were stripped without adding space) ===\n");
    concatsFromStrip.forEach((c, i) => {
      console.log(`  ${i + 1}. "${c.merged}" = ${c.tokens.map((t) => `"${t}"`).join(" + ")}`);
    });
  } else {
    console.log("\n(No concatenation from asterisk stripping in this text.)");
  }
}

const args = process.argv.slice(2);
if (args[0] === "--live") {
  const query = args[1] || "Give me two short tips.";
  console.error("Fetching OpenClaw response for:", query);
  const raw = await fetchLiveResponse(query);
  if (!raw) {
    console.error("No response text.");
    process.exit(1);
  }
  run(raw);
} else {
  const text = args.length > 0 ? args.join(" ") : "Pick *one* priority. Work in *short* blocks. *Remove* friction.";
  run(text);
}
