/**
 * Agent Deployment Module
 * Supports deploying:
 * - Cursor Cloud Agents (via Cursor Background Agents API)
 * - Claude Code Agents (via Claude Agent SDK)
 */

export interface CursorAgentConfig {
  apiKey: string;
  baseUrl?: string;
}

export interface ClaudeAgentConfig {
  apiKey: string;
  model?: string;
}

export interface AgentDeployRequest {
  type: "cursor" | "claude";
  prompt: string;
  repository?: string; // For Cursor: GitHub repo URL
  branch?: string; // For Cursor: target branch
  autoCreatePr?: boolean; // For Cursor: auto-create PR when done
  workingDirectory?: string; // For Claude: working directory
  allowedTools?: string[]; // For Claude: tools to allow
}

export interface AgentDeployResult {
  success: boolean;
  agentId?: string;
  status?: string;
  error?: string;
  details?: Record<string, unknown>;
}

export interface CursorAgentStatus {
  id: string;
  name: string;
  status: "CREATING" | "RUNNING" | "FINISHED" | "FAILED";
  summary?: string;
  prUrl?: string;
  createdAt: string;
}

// Load config from environment
export function getCursorConfigFromEnv(): CursorAgentConfig | null {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: process.env.CURSOR_API_URL || "https://api.cursor.com/v0",
  };
}

export function getClaudeAgentConfigFromEnv(): ClaudeAgentConfig | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    model: process.env.CLAUDE_AGENT_MODEL || "claude-sonnet-4-20250514",
  };
}

/**
 * Deploy a Cursor Cloud Agent
 * API Docs: https://cursor.com/docs/cloud-agent/api/endpoints
 */
export async function deployCursorAgent(
  config: CursorAgentConfig,
  request: AgentDeployRequest
): Promise<AgentDeployResult> {
  if (!request.repository) {
    return { success: false, error: "Repository URL required for Cursor agents" };
  }

  const url = `${config.baseUrl}/agents`;
  const body = {
    prompt: { text: request.prompt },
    source: {
      repository: request.repository,
      ...(request.branch && { ref: request.branch }),
    },
    target: {
      autoCreatePr: request.autoCreatePr ?? true,
      ...(request.branch && { branchName: `agent/${Date.now()}` }),
    },
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(config.apiKey + ":").toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[CursorAgent] HTTP ${response.status}: ${errorText.slice(0, 200)}`);
      return {
        success: false,
        error: `Cursor API error: ${response.status} - ${errorText.slice(0, 100)}`,
      };
    }

    const data = (await response.json()) as CursorAgentStatus;
    console.log(`[CursorAgent] Deployed: ${data.id} status=${data.status}`);

    return {
      success: true,
      agentId: data.id,
      status: data.status,
      details: data as unknown as Record<string, unknown>,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[CursorAgent] Deploy failed: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Get Cursor agent status
 */
export async function getCursorAgentStatus(
  config: CursorAgentConfig,
  agentId: string
): Promise<AgentDeployResult> {
  const url = `${config.baseUrl}/agents/${agentId}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Basic ${Buffer.from(config.apiKey + ":").toString("base64")}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `Cursor API error: ${response.status} - ${errorText.slice(0, 100)}`,
      };
    }

    const data = (await response.json()) as CursorAgentStatus;
    return {
      success: true,
      agentId: data.id,
      status: data.status,
      details: data as unknown as Record<string, unknown>,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

/**
 * List Cursor agents
 */
export async function listCursorAgents(
  config: CursorAgentConfig,
  limit = 10
): Promise<{ success: boolean; agents?: CursorAgentStatus[]; error?: string }> {
  const url = `${config.baseUrl}/agents?limit=${limit}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Basic ${Buffer.from(config.apiKey + ":").toString("base64")}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `Cursor API error: ${response.status} - ${errorText.slice(0, 100)}`,
      };
    }

    const data = (await response.json()) as { agents: CursorAgentStatus[] };
    return { success: true, agents: data.agents };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

/**
 * Deploy a Claude Agent using the Claude Agent SDK
 * This spawns a subprocess running the claude agent
 */
export async function deployClaudeAgent(
  config: ClaudeAgentConfig,
  request: AgentDeployRequest
): Promise<AgentDeployResult> {
  // For Claude Agent SDK, we need to spawn a subprocess
  // The SDK is designed to be used via CLI or programmatically
  const { spawn } = await import("child_process");

  const workDir = request.workingDirectory || process.cwd();
  const tools = request.allowedTools || ["Read", "Edit", "Bash", "Glob", "Grep"];

  // Build the claude command with proper arguments
  const args = [
    "--print", // Non-interactive mode
    "--dangerously-skip-permissions", // Skip permission prompts for automation
    "--allowedTools", tools.join(","),
    request.prompt,
  ];

  return new Promise((resolve) => {
    const agentId = `claude-${Date.now()}`;
    let output = "";
    let errorOutput = "";

    console.log(`[ClaudeAgent] Spawning: claude ${args.slice(0, 3).join(" ")}...`);

    const child = spawn("claude", args, {
      cwd: workDir,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: config.apiKey,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout?.on("data", (data) => {
      output += data.toString();
    });

    child.stderr?.on("data", (data) => {
      errorOutput += data.toString();
    });

    // Set a timeout for long-running agents
    const timeout = setTimeout(() => {
      console.log(`[ClaudeAgent] ${agentId} still running after 60s, detaching`);
      child.unref();
      resolve({
        success: true,
        agentId,
        status: "RUNNING",
        details: { message: "Agent running in background", partialOutput: output.slice(-500) },
      });
    }, 60000);

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        console.log(`[ClaudeAgent] ${agentId} completed successfully`);
        resolve({
          success: true,
          agentId,
          status: "FINISHED",
          details: { output: output.slice(-1000) },
        });
      } else {
        console.error(`[ClaudeAgent] ${agentId} failed with code ${code}`);
        resolve({
          success: false,
          agentId,
          status: "FAILED",
          error: errorOutput.slice(-500) || `Process exited with code ${code}`,
        });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      console.error(`[ClaudeAgent] Spawn error: ${err.message}`);
      resolve({
        success: false,
        error: `Failed to spawn Claude agent: ${err.message}. Is claude CLI installed?`,
      });
    });
  });
}

/**
 * Deploy an agent based on type
 */
export async function deployAgent(request: AgentDeployRequest): Promise<AgentDeployResult> {
  if (request.type === "cursor") {
    const config = getCursorConfigFromEnv();
    if (!config) {
      return { success: false, error: "CURSOR_API_KEY not configured" };
    }
    return deployCursorAgent(config, request);
  } else if (request.type === "claude") {
    const config = getClaudeAgentConfigFromEnv();
    if (!config) {
      return { success: false, error: "ANTHROPIC_API_KEY not configured" };
    }
    return deployClaudeAgent(config, request);
  } else {
    return { success: false, error: `Unknown agent type: ${request.type}` };
  }
}

/**
 * Parse voice command to determine agent deployment
 * Examples:
 * - "cursor agent fix the login bug"
 * - "cursor fix the login bug"
 * - "deploy cursor to add dark mode"
 * - "claude agent refactor the auth module"
 * - "claude fix tests"
 * - "run claude code to fix tests"
 */
export function parseAgentCommand(
  transcript: string
): { isAgentCommand: boolean; request?: AgentDeployRequest } {
  const lower = transcript.toLowerCase().trim();

  // Cursor agent patterns - more flexible matching
  const cursorPatterns = [
    /^(?:hey\s+)?(?:cursor\s+agent|deploy\s+cursor|cursor\s+cloud|background\s+agent|cloud\s+agent)\s+(?:to\s+)?(.+)/i,
    /^(?:hey\s+)?cursor\s+(?:please\s+)?(?:can\s+you\s+)?(.+)/i,
    /^(?:use|run|send|start)\s+cursor\s+(?:to\s+)?(.+)/i,
    /^(?:have\s+)?cursor\s+(?:go\s+)?(?:and\s+)?(.+)/i,
  ];

  // Claude agent patterns - more flexible matching
  const claudePatterns = [
    /^(?:hey\s+)?(?:claude\s+(?:code\s+)?agent|deploy\s+claude|run\s+claude(?:\s+code)?)\s+(?:to\s+)?(.+)/i,
    /^(?:hey\s+)?claude\s+(?:code\s+)?(?:please\s+)?(?:can\s+you\s+)?(.+)/i,
    /^(?:use|run|send|start)\s+claude(?:\s+code)?\s+(?:to\s+)?(.+)/i,
    /^(?:have\s+)?claude(?:\s+code)?\s+(?:go\s+)?(?:and\s+)?(.+)/i,
  ];

  for (const pattern of cursorPatterns) {
    const match = lower.match(pattern);
    if (match && match[1].length > 3) {
      // Clean up the prompt - remove leading "to", "and", "please"
      let prompt = match[1].trim().replace(/^(?:to|and|please)\s+/i, "");
      return {
        isAgentCommand: true,
        request: {
          type: "cursor",
          prompt,
          autoCreatePr: true,
        },
      };
    }
  }

  for (const pattern of claudePatterns) {
    const match = lower.match(pattern);
    if (match && match[1].length > 3) {
      // Clean up the prompt
      let prompt = match[1].trim().replace(/^(?:to|and|please)\s+/i, "");
      return {
        isAgentCommand: true,
        request: {
          type: "claude",
          prompt,
          allowedTools: ["Read", "Edit", "Bash", "Glob", "Grep", "Write"],
        },
      };
    }
  }

  return { isAgentCommand: false };
}

/**
 * Check which agent services are configured
 */
export function getAgentStatus(): {
  cursor: { configured: boolean; apiKey?: string };
  claude: { configured: boolean };
} {
  const cursorConfig = getCursorConfigFromEnv();
  const claudeConfig = getClaudeAgentConfigFromEnv();

  return {
    cursor: {
      configured: !!cursorConfig,
      apiKey: cursorConfig?.apiKey ? `${cursorConfig.apiKey.slice(0, 8)}...` : undefined,
    },
    claude: {
      configured: !!claudeConfig,
    },
  };
}
