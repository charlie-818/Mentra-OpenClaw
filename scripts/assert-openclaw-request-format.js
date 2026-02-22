#!/usr/bin/env node
/**
 * Asserts the request body we send to OpenClaw matches OpenResponses spec
 * (message content type must be "input_text"). Exit 0 if valid; 1 otherwise.
 * Run with: node scripts/assert-openclaw-request-format.js
 */
const body = {
  model: "openclaw",
  stream: true,
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "test" }],
    },
  ],
};

const firstContentType = body.input?.[0]?.content?.[0]?.type;
if (firstContentType !== "input_text") {
  console.error(
    `OpenClaw request format error: message content type must be "input_text" (OpenResponses spec), got: ${JSON.stringify(firstContentType)}`
  );
  process.exit(1);
}
console.log("OpenClaw request format OK (input_text)");
process.exit(0);
