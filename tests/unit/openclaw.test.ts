import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getOpenClawConfigFromEnv } from "../../src/openclaw.js";

const ORIGINAL_ENV = { ...process.env };

describe("getOpenClawConfigFromEnv", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.OPENCLAW_GATEWAY_URL;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_AGENT_ID;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns null when URL is missing", () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "token";
    const config = getOpenClawConfigFromEnv();
    expect(config).toBeNull();
  });

  it("returns null when token is missing", () => {
    process.env.OPENCLAW_GATEWAY_URL = "https://example.com";
    const config = getOpenClawConfigFromEnv();
    expect(config).toBeNull();
  });

  it("returns config with default agent id when both URL and token are set", () => {
    process.env.OPENCLAW_GATEWAY_URL = "https://example.com";
    process.env.OPENCLAW_GATEWAY_TOKEN = "token";

    const config = getOpenClawConfigFromEnv();
    expect(config).not.toBeNull();
    expect(config!.baseUrl).toBe("https://example.com");
    expect(config!.token).toBe("token");
    expect(config!.agentId).toBe("main");
  });

  it("uses OPENCLAW_AGENT_ID when provided", () => {
    process.env.OPENCLAW_GATEWAY_URL = "https://example.com";
    process.env.OPENCLAW_GATEWAY_TOKEN = "token";
    process.env.OPENCLAW_AGENT_ID = "custom-agent";

    const config = getOpenClawConfigFromEnv();
    expect(config).not.toBeNull();
    expect(config!.agentId).toBe("custom-agent");
  });
});

