import "dotenv/config";
import { AppServer, AppSession } from "@mentra/sdk";
import {
  createG1Toolkit,
  ScrollView,
} from "@mentra/sdk/display-utils";
import {
  getOpenClawConfigFromEnv,
  streamOpenClawResponse,
} from "./openclaw.js";

const PACKAGE_NAME = process.env.PACKAGE_NAME ?? "com.example.mentra-openclaw-bridge";
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY;

/** Throttle display updates - reduced for snappier feel. */
const DISPLAY_THROTTLE_MS = 100;

/** G1 display constants from SDK */
const G1_MAX_LINES = 5;

/** Trigger phrases (longer first). From env or defaults. */
const TRIGGER_WORDS: string[] = (() => {
  const raw = process.env.OPENCLAW_TRIGGER_WORDS ?? "mac,jarvis,send,execute";
  const list = raw.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
  return list.length > 0 ? list.sort((a, b) => b.length - a.length) : ["mac", "jarvis", "send", "execute"];
})();

/** Clear phrases. From env or defaults. */
const CLEAR_WORDS: string[] = (() => {
  const raw = process.env.OPENCLAW_CLEAR_WORDS ?? "clear";
  return raw.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
})();

if (!MENTRAOS_API_KEY) {
  console.error("MENTRAOS_API_KEY environment variable is required");
  process.exit(1);
}

/** Session state machine */
enum SessionState {
  IDLE = "IDLE",
  DICTATING = "DICTATING",
  SENDING = "SENDING",
  STREAMING = "STREAMING",
}

/**
 * OpenClawBridgeServer - Production-grade MentraOS app connecting Even G1 glasses to OpenClaw.
 * Uses SDK ScrollView for proper text wrapping and auto-scrolling.
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
        "Mentra connected. OpenClaw not configured."
      );
      session.events.onDisconnected(() => {
        session.logger.info(`Session ${sessionId} disconnected.`);
      });
      return;
    }

    // Initialize G1 display toolkit for proper text wrapping
    const toolkit = createG1Toolkit();
    const { wrapper, measurer } = toolkit;

    // ScrollView for transcript (dictation input)
    const transcriptView = new ScrollView(measurer, wrapper, G1_MAX_LINES);
    // ScrollView for response (OpenClaw output)
    const responseView = new ScrollView(measurer, wrapper, G1_MAX_LINES);

    // State machine
    let state: SessionState = SessionState.IDLE;
    let lastDisplayTime = 0;
    let displayTimer: ReturnType<typeof setTimeout> | null = null;

    // Transcript segments for building the prompt
    let transcriptSegments: string[] = [];

    // Current interim text (not yet final)
    let currentInterim = "";

    // Track if we triggered from interim to skip the matching final
    let lastInterimTriggerText = "";

    // Response buffer for streaming
    let responseBuffer = "";

    const WELCOME_MESSAGE = "Speak your prompt. Say Send, Execute, Mac, or Jarvis when ready.";

    /** Display welcome message */
    const showWelcome = () => {
      transcriptView.setContent(WELCOME_MESSAGE);
      displayViewport(transcriptView);
    };

    /** Display a ScrollView's current viewport on glasses */
    const displayViewport = (view: ScrollView) => {
      const viewport = view.getViewport();
      const text = viewport.lines.join("\n");
      session.layouts.showTextWall(text, { durationMs: -1 });
      lastDisplayTime = Date.now();
    };

    /** Throttled display update */
    const scheduleDisplay = (view: ScrollView) => {
      if (displayTimer !== null) return;
      const elapsed = Date.now() - lastDisplayTime;
      if (elapsed >= DISPLAY_THROTTLE_MS) {
        displayViewport(view);
      } else {
        displayTimer = setTimeout(() => {
          displayViewport(view);
          displayTimer = null;
        }, DISPLAY_THROTTLE_MS - elapsed);
      }
    };

    /** Force immediate display */
    const flushDisplay = (view: ScrollView) => {
      if (displayTimer) {
        clearTimeout(displayTimer);
        displayTimer = null;
      }
      displayViewport(view);
    };

    /** Build display text from transcript segments + interim */
    const buildTranscriptDisplay = (): string => {
      const final = transcriptSegments.join(" ").trim();
      if (currentInterim) {
        return final ? `${final} ${currentInterim}` : currentInterim;
      }
      return final || WELCOME_MESSAGE;
    };

    /** Update transcript display */
    const updateTranscriptDisplay = () => {
      if (state === SessionState.SENDING || state === SessionState.STREAMING) return;
      transcriptView.setContent(buildTranscriptDisplay());
      transcriptView.scrollToBottom();
      scheduleDisplay(transcriptView);
    };

    /** Get trigger match from text (case-insensitive) */
    const getTriggerMatch = (text: string): string | null => {
      const s = text.trim().toLowerCase();
      if (!s) return null;
      for (const trigger of TRIGGER_WORDS) {
        // Match if text equals, ends with, or starts with the trigger
        if (s === trigger || s.endsWith(" " + trigger) || s.startsWith(trigger + " ")) {
          return trigger;
        }
      }
      return null;
    };

    /** Strip trigger word from text */
    const stripTrigger = (text: string, trigger: string): string => {
      const s = text.trim().toLowerCase();
      const original = text.trim();
      if (s === trigger) return "";
      if (s.endsWith(" " + trigger)) {
        return original.slice(0, -(trigger.length + 1)).trim();
      }
      if (s.startsWith(trigger + " ")) {
        return original.slice(trigger.length + 1).trim();
      }
      return original;
    };

    /** Check if text is a clear command */
    const isClearCommand = (text: string): boolean => {
      const s = text.trim().toLowerCase();
      return CLEAR_WORDS.some((c) => s === c || s.endsWith(" " + c));
    };

    /** Clear transcript and reset to idle */
    const clearTranscript = () => {
      transcriptSegments = [];
      currentInterim = "";
      lastInterimTriggerText = "";
      state = SessionState.IDLE;
      transcriptView.clear();
      session.layouts.showTextWall("Cleared.", { durationMs: 1500 });
      setTimeout(showWelcome, 1500);
    };

    /** Build prompt payload from transcript */
    const buildPayload = (finalSegment: string | null, trigger: string): string => {
      const parts = [...transcriptSegments];
      if (finalSegment) {
        parts.push(stripTrigger(finalSegment, trigger));
      }
      return parts.join(" ").trim();
    };

    /** Send prompt to OpenClaw */
    const sendToOpenClaw = (prompt: string) => {
      if (state === SessionState.SENDING || state === SessionState.STREAMING) {
        session.logger.warn("Ignoring send - already processing");
        return;
      }

      if (!prompt) {
        session.logger.warn("Empty prompt, ignoring");
        updateTranscriptDisplay();
        return;
      }

      state = SessionState.SENDING;
      transcriptSegments = [];
      currentInterim = "";
      lastInterimTriggerText = "";
      responseBuffer = "";
      responseView.clear();

      session.layouts.showTextWall("Thinking...", { durationMs: -1 });

      const openclawUrl = `${openclawConfig.baseUrl.replace(/\/$/, "")}/v1/responses`;
      session.logger.info(
        `Sending to OpenClaw: ${openclawUrl} prompt="${prompt.slice(0, 50)}${prompt.length > 50 ? "..." : ""}"`
      );

      streamOpenClawResponse(
        openclawConfig,
        prompt,
        {
          onDelta: (delta) => {
            if (state !== SessionState.STREAMING) {
              state = SessionState.STREAMING;
            }
            responseBuffer += delta;
            // Use appendContent for streaming with auto-scroll
            responseView.setContent(responseBuffer);
            responseView.scrollToBottom();
            scheduleDisplay(responseView);
          },
          onDone: () => {
            flushDisplay(responseView);
          },
          onCompleted: () => {
            if (responseBuffer.length === 0) {
              session.layouts.showTextWall("Done.", { durationMs: 2000 });
            } else {
              flushDisplay(responseView);
            }
            // Hold response on screen for a moment before returning to idle
            setTimeout(() => {
              state = SessionState.IDLE;
              responseBuffer = "";
              showWelcome();
            }, 3000);
          },
          onFailed: (err) => {
            const message = err instanceof Error ? err.message : String(err);
            session.layouts.showTextWall(`Error: ${message.slice(0, 60)}`, { durationMs: 5000 });
            session.logger.error(
              { err: err instanceof Error ? err.stack : String(err) },
              "OpenClaw request failed"
            );
            setTimeout(() => {
              state = SessionState.IDLE;
              responseBuffer = "";
              showWelcome();
            }, 5000);
          },
        },
        { user: userId }
      );
    };

    // Show welcome on connect
    showWelcome();

    // Handle transcription events
    const unsubTranscription = session.events.onTranscription((data) => {
      const text = data.text?.trim() ?? "";

      // Ignore transcription while sending/streaming
      if (state === SessionState.SENDING || state === SessionState.STREAMING) {
        return;
      }

      if (!data.isFinal) {
        // Interim transcription
        currentInterim = text;

        // Check for trigger in interim for faster response
        const trigger = getTriggerMatch(text);
        if (trigger) {
          // Build payload from existing segments + this interim (minus trigger)
          const payload = buildPayload(text, trigger);
          if (payload) {
            // Remember this text so we skip the matching final
            lastInterimTriggerText = text.toLowerCase().trim();
            currentInterim = "";
            sendToOpenClaw(payload);
            return;
          }
        }

        // No trigger, just update display with interim
        if (state === SessionState.IDLE) {
          state = SessionState.DICTATING;
        }
        updateTranscriptDisplay();
        return;
      }

      // Final transcription
      currentInterim = "";

      if (!text) return;

      session.logger.info(`Final transcription: ${text}`);

      // Check if this is the final version of an interim we already triggered on
      const normalizedText = text.toLowerCase().trim();
      if (lastInterimTriggerText && normalizedText.includes(lastInterimTriggerText.slice(0, 10))) {
        // This final matches the interim we already sent from - skip it
        session.logger.info("Skipping final - already triggered from interim");
        lastInterimTriggerText = "";
        return;
      }
      lastInterimTriggerText = "";

      // Check for clear command
      if (isClearCommand(text)) {
        clearTranscript();
        return;
      }

      // Check for trigger in final
      const trigger = getTriggerMatch(text);
      if (trigger) {
        const payload = buildPayload(text, trigger);
        if (payload) {
          sendToOpenClaw(payload);
        } else {
          // Trigger word only, no content - show hint
          session.layouts.showTextWall("Say something before the trigger word.", { durationMs: 2000 });
          setTimeout(showWelcome, 2000);
        }
        return;
      }

      // No trigger - accumulate segment
      if (state === SessionState.IDLE) {
        state = SessionState.DICTATING;
      }
      transcriptSegments.push(text);
      updateTranscriptDisplay();
    });

    session.events.onDisconnected(() => {
      session.logger.info(`Session ${sessionId} disconnected.`);
      unsubTranscription();
      if (displayTimer) clearTimeout(displayTimer);
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
