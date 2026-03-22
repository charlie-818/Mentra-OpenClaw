/**
 * Push API and debug routes (same port as webhook).
 * Auth: if PUSH_TOKEN is set, require Bearer or ?token= for write/read.
 */

import type { Request, Response } from "express";
import * as registry from "./session-registry.js";
import { getOpenClawConfigFromEnv } from "./openclaw.js";
import { getClaudeCodeConfigFromEnv } from "./claude-code.js";
import {
  deployAgent,
  getAgentStatus,
  getCursorConfigFromEnv,
  getCursorAgentStatus,
  listCursorAgents,
  type AgentDeployRequest,
} from "./agent-deploy.js";

const PUSH_TOKEN = process.env.PUSH_TOKEN;

function checkAuth(req: Request): boolean {
  if (!PUSH_TOKEN) return true;
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const query = typeof req.query.token === "string" ? req.query.token : undefined;
  return bearer === PUSH_TOKEN || query === PUSH_TOKEN;
}

function jsonOk(res: Response, data: object): void {
  res.status(200).json(data);
}

function jsonErr(res: Response, status: number, message: string): void {
  res.status(status).json({ ok: false, error: message });
}

/** POST /push — show text on glasses */
export function handlePush(req: Request, res: Response): void {
  if (!checkAuth(req)) {
    jsonErr(res, 401, "Unauthorized");
    return;
  }
  const body = req.body as { text?: string; duration?: number };
  const text = typeof body?.text === "string" ? body.text : " ";
  const durationMs = typeof body?.duration === "number" ? body.duration : 10000;
  const entry = registry.getFirst();
  if (!entry) {
    jsonOk(res, { ok: false, error: "No active session" });
    return;
  }
  if (entry.showPushText) {
    entry.showPushText(text, durationMs);
  } else {
    entry.session.layouts.showTextWall(text, { durationMs });
  }
  jsonOk(res, { ok: true });
}

/** POST /push-bitmap — stub (SDK bitmap support TBD) */
export function handlePushBitmap(req: Request, res: Response): void {
  if (!checkAuth(req)) {
    jsonErr(res, 401, "Unauthorized");
    return;
  }
  jsonOk(res, { ok: false, error: "Bitmap push not supported yet" });
}

/** POST /mic — toggle listening (idle <-> listening) for first session */
export function handleMic(req: Request, res: Response): void {
  if (!checkAuth(req)) {
    jsonErr(res, 401, "Unauthorized");
    return;
  }
  const entry = registry.getFirst();
  if (!entry) {
    jsonOk(res, { ok: false, error: "No active session" });
    return;
  }
  const currentlyListening =
    entry.state === "LISTENING" || entry.state === "DICTATING";
  const nextListening = !currentlyListening;
  entry.requestListening?.(nextListening);
  jsonOk(res, { ok: true, listening: nextListening });
}

/** POST /copilot — toggle copilot for first session */
export function handleCopilotPost(req: Request, res: Response): void {
  if (!checkAuth(req)) {
    jsonErr(res, 401, "Unauthorized");
    return;
  }
  const entry = registry.getFirst();
  if (!entry) {
    jsonOk(res, { ok: false, error: "No active session" });
    return;
  }
  const body = req.body as { copilot?: boolean } | undefined;
  if (typeof body?.copilot === "boolean") {
    entry.copilot = body.copilot;
  } else {
    entry.copilot = !entry.copilot;
  }
  jsonOk(res, { ok: true, sessions: registry.getAll().length, copilot: entry.copilot });
}

/** GET /copilot — get copilot status */
export function handleCopilotGet(req: Request, res: Response): void {
  if (!checkAuth(req)) {
    jsonErr(res, 401, "Unauthorized");
    return;
  }
  const entry = registry.getFirst();
  jsonOk(res, {
    ok: true,
    sessions: registry.getAll().length,
    copilot: entry?.copilot ?? false,
  });
}

/** POST /mode — set AI mode (openclaw or claude) */
export function handleModePost(req: Request, res: Response): void {
  if (!checkAuth(req)) {
    jsonErr(res, 401, "Unauthorized");
    return;
  }
  const entry = registry.getFirst();
  if (!entry) {
    jsonOk(res, { ok: false, error: "No active session" });
    return;
  }
  const body = req.body as { mode?: string } | undefined;
  const requestedMode = body?.mode?.toLowerCase();
  if (requestedMode === "claude" || requestedMode === "openclaw") {
    entry.aiMode = requestedMode;
  } else if (requestedMode === "toggle") {
    entry.aiMode = entry.aiMode === "openclaw" ? "claude" : "openclaw";
  } else {
    jsonErr(res, 400, "mode must be 'openclaw', 'claude', or 'toggle'");
    return;
  }
  jsonOk(res, { ok: true, sessions: registry.getAll().length, aiMode: entry.aiMode });
}

/** GET /mode — get current AI mode */
export function handleModeGet(req: Request, res: Response): void {
  if (!checkAuth(req)) {
    jsonErr(res, 401, "Unauthorized");
    return;
  }
  const entry = registry.getFirst();
  const openclaw = !!getOpenClawConfigFromEnv();
  const claudeCode = !!getClaudeCodeConfigFromEnv();
  jsonOk(res, {
    ok: true,
    sessions: registry.getAll().length,
    aiMode: entry?.aiMode ?? "openclaw",
    available: {
      openclaw,
      claudeCode,
    },
  });
}

/** GET /status */
export function handleStatus(req: Request, res: Response): void {
  if (!checkAuth(req)) {
    jsonErr(res, 401, "Unauthorized");
    return;
  }
  const entries = registry.getAll();
  const first = entries[0];
  const openclaw = !!getOpenClawConfigFromEnv();
  const claudeCode = !!getClaudeCodeConfigFromEnv();
  jsonOk(res, {
    ok: true,
    openclaw,
    claudeCode,
    aiMode: first?.aiMode ?? "openclaw",
    sessions: entries.length,
    listening:
      first?.state === "LISTENING" || first?.state === "DICTATING" || false,
    copilot: first?.copilot ?? false,
  });
}

/** GET /debug */
export function handleDebug(req: Request, res: Response): void {
  if (!checkAuth(req)) {
    jsonErr(res, 401, "Unauthorized");
    return;
  }
  const openclaw = !!getOpenClawConfigFromEnv();
  const claudeCode = !!getClaudeCodeConfigFromEnv();
  const sessions: Record<string, object> = {};
  for (const e of registry.getAll()) {
    const lastAgo =
      e.lastTranscriptAt != null
        ? `${Math.round((Date.now() - e.lastTranscriptAt) / 1000)}s`
        : null;
    sessions[e.sessionId] = {
      listening: e.state === "LISTENING" || e.state === "DICTATING",
      copilot: e.copilot,
      aiMode: e.aiMode,
      lastTranscriptAgo: lastAgo,
      copilotPipeline: e.copilotPipeline,
    };
  }
  jsonOk(res, {
    ok: true,
    openclaw,
    claudeCode,
    totalSessions: registry.getAll().length,
    sessions,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Agent Deployment Endpoints
// ════════════════════════════════════════════════════════════════════════════

/** GET /agents/status — check which agent services are configured */
export function handleAgentsStatus(req: Request, res: Response): void {
  if (!checkAuth(req)) {
    jsonErr(res, 401, "Unauthorized");
    return;
  }
  const status = getAgentStatus();
  jsonOk(res, { ok: true, agents: status });
}

/** POST /agents/deploy — deploy a Cursor or Claude agent */
export async function handleAgentDeploy(req: Request, res: Response): Promise<void> {
  if (!checkAuth(req)) {
    jsonErr(res, 401, "Unauthorized");
    return;
  }

  const body = req.body as Partial<AgentDeployRequest>;

  // Validate required fields
  if (!body.type || !["cursor", "claude"].includes(body.type)) {
    jsonErr(res, 400, "type must be 'cursor' or 'claude'");
    return;
  }
  if (!body.prompt || typeof body.prompt !== "string") {
    jsonErr(res, 400, "prompt is required");
    return;
  }

  // For Cursor agents, repository is required
  if (body.type === "cursor" && !body.repository) {
    jsonErr(res, 400, "repository URL required for Cursor agents");
    return;
  }

  const request: AgentDeployRequest = {
    type: body.type,
    prompt: body.prompt,
    repository: body.repository,
    branch: body.branch,
    autoCreatePr: body.autoCreatePr ?? true,
    workingDirectory: body.workingDirectory,
    allowedTools: body.allowedTools,
  };

  // Show status on glasses if session available
  const entry = registry.getFirst();
  if (entry) {
    const agentType = body.type === "cursor" ? "Cursor" : "Claude";
    entry.session.layouts.showTextWall(`Deploying ${agentType} agent...`, { durationMs: 5000 });
  }

  try {
    const result = await deployAgent(request);

    if (result.success && entry) {
      const statusMsg = result.status === "RUNNING" ? "Agent running" : "Agent deployed";
      entry.session.layouts.showTextWall(`${statusMsg}: ${result.agentId?.slice(-8) || "OK"}`, {
        durationMs: 5000,
      });
    } else if (!result.success && entry) {
      entry.session.layouts.showTextWall(`Deploy failed: ${result.error?.slice(0, 40)}`, {
        durationMs: 5000,
      });
    }

    if (result.success) {
      jsonOk(res, {
        ok: true,
        agentId: result.agentId,
        status: result.status,
        details: result.details,
      });
    } else {
      jsonErr(res, 500, result.error || "Deployment failed");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[AgentDeploy] Error: ${message}`);
    jsonErr(res, 500, message);
  }
}

/** GET /agents/cursor — list Cursor agents */
export async function handleCursorAgentsList(req: Request, res: Response): Promise<void> {
  if (!checkAuth(req)) {
    jsonErr(res, 401, "Unauthorized");
    return;
  }

  const config = getCursorConfigFromEnv();
  if (!config) {
    jsonErr(res, 503, "CURSOR_API_KEY not configured");
    return;
  }

  const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 10;

  try {
    const result = await listCursorAgents(config, limit);
    if (result.success) {
      jsonOk(res, { ok: true, agents: result.agents });
    } else {
      jsonErr(res, 500, result.error || "Failed to list agents");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    jsonErr(res, 500, message);
  }
}

/** GET /agents/cursor/:id — get Cursor agent status */
export async function handleCursorAgentStatus(req: Request, res: Response): Promise<void> {
  if (!checkAuth(req)) {
    jsonErr(res, 401, "Unauthorized");
    return;
  }

  const config = getCursorConfigFromEnv();
  if (!config) {
    jsonErr(res, 503, "CURSOR_API_KEY not configured");
    return;
  }

  const agentId = typeof req.params.id === "string" ? req.params.id : req.params.id?.[0];
  if (!agentId) {
    jsonErr(res, 400, "Agent ID required");
    return;
  }

  try {
    const result = await getCursorAgentStatus(config, agentId);
    if (result.success) {
      jsonOk(res, {
        ok: true,
        agentId: result.agentId,
        status: result.status,
        details: result.details,
      });
    } else {
      jsonErr(res, 500, result.error || "Failed to get agent status");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    jsonErr(res, 500, message);
  }
}
