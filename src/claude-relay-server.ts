/**
 * Local Claude Code Relay Server
 *
 * Runs on your local Mac and exposes Claude Code CLI via HTTP.
 * The Railway-deployed glasses app connects to this via a tunnel (ngrok/Cloudflare).
 *
 * Usage:
 *   npx tsx src/claude-relay-server.ts
 *
 * Then expose via tunnel:
 *   ngrok http 3456
 *   # or
 *   cloudflared tunnel --url http://localhost:3456
 *
 * Set CLAUDE_RELAY_URL in Railway to the tunnel URL.
 */

import { createServer, IncomingMessage, ServerResponse } from "http";
import { spawn } from "child_process";
import { homedir } from "os";
import { existsSync, realpathSync } from "fs";

const PORT = parseInt(process.env.CLAUDE_RELAY_PORT || "3456", 10);
const AUTH_TOKEN = process.env.CLAUDE_RELAY_TOKEN || "";

/** Find claude CLI path and return [executable, args] for spawn */
function getClaudeCommand(): [string, string[]] {
  const home = homedir();
  const paths = [
    `${home}/.npm-packages/bin/claude`,
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
    `${home}/.local/bin/claude`,
    `${home}/.bun/bin/claude`,
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      // Use node directly to avoid shebang/env issues
      const nodePath = process.execPath; // Current node binary
      const realPath = realpathSync(p);
      console.log(`[Relay] Found CLI at ${p} -> ${realPath}`);
      return [nodePath, [realPath]];
    }
  }

  throw new Error("Claude CLI not found");
}

/** Find claude CLI path (for health check) */
function getClaudeCliPath(): string {
  const home = homedir();
  const paths = [
    `${home}/.npm-packages/bin/claude`,
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
    `${home}/.local/bin/claude`,
    `${home}/.bun/bin/claude`,
  ];

  for (const p of paths) {
    if (existsSync(p)) return p;
  }

  throw new Error("Claude CLI not found");
}

/** Handle streaming Claude Code request */
async function handleQuery(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Check auth
  if (AUTH_TOKEN) {
    const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (auth !== AUTH_TOKEN) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
  }

  // Parse request body
  let body = "";
  for await (const chunk of req) {
    body += chunk;
  }

  let query: string;
  let workingDir: string | undefined;

  try {
    const parsed = JSON.parse(body);
    query = parsed.query;
    workingDir = parsed.workingDir;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  if (!query || typeof query !== "string") {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "query is required" }));
    return;
  }

  console.log(`[Relay] Query: "${query.slice(0, 50)}..."`);

  // Set up SSE streaming
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  try {
    const [executable, baseArgs] = getClaudeCommand();
    const args = [...baseArgs, "-p", query];
    console.log(`[Relay] Spawning: ${executable} ${args.join(" ").slice(0, 80)}...`);

    // Remove ANTHROPIC_API_KEY so Claude uses Max subscription instead of API credits
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    const child = spawn(executable, args, {
      cwd: workingDir || process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdin?.end();

    child.on("error", (err) => {
      console.error(`[Relay] Spawn error: ${err.message}`);
      res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`);
      res.end();
    });

    child.stdout?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      res.write(`data: ${JSON.stringify({ type: "delta", text: chunk })}\n\n`);
    });

    child.stderr?.on("data", (data: Buffer) => {
      console.log(`[Relay] stderr: ${data.toString().slice(0, 100)}`);
    });

    child.on("close", (code) => {
      if (code === 0) {
        res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ type: "error", error: `Exit code ${code}` })}\n\n`);
      }
      res.end();
    });

    child.on("error", (err) => {
      res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`);
      res.end();
    });

    // Timeout after 60s
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {}
      res.write(`data: ${JSON.stringify({ type: "error", error: "Timeout" })}\n\n`);
      res.end();
    }, 60000);

    child.on("close", () => clearTimeout(timeout));

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.write(`data: ${JSON.stringify({ type: "error", error: message })}\n\n`);
    res.end();
  }
}

/** Health check endpoint */
function handleHealth(res: ServerResponse): void {
  try {
    getClaudeCliPath();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, cli: "found" }));
  } catch (err) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "CLI not found" }));
  }
}

/** Main HTTP handler */
function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  // CORS headers for cross-origin requests
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/health" && req.method === "GET") {
    handleHealth(res);
    return;
  }

  if (url.pathname === "/query" && req.method === "POST") {
    handleQuery(req, res).catch((err) => {
      console.error("[Relay] Error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

// Start server
const server = createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`[Claude Relay] Server running on http://localhost:${PORT}`);
  console.log(`[Claude Relay] Endpoints:`);
  console.log(`  GET  /health - Check CLI status`);
  console.log(`  POST /query  - Stream Claude Code response`);
  console.log();
  console.log(`[Claude Relay] Expose via tunnel:`);
  console.log(`  ngrok http ${PORT}`);
  console.log(`  cloudflared tunnel --url http://localhost:${PORT}`);
  console.log();
  if (AUTH_TOKEN) {
    console.log(`[Claude Relay] Auth enabled (CLAUDE_RELAY_TOKEN set)`);
  } else {
    console.log(`[Claude Relay] WARNING: No auth token set. Set CLAUDE_RELAY_TOKEN for security.`);
  }
});
