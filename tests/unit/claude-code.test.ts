import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getClaudeCodeConfigFromEnv } from "../../src/claude-code.js";

const ORIGINAL_ENV = { ...process.env };

describe("getClaudeCodeConfigFromEnv", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_MODEL;
    delete process.env.CLAUDE_CODE_WORKING_DIR;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns config with empty apiKey when ANTHROPIC_API_KEY is missing (uses Max subscription)", () => {
    const config = getClaudeCodeConfigFromEnv();
    expect(config).not.toBeNull();
    expect(config.apiKey).toBe("");
    expect(config.model).toBe("claude-sonnet-4-20250514");
    expect(config.workingDirectory).toBe(process.cwd());
  });

  it("returns config with API key when ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-key";

    const config = getClaudeCodeConfigFromEnv();
    expect(config.apiKey).toBe("sk-test-key");
    expect(config.model).toBe("claude-sonnet-4-20250514");
    expect(config.workingDirectory).toBe(process.cwd());
  });

  it("uses CLAUDE_CODE_MODEL when provided", () => {
    process.env.CLAUDE_CODE_MODEL = "claude-opus-4-5-20251101";

    const config = getClaudeCodeConfigFromEnv();
    expect(config.model).toBe("claude-opus-4-5-20251101");
  });

  it("uses CLAUDE_CODE_WORKING_DIR when provided", () => {
    process.env.CLAUDE_CODE_WORKING_DIR = "/custom/path";

    const config = getClaudeCodeConfigFromEnv();
    expect(config.workingDirectory).toBe("/custom/path");
  });
});
