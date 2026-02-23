/**
 * Push API and debug routes (same port as webhook).
 * Auth: if PUSH_TOKEN is set, require Bearer or ?token= for write/read.
 */

import type { Request, Response } from "express";
import * as registry from "./session-registry.js";
import { getOpenClawConfigFromEnv } from "./openclaw.js";

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

/** GET /status */
export function handleStatus(req: Request, res: Response): void {
  if (!checkAuth(req)) {
    jsonErr(res, 401, "Unauthorized");
    return;
  }
  const entries = registry.getAll();
  const first = entries[0];
  const openclaw = !!getOpenClawConfigFromEnv();
  jsonOk(res, {
    ok: true,
    openclaw,
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
  const sessions: Record<string, object> = {};
  for (const e of registry.getAll()) {
    const lastAgo =
      e.lastTranscriptAt != null
        ? `${Math.round((Date.now() - e.lastTranscriptAt) / 1000)}s`
        : null;
    sessions[e.sessionId] = {
      listening: e.state === "LISTENING" || e.state === "DICTATING",
      copilot: e.copilot,
      lastTranscriptAgo: lastAgo,
      copilotPipeline: e.copilotPipeline,
    };
  }
  jsonOk(res, {
    ok: true,
    openclaw,
    totalSessions: registry.getAll().length,
    sessions,
  });
}
