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

  it("returns null when ANTHROPIC_API_KEY is missing", () => {
    const config = getClaudeCodeConfigFromEnv();
    expect(config).toBeNull();
  });

  it("returns config with defaults when ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-key";

    const config = getClaudeCodeConfigFromEnv();
    expect(config).not.toBeNull();
    expect(config!.apiKey).toBe("sk-test-key");
    expect(config!.model).toBe("claude-sonnet-4-20250514");
    expect(config!.workingDirectory).toBe(process.cwd());
  });

  it("uses CLAUDE_CODE_MODEL when provided", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-key";
    process.env.CLAUDE_CODE_MODEL = "claude-opus-4-5-20251101";

    const config = getClaudeCodeConfigFromEnv();
    expect(config).not.toBeNull();
    expect(config!.model).toBe("claude-opus-4-5-20251101");
  });

  it("uses CLAUDE_CODE_WORKING_DIR when provided", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-key";
    process.env.CLAUDE_CODE_WORKING_DIR = "/custom/path";

    const config = getClaudeCodeConfigFromEnv();
    expect(config).not.toBeNull();
    expect(config!.workingDirectory).toBe("/custom/path");
  });
});
