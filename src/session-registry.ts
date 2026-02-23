/**
 * Registry of active Mentra sessions for Push API and debug.
 * Sessions register on connect and unregister on disconnect.
 */

import type { AppSession } from "@mentra/sdk";

export type SessionStateLabel =
  | "IDLE"
  | "LISTENING"
  | "DICTATING"
  | "SENDING"
  | "STREAMING";

export interface SessionEntry {
  session: AppSession;
  sessionId: string;
  userId: string;
  /** Current state; mutated by session handler */
  state: SessionStateLabel;
  /** Copilot mode on/off; mutated by session handler */
  copilot: boolean;
  /** Last time we received a final transcript (ms since epoch); mutated by session handler */
  lastTranscriptAt: number | null;
  /** Copilot pipeline stats; mutated by session handler */
  copilotPipeline: {
    totalFiltered: number;
    totalPassed: number;
    bufferSize: number;
    inflight: boolean;
  };
  /** Optional: called by Push API POST /mic to toggle listening */
  requestListening?(listening: boolean): void;
}

const sessions = new Map<string, SessionEntry>();

export function register(entry: SessionEntry): void {
  sessions.set(entry.sessionId, entry);
}

export function unregister(sessionId: string): void {
  sessions.delete(sessionId);
}

export function get(sessionId: string): SessionEntry | undefined {
  return sessions.get(sessionId);
}

export function getAll(): SessionEntry[] {
  return Array.from(sessions.values());
}

export function getFirst(): SessionEntry | undefined {
  return sessions.values().next().value;
}
