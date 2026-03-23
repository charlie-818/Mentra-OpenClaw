/**
 * Claude Code CLI client: Subprocess-based streaming for interactive queries.
 * Uses `claude --print [query]` and streams stdout chunks via callbacks.
 *
 * Two modes of operation:
 * 1. LOCAL: Spawns `claude` CLI directly (requires local server)
 * 2. RELAY: Connects to a remote relay server via CLAUDE_RELAY_URL
 *
 * For Railway deployment, run the relay server locally and expose via tunnel:
 *   npx tsx src/claude-relay-server.ts
 *   ngrok http 3456
 *   # Set CLAUDE_RELAY_URL=https://xxx.ngrok.io in Railway
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
  /** Relay server URL (e.g., https://xxx.ngrok.io). If set, uses HTTP relay instead of local CLI. */
  relayUrl?: string;
  /** Auth token for relay server */
  relayToken?: string;
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
 *
 * For relay mode (Railway deployment), set:
 *   CLAUDE_RELAY_URL=https://xxx.ngrok.io
 *   CLAUDE_RELAY_TOKEN=your_secret_token (optional but recommended)
 */
export function getClaudeCodeConfigFromEnv(): ClaudeCodeConfig {
  return {
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: process.env.CLAUDE_CODE_MODEL || "claude-sonnet-4-20250514",
    workingDirectory: process.env.CLAUDE_CODE_WORKING_DIR || process.cwd(),
    relayUrl: process.env.CLAUDE_RELAY_URL,
    relayToken: process.env.CLAUDE_RELAY_TOKEN,
  };
}

/**
 * Stream Claude Code response via relay server (SSE).
 */
async function streamViaRelay(
  config: ClaudeCodeConfig,
  userMessage: string,
  callbacks: ClaudeCodeCallbacks,
  safeCallback: <T extends unknown[]>(fn: ((...args: T) => void) | undefined) => (...args: T) => void
): Promise<void> {
  const relayUrl = config.relayUrl!;
  console.log(`[ClaudeCode] Using relay: ${relayUrl}`);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.relayToken) {
      headers["Authorization"] = `Bearer ${config.relayToken}`;
    }

    const response = await fetch(`${relayUrl}/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: userMessage,
        workingDir: config.workingDirectory,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Relay error ${response.status}: ${text}`);
    }

    if (!response.body) {
      throw new Error("No response body from relay");
    }

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === "delta" && data.text) {
              safeCallback(callbacks.onDelta)(data.text);
            } else if (data.type === "done") {
              safeCallback(callbacks.onDone)();
              safeCallback(callbacks.onCompleted)();
            } else if (data.type === "error") {
              throw new Error(data.error || "Relay error");
            }
          } catch (parseErr) {
            // Skip malformed SSE lines
          }
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ClaudeCode] Relay error: ${message}`);
    safeCallback(callbacks.onFailed)(new Error(message));
  }
}

/**
 * Stream Claude Code response via subprocess or relay.
 * If CLAUDE_RELAY_URL is set, uses HTTP relay; otherwise spawns local CLI.
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

    // Use relay if configured (for Railway/cloud deployment)
    if (config.relayUrl) {
      await streamViaRelay(config, userMessage, callbacks, safeCallback);
      return;
    }

    // Check if running in container - Claude Code only works locally without relay
    if (isRunningInContainer()) {
      const home = homedir();
      console.error(`[ClaudeCode] Running in container (HOME=${home}). Set CLAUDE_RELAY_URL or use local server.`);
      safeCallback(callbacks.onFailed)(
        new Error("Code mode requires relay or local server. Say 'open' for cloud mode.")
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
