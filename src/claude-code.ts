/**
 * Claude Code CLI client: Subprocess-based streaming for interactive queries.
 * Uses `claude --print [query]` and streams stdout chunks via callbacks.
 */

import { execSync } from "child_process";

/** Cache the resolved claude CLI path */
let claudeCliPath: string | null = null;

/**
 * Find the claude CLI path. Checks common locations and uses `which` as fallback.
 */
function getClaudeCliPath(): string {
  if (claudeCliPath) return claudeCliPath;

  // Common installation paths
  const commonPaths = [
    process.env.HOME + "/.npm-packages/bin/claude",
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
    process.env.HOME + "/.local/bin/claude",
  ];

  // Check common paths first
  const { existsSync } = require("fs");
  for (const p of commonPaths) {
    if (existsSync(p)) {
      claudeCliPath = p;
      return p;
    }
  }

  // Fall back to `which` command
  try {
    const result = execSync("which claude", { encoding: "utf-8" }).trim();
    if (result) {
      claudeCliPath = result;
      return result;
    }
  } catch {
    // which failed
  }

  // Last resort: hope it's in PATH
  claudeCliPath = "claude";
  return "claude";
}

export interface ClaudeCodeConfig {
  apiKey: string;
  model?: string;
  workingDirectory?: string;
}

export interface ClaudeCodeCallbacks {
  onDelta?: (text: string) => void;
  onDone?: () => void;
  onCompleted?: () => void;
  onFailed?: (error: unknown) => void;
}

/**
 * Load Claude Code config from environment.
 * Returns config even without API key (CLI can use Max subscription auth).
 */
export function getClaudeCodeConfigFromEnv(): ClaudeCodeConfig {
  return {
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: process.env.CLAUDE_CODE_MODEL || "claude-sonnet-4-20250514",
    workingDirectory: process.env.CLAUDE_CODE_WORKING_DIR || process.cwd(),
  };
}

/**
 * Stream Claude Code response via subprocess.
 * Spawns `claude --print [query]` and streams stdout chunks via callbacks.
 */
export async function streamClaudeCodeResponse(
  config: ClaudeCodeConfig,
  userMessage: string,
  callbacks: ClaudeCodeCallbacks,
  options?: { systemPrompt?: string }
): Promise<void> {
  // Safe callback wrapper to prevent crashes
  const safeCallback = <T extends unknown[]>(fn: ((...args: T) => void) | undefined) => {
    return (...args: T) => {
      try {
        fn?.(...args);
      } catch (err) {
        console.error("[ClaudeCode] Callback error:", err);
      }
    };
  };

  try {
    // Test mode for development/testing
    if (process.env.CLAUDE_CODE_TEST_MODE === "1") {
      const chunks = [
        "This is a test response from Claude Code mode.",
        " It demonstrates streaming output from the CLI.",
      ];
      for (const chunk of chunks) {
        safeCallback(callbacks.onDelta)(chunk);
      }
      safeCallback(callbacks.onDone)();
      safeCallback(callbacks.onCompleted)();
      return;
    }

    const { spawn } = await import("child_process");

    // Build the claude command with proper arguments
    // Use -p for non-interactive output (short form)
    const args = ["-p", userMessage];

    const workDir = config.workingDirectory || process.cwd();
    const timeoutMs = 60000; // 60s timeout for interactive use

    console.log(`[ClaudeCode] Spawning: claude -p "${userMessage.slice(0, 50)}..."`);

    return new Promise((resolve) => {
      let hasCompleted = false;
      let output = "";
      let errorOutput = "";

      // Only pass API key if set, otherwise CLI uses Max subscription auth
      const env = { ...process.env };
      if (config.apiKey) {
        env.ANTHROPIC_API_KEY = config.apiKey;
      }

      let claudePath: string;
      try {
        claudePath = getClaudeCliPath();
        console.log(`[ClaudeCode] Using CLI at: ${claudePath}`);
      } catch (err) {
        console.error("[ClaudeCode] Failed to find claude CLI:", err);
        safeCallback(callbacks.onFailed)(new Error("Claude CLI not found"));
        resolve();
        return;
      }

      let child;
      try {
        child = spawn(claudePath, args, {
          cwd: workDir,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        console.error("[ClaudeCode] Failed to spawn:", err);
        safeCallback(callbacks.onFailed)(new Error(`Failed to spawn: ${err}`));
        resolve();
        return;
      }

      // Close stdin immediately - CLI doesn't need input
      child.stdin?.end();

      // Set timeout for interactive queries
      const timeout = setTimeout(() => {
        if (!hasCompleted) {
          hasCompleted = true;
          try {
            child.kill("SIGTERM");
          } catch {}
          console.log(`[ClaudeCode] Request timed out after ${timeoutMs / 1000}s`);
          safeCallback(callbacks.onFailed)(new Error(`Request timed out after ${timeoutMs / 1000}s`));
          resolve();
        }
      }, timeoutMs);

      // Stream stdout chunks
      child.stdout?.on("data", (data: Buffer) => {
        try {
          const chunk = data.toString();
          output += chunk;
          safeCallback(callbacks.onDelta)(chunk);
        } catch (err) {
          console.error("[ClaudeCode] Error processing stdout:", err);
        }
      });

      child.stderr?.on("data", (data: Buffer) => {
        try {
          errorOutput += data.toString();
          console.log(`[ClaudeCode] stderr: ${data.toString().slice(0, 100)}`);
        } catch {}
      });

      child.on("close", (code) => {
        clearTimeout(timeout);
        if (hasCompleted) return;
        hasCompleted = true;

        if (code === 0) {
          console.log(`[ClaudeCode] Completed successfully`);
          safeCallback(callbacks.onDone)();
          safeCallback(callbacks.onCompleted)();
        } else {
          const errMsg = errorOutput.slice(-200) || output.slice(-200) || `Process exited with code ${code}`;
          console.error(`[ClaudeCode] Failed with code ${code}: ${errMsg}`);
          safeCallback(callbacks.onFailed)(new Error(errMsg));
        }
        resolve();
      });

      child.on("error", (err) => {
        clearTimeout(timeout);
        if (hasCompleted) return;
        hasCompleted = true;

        console.error(`[ClaudeCode] Spawn error: ${err.message}`);
        safeCallback(callbacks.onFailed)(
          new Error(`Failed to spawn Claude CLI: ${err.message}. Is claude CLI installed?`)
        );
        resolve();
      });
    });
  } catch (err) {
    console.error("[ClaudeCode] Unexpected error:", err);
    safeCallback(callbacks.onFailed)(new Error(`Unexpected error: ${err}`));
  }
}
