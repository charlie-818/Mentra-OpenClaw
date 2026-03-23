/**
 * Relay Server Utilities
 *
 * Testable, extracted functions for PATH construction, CLI discovery, and diagnostics.
 * Helps debug ENOENT errors from spawn when node or CLI isn't in PATH.
 */

import { homedir } from "os";
import { existsSync, accessSync, constants, readFileSync, realpathSync } from "fs";
import { dirname, resolve } from "path";

export interface PathDiagnostics {
  nodeBinDir: string;
  nodeExecPath: string;
  homedir: string;
  extraPaths: string[];
  originalPath: string;
  fullPath: string;
}

export interface CliDiagnostics {
  found: boolean;
  path: string | null;
  realPath: string | null;
  executable: boolean;
  shebang: string | null;
  shebangTarget: string | null;
  shebangTargetExists: boolean;
  searchedPaths: string[];
}

export interface SpawnPreflight {
  canSpawn: boolean;
  issues: string[];
  cli: CliDiagnostics;
  path: PathDiagnostics;
  nodeInPath: boolean;
}

/**
 * Get node binary directory from process.execPath
 */
export function getNodeBinDir(): string {
  return dirname(process.execPath);
}

/**
 * Build full PATH that includes node's directory and common CLI locations.
 * Critical: node's directory must be in PATH for shebang resolution to work.
 */
export function getFullPath(): string {
  const home = homedir();
  const nodeBinDir = getNodeBinDir();
  const extraPaths = [
    nodeBinDir, // Critical: node must be in PATH for shebang to work
    `${home}/.npm-packages/bin`,
    `${home}/.bun/bin`,
    "/usr/local/bin",
    "/opt/homebrew/bin",
    `${home}/.local/bin`,
  ];
  return [...extraPaths, process.env.PATH || ""].join(":");
}

/**
 * Get extra paths that are prepended to PATH
 */
export function getExtraPaths(): string[] {
  const home = homedir();
  const nodeBinDir = getNodeBinDir();
  return [
    nodeBinDir,
    `${home}/.npm-packages/bin`,
    `${home}/.bun/bin`,
    "/usr/local/bin",
    "/opt/homebrew/bin",
    `${home}/.local/bin`,
  ];
}

/**
 * Find the Claude CLI path by checking common locations.
 * Throws if not found.
 */
export function getClaudeCliPath(): string {
  const paths = getCliSearchPaths();

  for (const p of paths) {
    if (existsSync(p)) return p;
  }

  throw new Error(`Claude CLI not found. Searched: ${paths.join(", ")}`);
}

/**
 * Get list of paths to search for Claude CLI
 */
export function getCliSearchPaths(): string[] {
  const home = homedir();
  return [
    `${home}/.npm-packages/bin/claude`,
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
    `${home}/.local/bin/claude`,
    `${home}/.bun/bin/claude`,
  ];
}

/**
 * Check if a file is executable
 */
export function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract shebang line from a file
 */
export function getShebang(path: string): string | null {
  try {
    const content = readFileSync(path, "utf-8");
    const firstLine = content.split("\n")[0];
    if (firstLine.startsWith("#!")) {
      return firstLine.slice(2).trim();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Parse shebang to get the target executable
 * e.g., "/usr/bin/env node" -> "node"
 * e.g., "/usr/local/bin/node" -> "/usr/local/bin/node"
 */
export function parseShebangTarget(shebang: string): string | null {
  if (!shebang) return null;

  // Handle "/usr/bin/env <cmd>" pattern
  if (shebang.includes("/env ")) {
    const parts = shebang.split(/\s+/);
    return parts[parts.length - 1] || null;
  }

  // Direct path like "/usr/local/bin/node"
  return shebang.split(/\s+/)[0] || null;
}

/**
 * Check if a command exists in PATH
 */
export function commandExistsInPath(cmd: string, pathEnv: string): boolean {
  if (cmd.startsWith("/")) {
    // Absolute path
    return existsSync(cmd);
  }

  const dirs = pathEnv.split(":");
  for (const dir of dirs) {
    if (dir && existsSync(resolve(dir, cmd))) {
      return true;
    }
  }
  return false;
}

/**
 * Get PATH diagnostics
 */
export function getPathDiagnostics(): PathDiagnostics {
  const nodeBinDir = getNodeBinDir();
  const extraPaths = getExtraPaths();
  const originalPath = process.env.PATH || "";

  return {
    nodeBinDir,
    nodeExecPath: process.execPath,
    homedir: homedir(),
    extraPaths,
    originalPath,
    fullPath: getFullPath(),
  };
}

/**
 * Get CLI diagnostics
 */
export function getCliDiagnostics(): CliDiagnostics {
  const searchedPaths = getCliSearchPaths();
  let path: string | null = null;

  try {
    path = getClaudeCliPath();
  } catch {
    return {
      found: false,
      path: null,
      realPath: null,
      executable: false,
      shebang: null,
      shebangTarget: null,
      shebangTargetExists: false,
      searchedPaths,
    };
  }

  let realPath: string | null = null;
  try {
    realPath = realpathSync(path);
  } catch {
    // Symlink resolution failed
  }

  const executable = isExecutable(path);
  const shebangPath = realPath || path;
  const shebang = getShebang(shebangPath);
  const shebangTarget = shebang ? parseShebangTarget(shebang) : null;

  // Check if shebang target exists (considering PATH for relative commands like "node")
  let shebangTargetExists = false;
  if (shebangTarget) {
    shebangTargetExists = commandExistsInPath(shebangTarget, getFullPath());
  }

  return {
    found: true,
    path,
    realPath,
    executable,
    shebang,
    shebangTarget,
    shebangTargetExists,
    searchedPaths,
  };
}

/**
 * Run preflight checks before spawning
 */
export function runSpawnPreflight(): SpawnPreflight {
  const issues: string[] = [];
  const pathDiag = getPathDiagnostics();
  const cliDiag = getCliDiagnostics();

  // Check if node is in the constructed PATH
  const nodeInPath = commandExistsInPath("node", pathDiag.fullPath);

  if (!cliDiag.found) {
    issues.push("Claude CLI not found in any expected location");
  }

  if (cliDiag.found && !cliDiag.executable) {
    issues.push(`CLI at ${cliDiag.path} is not executable`);
  }

  if (!nodeInPath) {
    issues.push("node binary not found in PATH - shebang will fail");
  }

  if (cliDiag.shebangTarget && !cliDiag.shebangTargetExists) {
    issues.push(`Shebang target '${cliDiag.shebangTarget}' not found in PATH`);
  }

  return {
    canSpawn: issues.length === 0,
    issues,
    cli: cliDiag,
    path: pathDiag,
    nodeInPath,
  };
}

/**
 * Build environment for spawning CLI
 * Includes extended PATH and removes ANTHROPIC_API_KEY
 */
export function buildSpawnEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: getFullPath() };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

/**
 * Format preflight results for logging
 */
export function formatPreflightReport(preflight: SpawnPreflight): string {
  const lines: string[] = [
    "=== Spawn Preflight Report ===",
    "",
    `Can spawn: ${preflight.canSpawn ? "YES" : "NO"}`,
  ];

  if (preflight.issues.length > 0) {
    lines.push("");
    lines.push("Issues:");
    for (const issue of preflight.issues) {
      lines.push(`  - ${issue}`);
    }
  }

  lines.push("");
  lines.push("PATH Info:");
  lines.push(`  Node binary dir: ${preflight.path.nodeBinDir}`);
  lines.push(`  Node exec path: ${preflight.path.nodeExecPath}`);
  lines.push(`  Node in PATH: ${preflight.nodeInPath ? "YES" : "NO"}`);

  lines.push("");
  lines.push("CLI Info:");
  lines.push(`  Found: ${preflight.cli.found ? "YES" : "NO"}`);
  if (preflight.cli.found) {
    lines.push(`  Path: ${preflight.cli.path}`);
    lines.push(`  Real path: ${preflight.cli.realPath}`);
    lines.push(`  Executable: ${preflight.cli.executable ? "YES" : "NO"}`);
    lines.push(`  Shebang: ${preflight.cli.shebang || "(none)"}`);
    lines.push(`  Shebang target: ${preflight.cli.shebangTarget || "(none)"}`);
    lines.push(`  Shebang target exists: ${preflight.cli.shebangTargetExists ? "YES" : "NO"}`);
  } else {
    lines.push(`  Searched paths:`);
    for (const p of preflight.cli.searchedPaths) {
      lines.push(`    - ${p}`);
    }
  }

  lines.push("");
  lines.push("Extra paths prepended to PATH:");
  for (const p of preflight.path.extraPaths) {
    const exists = existsSync(p);
    lines.push(`  ${exists ? "✓" : "✗"} ${p}`);
  }

  return lines.join("\n");
}
