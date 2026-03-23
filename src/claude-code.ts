/**
 * Claude Code CLI client: Subprocess-based streaming for interactive queries.
 * Uses `claude --print [query]` and streams stdout chunks via callbacks.
 *
 * NOTE: Claude Code mode only works when the server runs LOCALLY because:
 * 1. It spawns the `claude` CLI which must be installed locally
 * 2. It uses Max subscription auth from `claude login`
 * 3. It needs access to local files for code assistance
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";

/**
 * Check if running in a container/cloud environment
 */
function isRunningInContainer(): boolean {
  const home = homedir();
  // Common indicators of container/cloud environments
  return (
    home === "/root" ||
    home === "/" ||
    existsSync("/.dockerenv") ||
    process.env.RAILWAY_ENVIRONMENT !== undefined ||
    process.env.KUBERNETES_SERVICE_HOST !== undefined ||
    process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined
  );
}

/** Cache the resolved claude CLI path */
let claudeCliPath: string | null = null;

/** Paths that were checked (for error reporting) */
let checkedPaths: string[] = [];

/**
 * Find the claude CLI path. Checks common locations and uses `which` as fallback.
 */
function getClaudeCliPath(): string {
  if (claudeCliPath) return claudeCliPath;

  const home = homedir();
  checkedPaths = [];
  console.log(`[ClaudeCode] Looking for CLI, HOME=${home}`);

  // Common installation paths
  const commonPaths = [
    `${home}/.npm-packages/bin/claude`,
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
    `${home}/.local/bin/claude`,
    `${home}/.bun/bin/claude`,
    `${home}/.nvm/current/bin/claude`,
  ];

  // Check common paths first
  for (const p of commonPaths) {
    checkedPaths.push(p);
    console.log(`[ClaudeCode] Checking: ${p} -> ${existsSync(p) ? "EXISTS" : "not found"}`);
    if (existsSync(p)) {
      console.log(`[ClaudeCode] Found at: ${p}`);
      claudeCliPath = p;
      return p;
    }
  }

  // Fall back to `which` command with full PATH
  try {
    const shellPath = process.env.PATH || "/usr/local/bin:/usr/bin:/bin";
    const extendedPath = `${home}/.npm-packages/bin:${home}/.bun/bin:/opt/homebrew/bin:${shellPath}`;
    console.log(`[ClaudeCode] Running 'which claude' with PATH=${extendedPath.slice(0, 100)}...`);
    const result = execSync("which claude", {
      encoding: "utf-8",
      env: { ...process.env, PATH: extendedPath }
    }).trim();
    if (result) {
      console.log(`[ClaudeCode] Found via which: ${result}`);
      claudeCliPath = result;
      return result;
    }
  } catch (err) {
    console.log(`[ClaudeCode] 'which claude' failed`);
  }

  // Not found
  console.error("[ClaudeCode] CLI not found. Checked:", checkedPaths);
  throw new Error(`CLI not found. HOME=${home}. Checked: ${checkedPaths.slice(0, 3).join(", ")}`);
}

/** Get the last checked paths for error reporting */
export function getCheckedPaths(): string[] {
  return checkedPaths;
}

/** Get home directory for error reporting */
export function getHomeDir(): string {
  return homedir();
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

    // Check if running in container - Claude Code only works locally
    if (isRunningInContainer()) {
      const home = homedir();
      console.error(`[ClaudeCode] Running in container (HOME=${home}). Claude Code requires local server.`);
      safeCallback(callbacks.onFailed)(
        new Error("Code mode requires local server. Say 'open' for cloud mode.")
      );
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
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error("[ClaudeCode] Failed to find claude CLI:", errMsg);
        safeCallback(callbacks.onFailed)(new Error(errMsg));
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
