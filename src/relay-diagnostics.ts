#!/usr/bin/env node
/**
 * Relay Diagnostics CLI
 *
 * Run with: npm run relay:diagnose
 *
 * Shows diagnostic information about the relay server's ability to spawn
 * the Claude CLI, helping debug ENOENT and PATH issues.
 */

import { spawn } from "child_process";
import {
  runSpawnPreflight,
  formatPreflightReport,
  getClaudeCliPath,
  buildSpawnEnv,
} from "./relay-utils.js";

const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};

function colorize(text: string, color: keyof typeof COLORS): string {
  // Disable colors if not a TTY
  if (!process.stdout.isTTY) return text;
  return `${COLORS[color]}${text}${COLORS.reset}`;
}

async function testSpawn(): Promise<{ success: boolean; output: string; error: string }> {
  return new Promise((resolve) => {
    try {
      const cliPath = getClaudeCliPath();
      const env = buildSpawnEnv();

      const child = spawn(cliPath, ["--version"], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10000,
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("error", (err) => {
        resolve({
          success: false,
          output: stdout,
          error: err.message,
        });
      });

      child.on("close", (code) => {
        resolve({
          success: code === 0,
          output: stdout.trim(),
          error: stderr.trim(),
        });
      });

      // Timeout
      setTimeout(() => {
        child.kill();
        resolve({
          success: false,
          output: stdout,
          error: "Timeout after 10 seconds",
        });
      }, 10000);
    } catch (err) {
      resolve({
        success: false,
        output: "",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

async function main() {
  console.log(colorize("\n=== Claude Relay Diagnostics ===\n", "cyan"));

  // Run preflight checks
  console.log(colorize("Running preflight checks...\n", "dim"));
  const preflight = runSpawnPreflight();
  console.log(formatPreflightReport(preflight));

  // Test actual spawn
  console.log(colorize("\n=== Spawn Test ===\n", "cyan"));
  console.log("Testing spawn with 'claude --version'...\n");

  const spawnResult = await testSpawn();

  if (spawnResult.success) {
    console.log(colorize("✓ Spawn succeeded!", "green"));
    console.log(`  Output: ${spawnResult.output}`);
  } else {
    console.log(colorize("✗ Spawn failed!", "red"));
    console.log(`  Error: ${spawnResult.error}`);
    if (spawnResult.output) {
      console.log(`  Output: ${spawnResult.output}`);
    }
  }

  // Summary
  console.log(colorize("\n=== Summary ===\n", "cyan"));

  const allGood = preflight.canSpawn && spawnResult.success;

  if (allGood) {
    console.log(colorize("✓ All checks passed! Relay should work correctly.", "green"));
  } else {
    console.log(colorize("✗ Issues detected. Review the report above.", "red"));

    if (!preflight.nodeInPath) {
      console.log(colorize("\nTip: Node binary directory not in PATH.", "yellow"));
      console.log(`  Node is at: ${process.execPath}`);
      console.log(`  Add this to PATH: ${preflight.path.nodeBinDir}`);
    }

    if (!preflight.cli.found) {
      console.log(colorize("\nTip: Claude CLI not found.", "yellow"));
      console.log("  Install with: npm install -g @anthropic-ai/claude-code");
    }
  }

  console.log();
  process.exit(allGood ? 0 : 1);
}

main().catch((err) => {
  console.error("Diagnostics failed:", err);
  process.exit(1);
});
