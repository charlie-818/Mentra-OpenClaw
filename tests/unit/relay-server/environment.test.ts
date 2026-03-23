import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildSpawnEnv, getFullPath } from "../../../src/relay-utils.js";

const ORIGINAL_ENV = { ...process.env };

describe("buildSpawnEnv", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns an object", () => {
    const env = buildSpawnEnv();
    expect(typeof env).toBe("object");
    expect(env).not.toBeNull();
  });

  it("includes extended PATH", () => {
    const env = buildSpawnEnv();
    expect(env.PATH).toBe(getFullPath());
  });

  it("removes ANTHROPIC_API_KEY if present", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-key";
    const env = buildSpawnEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("preserves other environment variables", () => {
    process.env.MY_CUSTOM_VAR = "custom-value";
    const env = buildSpawnEnv();
    expect(env.MY_CUSTOM_VAR).toBe("custom-value");
  });

  it("preserves HOME", () => {
    const env = buildSpawnEnv();
    expect(env.HOME).toBe(process.env.HOME);
  });

  it("preserves USER", () => {
    const env = buildSpawnEnv();
    expect(env.USER).toBe(process.env.USER);
  });

  it("does not include ANTHROPIC_API_KEY even when not set", () => {
    delete process.env.ANTHROPIC_API_KEY;
    const env = buildSpawnEnv();
    expect("ANTHROPIC_API_KEY" in env).toBe(false);
  });
});

describe("environment variable handling", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("full PATH starts with node bin dir", () => {
    const env = buildSpawnEnv();
    const firstPathEntry = env.PATH?.split(":")[0];
    // Should be the directory containing node
    expect(firstPathEntry).toContain("/");
    expect(process.execPath).toContain(firstPathEntry!);
  });

  it("env is a fresh object, not a reference", () => {
    const env1 = buildSpawnEnv();
    const env2 = buildSpawnEnv();
    expect(env1).not.toBe(env2);
    expect(env1).not.toBe(process.env);
  });

  it("modifying returned env does not affect process.env", () => {
    const originalPath = process.env.PATH;
    const env = buildSpawnEnv();
    env.PATH = "/modified/path";
    expect(process.env.PATH).toBe(originalPath);
  });
});
