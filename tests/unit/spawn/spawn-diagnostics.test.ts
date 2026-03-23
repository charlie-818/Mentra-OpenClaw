import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  runSpawnPreflight,
  getPathDiagnostics,
  getCliDiagnostics,
  formatPreflightReport,
} from "../../../src/relay-utils.js";
import { dirname } from "path";

const ORIGINAL_ENV = { ...process.env };

describe("getPathDiagnostics", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns diagnostics object with required fields", () => {
    const diag = getPathDiagnostics();

    expect(diag).toHaveProperty("nodeBinDir");
    expect(diag).toHaveProperty("nodeExecPath");
    expect(diag).toHaveProperty("homedir");
    expect(diag).toHaveProperty("extraPaths");
    expect(diag).toHaveProperty("originalPath");
    expect(diag).toHaveProperty("fullPath");
  });

  it("nodeBinDir matches dirname of process.execPath", () => {
    const diag = getPathDiagnostics();
    expect(diag.nodeBinDir).toBe(dirname(process.execPath));
  });

  it("nodeExecPath matches process.execPath", () => {
    const diag = getPathDiagnostics();
    expect(diag.nodeExecPath).toBe(process.execPath);
  });

  it("extraPaths is an array", () => {
    const diag = getPathDiagnostics();
    expect(Array.isArray(diag.extraPaths)).toBe(true);
    expect(diag.extraPaths.length).toBeGreaterThan(0);
  });

  it("originalPath matches process.env.PATH", () => {
    process.env.PATH = "/test/path";
    const diag = getPathDiagnostics();
    expect(diag.originalPath).toBe("/test/path");
  });

  it("handles missing PATH", () => {
    delete process.env.PATH;
    const diag = getPathDiagnostics();
    expect(diag.originalPath).toBe("");
  });
});

describe("getCliDiagnostics", () => {
  it("returns diagnostics object with required fields", () => {
    const diag = getCliDiagnostics();

    expect(diag).toHaveProperty("found");
    expect(diag).toHaveProperty("path");
    expect(diag).toHaveProperty("realPath");
    expect(diag).toHaveProperty("executable");
    expect(diag).toHaveProperty("shebang");
    expect(diag).toHaveProperty("shebangTarget");
    expect(diag).toHaveProperty("shebangTargetExists");
    expect(diag).toHaveProperty("searchedPaths");
  });

  it("searchedPaths is an array", () => {
    const diag = getCliDiagnostics();
    expect(Array.isArray(diag.searchedPaths)).toBe(true);
    expect(diag.searchedPaths.length).toBeGreaterThan(0);
  });

  it("found is a boolean", () => {
    const diag = getCliDiagnostics();
    expect(typeof diag.found).toBe("boolean");
  });

  it("when CLI not found, path is null", () => {
    const diag = getCliDiagnostics();
    if (!diag.found) {
      expect(diag.path).toBeNull();
      expect(diag.realPath).toBeNull();
    }
  });

  it("when CLI found, path is a string", () => {
    const diag = getCliDiagnostics();
    if (diag.found) {
      expect(typeof diag.path).toBe("string");
      expect(diag.path).toContain("claude");
    }
  });
});

describe("runSpawnPreflight", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns preflight object with required fields", () => {
    const preflight = runSpawnPreflight();

    expect(preflight).toHaveProperty("canSpawn");
    expect(preflight).toHaveProperty("issues");
    expect(preflight).toHaveProperty("cli");
    expect(preflight).toHaveProperty("path");
    expect(preflight).toHaveProperty("nodeInPath");
  });

  it("canSpawn is a boolean", () => {
    const preflight = runSpawnPreflight();
    expect(typeof preflight.canSpawn).toBe("boolean");
  });

  it("issues is an array", () => {
    const preflight = runSpawnPreflight();
    expect(Array.isArray(preflight.issues)).toBe(true);
  });

  it("nodeInPath is true when node is accessible", () => {
    const preflight = runSpawnPreflight();
    // Since we're running this test with node, node should be in PATH
    expect(preflight.nodeInPath).toBe(true);
  });

  it("includes CLI diagnostics", () => {
    const preflight = runSpawnPreflight();
    expect(preflight.cli).toHaveProperty("found");
    expect(preflight.cli).toHaveProperty("searchedPaths");
  });

  it("includes PATH diagnostics", () => {
    const preflight = runSpawnPreflight();
    expect(preflight.path).toHaveProperty("nodeBinDir");
    expect(preflight.path).toHaveProperty("fullPath");
  });

  it("canSpawn is false if CLI not found", () => {
    const preflight = runSpawnPreflight();
    if (!preflight.cli.found) {
      expect(preflight.canSpawn).toBe(false);
      expect(preflight.issues.length).toBeGreaterThan(0);
    }
  });

  it("issues contains message when CLI not found", () => {
    const preflight = runSpawnPreflight();
    if (!preflight.cli.found) {
      expect(preflight.issues.some((i) => i.includes("not found"))).toBe(true);
    }
  });
});

describe("formatPreflightReport", () => {
  it("returns a string", () => {
    const preflight = runSpawnPreflight();
    const report = formatPreflightReport(preflight);
    expect(typeof report).toBe("string");
  });

  it("includes spawn status", () => {
    const preflight = runSpawnPreflight();
    const report = formatPreflightReport(preflight);
    expect(report).toContain("Can spawn:");
    expect(report).toMatch(/Can spawn: (YES|NO)/);
  });

  it("includes PATH info section", () => {
    const preflight = runSpawnPreflight();
    const report = formatPreflightReport(preflight);
    expect(report).toContain("PATH Info:");
    expect(report).toContain("Node binary dir:");
  });

  it("includes CLI info section", () => {
    const preflight = runSpawnPreflight();
    const report = formatPreflightReport(preflight);
    expect(report).toContain("CLI Info:");
    expect(report).toContain("Found:");
  });

  it("includes extra paths section", () => {
    const preflight = runSpawnPreflight();
    const report = formatPreflightReport(preflight);
    expect(report).toContain("Extra paths prepended to PATH:");
  });

  it("shows issues when present", () => {
    const preflight = runSpawnPreflight();
    const report = formatPreflightReport(preflight);
    if (preflight.issues.length > 0) {
      expect(report).toContain("Issues:");
    }
  });

  it("shows searched paths when CLI not found", () => {
    const preflight = runSpawnPreflight();
    const report = formatPreflightReport(preflight);
    if (!preflight.cli.found) {
      expect(report).toContain("Searched paths:");
    }
  });
});
