#!/usr/bin/env node
/**
 * Test the delta processing logic to verify word boundaries are preserved correctly.
 * Simulates the onDelta callback behavior.
 */

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

/**
 * Simulates the FIXED onDelta logic with pendingSpace tracking
 */
function processDeltasFixed(deltas) {
  let responseBuffer = "";
  let pendingSpace = false;

  for (const delta of deltas) {
    // Detect word boundary BEFORE any trimming: space at end of buffer OR start of delta OR pending from previous whitespace-only delta
    const bufferHadTrailingSpace = /\s$/.test(responseBuffer);
    const deltaHasLeadingSpace = /^\s/.test(delta);
    const needsSpace = pendingSpace || bufferHadTrailingSpace || deltaHasLeadingSpace;

    // Normalize: remove trailing space from buffer
    responseBuffer = responseBuffer.replace(/\s+$/, "");

    // Contraction handling
    if (delta.startsWith("'")) {
      pendingSpace = false;
      responseBuffer += delta;
      responseBuffer = formatResponseText(responseBuffer);
      continue;
    }

    const deltaTrimmed = delta.replace(/^\s+/, "");
    if (deltaTrimmed.length === 0) {
      // Whitespace-only delta: remember to add space before next content
      pendingSpace = true;
      responseBuffer = formatResponseText(responseBuffer);
      continue;
    }

    // Only add space if the original stream had whitespace at the boundary
    if (responseBuffer.length > 0 && needsSpace) {
      responseBuffer += " ";
    }
    pendingSpace = false;
    responseBuffer += deltaTrimmed;
    responseBuffer = formatResponseText(responseBuffer);
  }

  return responseBuffer;
}

/**
 * Simulates the OLD (buggy) onDelta logic
 */
function processDeltasOld(deltas) {
  let responseBuffer = "";

  for (const delta of deltas) {
    // Normalize: no trailing space on buffer
    responseBuffer = responseBuffer.replace(/\s+$/, "");

    // Contraction handling
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

    // OLD BUG: Always add space when buffer has content
    if (responseBuffer.length > 0) {
      responseBuffer += " ";
    }
    responseBuffer += deltaTrimmed;
    responseBuffer = formatResponseText(responseBuffer);
  }

  return responseBuffer;
}

// Test cases - matching real OpenClaw stream behavior where spaces are at START of deltas
const testCases = [
  {
    name: "OpenClaw split word",
    deltas: ["Open", "Cl", "aw", " is", " great"],
    expected: "OpenClaw is great"
  },
  {
    name: "Multiple split words (BridgeHex)",
    deltas: ["Bridge", "Hex", " says", " hel", "lo"],
    expected: "BridgeHex says hello"
  },
  {
    name: "Real OpenClaw stream pattern",
    deltas: ["Hello", " world", " how", " are", " you"],
    expected: "Hello world how are you"
  },
  {
    name: "Contractions",
    deltas: ["don", "'t", " worry"],
    expected: "don't worry"
  },
  {
    name: "Mixed: split + spaced (real OpenClaw)",
    deltas: ["Open", "Cl", "aw", " is", " an", " open", "‑", "source", " AI"],
    expected: "OpenClaw is an open‑source AI"
  },
  {
    name: "Suffix merging (calmly)",
    deltas: ["Stay", " calm", " ly"],
    expected: "Stay calmly"
  },
  {
    name: "Single word continuation",
    deltas: ["a", "b", "c", "d", "e"],
    expected: "abcde"
  },
  {
    name: "Whitespace-only deltas",
    deltas: ["Hello", " ", "world"],
    expected: "Hello world"
  },
  {
    name: "Multiple spaces normalized",
    deltas: ["Hello", "  ", "world"],
    expected: "Hello world"
  },
  {
    name: "Real stream: self-hosted",
    deltas: [" self", "‑", "host", "ed", " AI"],
    expected: "self‑hosted AI"
  }
];

console.log("=== Testing Delta Processing Logic ===\n");

let allPassed = true;

for (const tc of testCases) {
  const fixedResult = processDeltasFixed(tc.deltas);
  const oldResult = processDeltasOld(tc.deltas);
  const passed = fixedResult === tc.expected;

  console.log(`Test: ${tc.name}`);
  console.log(`  Deltas: ${JSON.stringify(tc.deltas)}`);
  console.log(`  Expected: "${tc.expected}"`);
  console.log(`  FIXED:    "${fixedResult}" ${passed ? "✓" : "✗ FAIL"}`);
  console.log(`  OLD:      "${oldResult}" ${oldResult === tc.expected ? "✓" : "✗ (buggy)"}`);
  console.log();

  if (!passed) {
    allPassed = false;
  }
}

if (allPassed) {
  console.log("=== All tests passed! ===");
  process.exit(0);
} else {
  console.log("=== Some tests failed! ===");
  process.exit(1);
}
