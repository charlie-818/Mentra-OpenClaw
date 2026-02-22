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

/** Trigger phrases (longer first so "big mac" matches before "mac"). From env OPENCLAW_TRIGGER_WORDS (comma-separated) or default. */
const TRIGGER_WORDS: string[] = (() => {
  const raw = process.env.OPENCLAW_TRIGGER_WORDS ?? "go,send,execute,big mac";
  const list = raw.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
  return list.length > 0 ? list.sort((a, b) => b.length - a.length) : ["go", "send", "execute", "big mac"].sort((a, b) => b.length - a.length);
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

    const triggerHint = TRIGGER_WORDS[0] ? ` Say "${TRIGGER_WORDS[0]}" to send.` : "";
    session.layouts.showTextWall("Connected." + triggerHint);

    let busy = false;
    let buffer = "";
    let lastDisplayTime = 0;
    let throttleTimer: ReturnType<typeof setTimeout> | null = null;

    /** Session transcript: all dictated final segments (capped in total length). */
    let transcriptSegments: string[] = [];
    let transcriptTotalChars = 0;
    let lastTranscriptDisplayTime = 0;
    let transcriptThrottleTimer: ReturnType<typeof setTimeout> | null = null;

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

    /** Returns the matched trigger phrase (trimmed lower) if segment equals or ends with one; longer triggers first. */
    const getTriggerMatch = (segment: string): string | null => {
      const s = segment.trim().toLowerCase();
      if (!s) return null;
      for (const trigger of TRIGGER_WORDS) {
        if (s === trigger || s.endsWith(" " + trigger)) return trigger;
      }
      return null;
    };

    const endsWithTrigger = (segment: string): boolean => getTriggerMatch(segment) !== null;

    /** Build payload (transcript with trigger stripped from end), clear transcript, return payload. */
    const getPayloadAndClear = (segment: string): string => {
      const trigger = getTriggerMatch(segment);
      if (!trigger || transcriptSegments.length === 0) {
        transcriptSegments = [];
        transcriptTotalChars = 0;
        return "";
      }

      const last = transcriptSegments[transcriptSegments.length - 1];
      const lastTrimmed = last.trim().toLowerCase();
      let beforeLast: string;
      let lastPart: string;
      if (lastTrimmed === trigger) {
        beforeLast = transcriptSegments.slice(0, -1).join(" ").trim();
        lastPart = "";
      } else if (lastTrimmed.endsWith(" " + trigger)) {
        const trimmedLast = last.trim();
        const suffix = " " + trigger;
        lastPart = trimmedLast.slice(0, -suffix.length).trim();
        beforeLast = transcriptSegments.slice(0, -1).join(" ").trim();
      } else {
        beforeLast = transcriptSegments.join(" ").trim();
        lastPart = "";
      }
      transcriptSegments = [];
      transcriptTotalChars = 0;
      return beforeLast ? (lastPart ? `${beforeLast} ${lastPart}` : beforeLast) : lastPart;
    };

    const showTranscriptOnWall = () => {
      if (busy) return;
      const tail = getTranscriptTail();
      const hint = TRIGGER_WORDS[0] ? ` Say "${TRIGGER_WORDS[0]}" to send.` : "";
      session.layouts.showTextWall(tail ? tail + hint : "Connected." + hint);
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

    const unsubTranscription = session.events.onTranscription((data) => {
      if (!data.isFinal) return;
      const text = data.text?.trim() ?? "";
      if (text.length === 0) return;
      session.logger.info(`Final transcription received: ${text}`);
      appendToTranscript(text);

      if (endsWithTrigger(text)) {
        if (!busy) {
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
