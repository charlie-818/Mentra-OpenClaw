import "dotenv/config";
import { AppServer, AppSession } from "@mentra/sdk";
import {
  getOpenClawConfigFromEnv,
  streamOpenClawResponse,
} from "./openclaw.js";

const PACKAGE_NAME = process.env.PACKAGE_NAME ?? "com.example.mentra-openclaw-bridge";
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY;

/** Throttle display updates to respect Mentra ~1 update per 200ms. */
const DISPLAY_THROTTLE_MS = 250;

/** Max characters to keep in the in-memory transcript log. */
const TRANSCRIPT_LOG_MAX_CHARS = 2000;
/** Max characters to show on the glasses (tail of log so newest is visible). */
const TRANSCRIPT_DISPLAY_MAX_CHARS = 500;

/** Trigger phrases (longer first so "jarvis" matches before "mac"). From env OPENCLAW_TRIGGER_WORDS (comma-separated) or default. */
const TRIGGER_WORDS: string[] = (() => {
  const raw = process.env.OPENCLAW_TRIGGER_WORDS ?? "mac,jarvis,send,execute";
  const list = raw.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
  return list.length > 0 ? list.sort((a, b) => b.length - a.length) : ["mac", "jarvis", "send", "execute"];
})();

/** Phrases that clear the transcript from view (e.g. "clear"). From env OPENCLAW_CLEAR_WORDS (comma-separated) or default. */
const CLEAR_WORDS: string[] = (() => {
  const raw = process.env.OPENCLAW_CLEAR_WORDS ?? "clear";
  return raw.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
})();

if (!MENTRAOS_API_KEY) {
  console.error("MENTRAOS_API_KEY environment variable is required");
  process.exit(1);
}

/**
 * OpenClawBridgeServer – MentraOS app that connects Even G1 glasses to OpenClaw.
 * Voice (final transcription) → OpenClaw; streaming response → TextWall (throttled).
 */
class OpenClawBridgeServer extends AppServer {
  protected async onSession(
    session: AppSession,
    sessionId: string,
    userId: string
  ): Promise<void> {
    session.logger.info(`New session: ${sessionId} for user ${userId}`);

    const openclawConfig = getOpenClawConfigFromEnv();
    if (!openclawConfig) {
      session.layouts.showTextWall(
        "Mentra connected. You should see this on your glasses."
      );
      session.events.onDisconnected(() => {
        session.logger.info(`Session ${sessionId} disconnected.`);
      });
      return;
    }

    session.layouts.showTextWall("Connected.");

    let busy = false;
    let buffer = "";
    let lastDisplayTime = 0;
    let throttleTimer: ReturnType<typeof setTimeout> | null = null;

    /** Session transcript: all dictated final segments (capped in total length). */
    let transcriptSegments: string[] = [];
    let transcriptTotalChars = 0;
    let lastTranscriptDisplayTime = 0;
    let transcriptThrottleTimer: ReturnType<typeof setTimeout> | null = null;
    /** Live interim text (not yet final) so words appear as they are spoken. */
    let currentInterim = "";
    /** True if we just sent from interim so we don't send again when the same phrase is finalized. */
    let sentFromInterim = false;

    const appendToTranscript = (text: string) => {
      if (text.length === 0) return;
      transcriptSegments.push(text);
      transcriptTotalChars += text.length;
      while (transcriptTotalChars > TRANSCRIPT_LOG_MAX_CHARS && transcriptSegments.length > 0) {
        const removed = transcriptSegments.shift()!;
        transcriptTotalChars -= removed.length;
      }
    };

    const getTranscriptTail = (): string => {
      const full = transcriptSegments.join(" ");
      return full.length <= TRANSCRIPT_DISPLAY_MAX_CHARS ? full : full.slice(-TRANSCRIPT_DISPLAY_MAX_CHARS);
    };

    /** Returns the matched trigger phrase if segment equals, ends with, or starts with one (case-insensitive; transcription often capitalizes). */
    const getTriggerMatch = (segment: string): string | null => {
      const s = segment.trim().toLowerCase();
      if (!s) return null;
      for (const trigger of TRIGGER_WORDS) {
        if (s === trigger || s.endsWith(" " + trigger) || s.startsWith(trigger + " ")) return trigger;
      }
      return null;
    };

    /** Returns segment text with the trigger removed (from end, start, or whole). Case-insensitive: uses lowercased segment for detection, original for slicing. */
    const segmentWithoutTrigger = (segment: string, trigger: string): string => {
      const s = segment.trim().toLowerCase();
      if (s === trigger) return "";
      if (s.endsWith(" " + trigger)) return segment.trim().slice(0, -(trigger.length + 1)).trim();
      if (s.startsWith(trigger + " ")) return segment.trim().slice(trigger.length + 1).trim();
      return segment.trim();
    };

    const hasTrigger = (segment: string): boolean => getTriggerMatch(segment) !== null;

    /** True if segment equals or ends with a clear phrase (e.g. "clear"). Case-insensitive. */
    const isClearCommand = (segment: string): boolean => {
      const s = segment.trim().toLowerCase();
      if (!s) return false;
      return CLEAR_WORDS.some((c) => s === c || s.endsWith(" " + c));
    };

    const clearTranscript = () => {
      transcriptSegments = [];
      transcriptTotalChars = 0;
      currentInterim = "";
    };

    /** Build payload (transcript with trigger stripped from segment), clear transcript, return payload. */
    const getPayloadAndClear = (segment: string): string => {
      const trigger = getTriggerMatch(segment);
      if (!trigger) {
        transcriptSegments = [];
        transcriptTotalChars = 0;
        return "";
      }
      const beforeLast = transcriptSegments.slice(0, -1).join(" ").trim();
      const lastPart = segmentWithoutTrigger(
        transcriptSegments.length > 0 ? transcriptSegments[transcriptSegments.length - 1]! : "",
        trigger
      );
      transcriptSegments = [];
      transcriptTotalChars = 0;
      const payload = [beforeLast, lastPart].filter(Boolean).join(" ").trim();
      return payload;
    };

    const showTranscriptOnWall = () => {
      if (busy) return;
      const tail = getTranscriptTail();
      const withInterim = currentInterim ? (tail ? `${tail} ${currentInterim}` : currentInterim) : tail;
      const display = withInterim && withInterim.length > TRANSCRIPT_DISPLAY_MAX_CHARS
        ? withInterim.slice(-TRANSCRIPT_DISPLAY_MAX_CHARS)
        : withInterim;
      session.layouts.showTextWall(display || "Connected.");
      lastTranscriptDisplayTime = Date.now();
    };

    const scheduleThrottledTranscriptDisplay = () => {
      if (transcriptThrottleTimer !== null) return;
      if (busy) return;
      const elapsed = Date.now() - lastTranscriptDisplayTime;
      if (elapsed >= DISPLAY_THROTTLE_MS) {
        showTranscriptOnWall();
        transcriptThrottleTimer = null;
      } else {
        transcriptThrottleTimer = setTimeout(() => {
          showTranscriptOnWall();
          transcriptThrottleTimer = null;
        }, DISPLAY_THROTTLE_MS - elapsed);
      }
    };

    const flushDisplay = () => {
      if (buffer.length > 0) {
        session.layouts.showTextWall(buffer);
        lastDisplayTime = Date.now();
      }
      throttleTimer = null;
    };

    const scheduleThrottledDisplay = () => {
      if (throttleTimer !== null) return;
      const elapsed = Date.now() - lastDisplayTime;
      if (elapsed >= DISPLAY_THROTTLE_MS) {
        flushDisplay();
      } else {
        throttleTimer = setTimeout(flushDisplay, DISPLAY_THROTTLE_MS - elapsed);
      }
    };

    const sendToOpenClaw = (userText: string) => {
      if (busy) {
        session.layouts.showTextWall("Busy. Wait for the current response.");
        return;
      }
      busy = true;
      buffer = "";
      lastDisplayTime = 0;
      if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
      }
      session.layouts.showTextWall("Thinking...");

      const openclawUrl = `${openclawConfig.baseUrl.replace(/\/$/, "")}/v1/responses`;
      session.logger.info(
        `Sending to OpenClaw: ${openclawUrl} text="${userText.slice(0, 50)}${userText.length > 50 ? "..." : ""}"`
      );

      streamOpenClawResponse(
        openclawConfig,
        userText,
        {
          onDelta: (delta) => {
            const wasEmpty = buffer.length === 0;
            buffer += delta;
            if (wasEmpty) {
              flushDisplay();
            } else {
              scheduleThrottledDisplay();
            }
          },
          onDone: () => {
            flushDisplay();
          },
          onCompleted: () => {
            if (buffer.length === 0) {
              session.layouts.showTextWall("Done.");
            } else {
              session.layouts.showTextWall(buffer);
            }
            buffer = "";
            busy = false;
            if (throttleTimer) {
              clearTimeout(throttleTimer);
              throttleTimer = null;
            }
            showTranscriptOnWall();
          },
          onFailed: (err) => {
            const message = err instanceof Error ? err.message : String(err);
            session.layouts.showTextWall(`OpenClaw error: ${message.slice(0, 80)}`);
            session.logger.error(
              { err: err instanceof Error ? err.stack : String(err) },
              "OpenClaw request failed"
            );
            buffer = "";
            busy = false;
            if (throttleTimer) {
              clearTimeout(throttleTimer);
              throttleTimer = null;
            }
            showTranscriptOnWall();
          },
        },
        { user: userId }
      );
    };

    /** Build payload from current transcript + segment (with trigger stripped), clear, and return payload. Does not append segment. */
    const getPayloadAndClearFromInterim = (segment: string): string => {
      const trigger = getTriggerMatch(segment);
      if (!trigger) return "";
      const transcriptSoFar = transcriptSegments.join(" ").trim();
      const segmentPart = segmentWithoutTrigger(segment, trigger);
      const payload = [transcriptSoFar, segmentPart].filter(Boolean).join(" ").trim();
      clearTranscript();
      return payload;
    };

    const unsubTranscription = session.events.onTranscription((data) => {
      const text = data.text?.trim() ?? "";

      if (!data.isFinal) {
        currentInterim = text;
        const trigger = getTriggerMatch(text);
        if (trigger && !busy) {
          const payload = getPayloadAndClearFromInterim(text);
          currentInterim = "";
          if (payload.length > 0) {
            sentFromInterim = true;
            sendToOpenClaw(payload);
          }
        } else {
          scheduleThrottledTranscriptDisplay();
        }
        return;
      }

      currentInterim = "";
      if (text.length === 0) return;
      session.logger.info(`Final transcription received: ${text}`);

      if (isClearCommand(text)) {
        clearTranscript();
        session.layouts.showTextWall("Cleared.");
        return;
      }

      appendToTranscript(text);

      if (hasTrigger(text)) {
        if (sentFromInterim) {
          sentFromInterim = false;
          clearTranscript();
          scheduleThrottledTranscriptDisplay();
        } else if (!busy) {
          const payload = getPayloadAndClear(text);
          if (payload.length > 0) {
            sendToOpenClaw(payload);
          } else {
            scheduleThrottledTranscriptDisplay();
          }
        } else {
          session.layouts.showTextWall("Busy. Wait for the current response.");
        }
      } else {
        sentFromInterim = false;
        scheduleThrottledTranscriptDisplay();
      }
    });

    session.events.onDisconnected(() => {
      session.logger.info(`Session ${sessionId} disconnected.`);
      unsubTranscription();
      if (throttleTimer) clearTimeout(throttleTimer);
      if (transcriptThrottleTimer) clearTimeout(transcriptThrottleTimer);
    });
  }
}

const server = new OpenClawBridgeServer({
  packageName: PACKAGE_NAME,
  apiKey: MENTRAOS_API_KEY,
  port: PORT,
  healthCheck: true,
});

server.start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
