/**
 * Transcript logging: append to transcripts/YYYY-MM-DD.md
 * Format: [HH:mm:ss] (normal|copilot) [SKIP|RELEVANT]? text
 */

import fs from "fs";
import path from "path";

const TRANSCRIPTS_DIR = "transcripts";

function getTodayPath(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return path.join(TRANSCRIPTS_DIR, `${y}-${m}-${d}.md`);
}

function ensureDir(): void {
  if (!fs.existsSync(TRANSCRIPTS_DIR)) {
    fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  }
}

export type TranscriptMode = "normal" | "copilot";
export type TranscriptTag = "SKIP" | "RELEVANT" | null;

/**
 * Append one line to today's transcript file.
 * Line format: [HH:mm:ss] (normal|copilot) [SKIP|RELEVANT]? text
 */
export function appendTranscript(
  mode: TranscriptMode,
  text: string,
  tag: TranscriptTag = null
): void {
  try {
    ensureDir();
    const now = new Date();
    const time = now.toTimeString().slice(0, 8);
    const tagPart = tag ? ` [${tag}]` : "";
    const line = `[${time}] (${mode})${tagPart} ${text.trim()}\n`;
    fs.appendFileSync(getTodayPath(), line);
  } catch (err) {
    console.error("[transcript-log] append failed:", err);
  }
}
