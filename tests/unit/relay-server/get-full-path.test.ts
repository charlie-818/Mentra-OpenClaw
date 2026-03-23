import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir } from "os";
import { dirname } from "path";
import { getFullPath, getExtraPaths, getNodeBinDir } from "../../../src/relay-utils.js";

const ORIGINAL_ENV = { ...process.env };

describe("getNodeBinDir", () => {
  it("returns directory containing node binary", () => {
    const nodeBinDir = getNodeBinDir();
    expect(nodeBinDir).toBe(dirname(process.execPath));
    expect(nodeBinDir).not.toContain("node");
    expect(typeof nodeBinDir).toBe("string");
  });
});

describe("getExtraPaths", () => {
  it("includes node binary directory first", () => {
    const extraPaths = getExtraPaths();
    expect(extraPaths[0]).toBe(dirname(process.execPath));
  });

  it("includes npm-packages bin", () => {
    const extraPaths = getExtraPaths();
    expect(extraPaths).toContain(`${homedir()}/.npm-packages/bin`);
  });

  it("includes common CLI locations", () => {
    const extraPaths = getExtraPaths();
    expect(extraPaths).toContain("/usr/local/bin");
    expect(extraPaths).toContain("/opt/homebrew/bin");
  });

  it("includes bun bin", () => {
    const extraPaths = getExtraPaths();
    expect(extraPaths).toContain(`${homedir()}/.bun/bin`);
  });

  it("includes local bin", () => {
    const extraPaths = getExtraPaths();
    expect(extraPaths).toContain(`${homedir()}/.local/bin`);
  });
});

describe("getFullPath", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("starts with node binary directory", () => {
    const fullPath = getFullPath();
    const firstEntry = fullPath.split(":")[0];
    expect(firstEntry).toBe(dirname(process.execPath));
  });

  it("includes original PATH at the end", () => {
    process.env.PATH = "/original/path:/another/path";
    const fullPath = getFullPath();
    expect(fullPath).toContain("/original/path");
    expect(fullPath).toContain("/another/path");
    expect(fullPath.endsWith(process.env.PATH)).toBe(true);
  });

  it("handles empty PATH gracefully", () => {
    delete process.env.PATH;
    const fullPath = getFullPath();
    expect(typeof fullPath).toBe("string");
    expect(fullPath.length).toBeGreaterThan(0);
    expect(fullPath.startsWith(dirname(process.execPath))).toBe(true);
  });

  it("includes all extra paths before original PATH", () => {
    process.env.PATH = "/original/path";
    const fullPath = getFullPath();
    const extraPaths = getExtraPaths();

    const pathParts = fullPath.split(":");
    for (let i = 0; i < extraPaths.length; i++) {
      expect(pathParts[i]).toBe(extraPaths[i]);
    }
  });

  it("colon-separates path entries", () => {
    const fullPath = getFullPath();
    expect(fullPath).toContain(":");
    const parts = fullPath.split(":");
    expect(parts.length).toBeGreaterThan(1);
    // No empty entries at the start
    expect(parts[0]).not.toBe("");
  });
});
