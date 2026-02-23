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

/** Delay between rendering each word (ms). */
const WORD_RENDER_DELAY_MS = 120;

/** G1 display max lines */
const G1_MAX_LINES = 5;

/** Trigger phrases (longer first). From env or defaults. */
const TRIGGER_WORDS: string[] = (() => {
  const raw = process.env.OPENCLAW_TRIGGER_WORDS ?? "mac,jarvis,send,execute";
  const list = raw.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
  return list.length > 0 ? list.sort((a, b) => b.length - a.length) : ["mac", "jarvis", "send", "execute"];
})();

/** Clear phrases (reset transcript and return to welcome). From env or defaults. */
const CLEAR_WORDS: string[] = (() => {
  const raw = process.env.OPENCLAW_CLEAR_WORDS ?? "clear,stop,reset,cancel";
  return raw.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
})();

let lastAnswer = "";

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
 * OpenClawBridgeServer - MentraOS app connecting Even G1 glasses to OpenClaw.
 * Simple buffer-based display for responses.
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

    // ScrollView for transcript (user input) and response (OpenClaw output)
    const transcriptView = new ScrollView(measurer, wrapper, G1_MAX_LINES);
    const responseView = new ScrollView(measurer, wrapper, G1_MAX_LINES);

    // State machine
    let state: SessionState = SessionState.IDLE;

    // Transcript segments for building the prompt
    let transcriptSegments: string[] = [];

    // Current interim text (not yet final)
    let currentInterim = "";

    // Track if we triggered from interim to skip the matching final
    let lastInterimTriggerText = "";

    // Track if we cleared from interim to skip the matching final
    let clearedFromInterim = false;

    // Response buffer for streaming
    let responseBuffer = "";

    // Word-by-word rendering state
    let renderedWordCount = 0;
    let wordRenderTimer: ReturnType<typeof setTimeout> | null = null;
    let streamComplete = false;

    // Greeting letter-by-letter rendering state
    let greetingRenderTimer: ReturnType<typeof setTimeout> | null = null;
    let greetingRenderedText = "";
    let greetingIndex = 0;

    // Status bar state
    let glassesBatteryLevel: number | null = null;

    const getStatusLine = () => {
      const tz = process.env.TIMEZONE || "America/Los_Angeles";
      const timeStr = new Date().toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true });
      const battery = glassesBatteryLevel !== null ? `${glassesBatteryLevel}%` : "--";
      return `${timeStr}  ${battery}`;
    };

    const DIVIDER = "---------------------";

    const WELCOME_MESSAGE = "Hey Charlie, What can I help you with today?";
    const GREETING_LETTER_DELAY_MS = 50;

    /** Stop greeting renderer */
    const stopGreetingRenderer = () => {
      if (greetingRenderTimer) {
        clearTimeout(greetingRenderTimer);
        greetingRenderTimer = null;
      }
    };

    /** Render next letter of greeting */
    const renderNextGreetingLetter = () => {
      if (greetingIndex >= WELCOME_MESSAGE.length) {
        greetingRenderTimer = null;
        return;
      }

      greetingRenderedText += WELCOME_MESSAGE[greetingIndex];
      greetingIndex++;

      session.layouts.showTextWall(`${getStatusLine()}\n${DIVIDER}\n${greetingRenderedText}`, { durationMs: -1 });

      greetingRenderTimer = setTimeout(renderNextGreetingLetter, GREETING_LETTER_DELAY_MS);
    };

    /** Display welcome message letter by letter */
    const showWelcome = () => {
      stopGreetingRenderer();
      greetingRenderedText = "";
      greetingIndex = 0;
      renderNextGreetingLetter();
    };

    /** Stop word renderer */
    const stopWordRenderer = () => {
      if (wordRenderTimer) {
        clearTimeout(wordRenderTimer);
        wordRenderTimer = null;
      }
    };

    /** Display current rendered text on ScrollView */
    const displayResponseView = () => {
      const viewport = responseView.getViewport();
      const text = viewport.lines.join("\n");
      session.layouts.showTextWall(text, { durationMs: -1 });
    };

    /** Render next word from buffer */
    const renderNextWord = () => {
      // Get all words from buffer
      const allWords = responseBuffer.split(/\s+/).filter(Boolean);

      if (renderedWordCount >= allWords.length) {
        // No more words to render
        wordRenderTimer = null;
        if (streamComplete) {
          lastAnswer = responseBuffer;
          state = SessionState.IDLE;
          responseBuffer = "";
          renderedWordCount = 0;
          streamComplete = false;
        }
        return;
      }

      // Build text from words rendered so far + next word
      renderedWordCount++;
      const textToShow = allWords.slice(0, renderedWordCount).join(" ");

      // Update ScrollView and display
      responseView.setContent(textToShow);
      responseView.scrollToBottom();
      displayResponseView();

      // Schedule next word
      wordRenderTimer = setTimeout(renderNextWord, WORD_RENDER_DELAY_MS);
    };

    /** Start word rendering if not already running */
    const startWordRenderer = () => {
      if (!wordRenderTimer) {
        renderNextWord();
      }
    };

    /** Get trigger match from text (case-insensitive) */
    const getTriggerMatch = (text: string): string | null => {
      const s = text.trim().toLowerCase();
      if (!s) return null;
      for (const trigger of TRIGGER_WORDS) {
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
    const clearTranscript = (fromInterim = false) => {
      transcriptSegments = [];
      currentInterim = "";
      lastInterimTriggerText = "";
      clearedFromInterim = fromInterim;
      state = SessionState.IDLE;
      transcriptView.clear();
      session.layouts.showTextWall("Cleared.", { durationMs: 1000 });
      setTimeout(showWelcome, 1000);
    };

    /** Build prompt payload from transcript */
    const buildPayload = (finalSegment: string | null, trigger: string): string => {
      const parts = [...transcriptSegments];
      if (finalSegment) {
        parts.push(stripTrigger(finalSegment, trigger));
      }
      return parts.join(" ").trim();
    };

    /** Display transcript ScrollView */
    const displayTranscriptView = () => {
      const viewport = transcriptView.getViewport();
      const text = viewport.lines.join("\n");
      session.layouts.showTextWall(text, { durationMs: -1 });
    };

    /** Show transcript on display with ScrollView */
    const showTranscript = () => {
      if (state === SessionState.SENDING || state === SessionState.STREAMING) return;
      stopGreetingRenderer();
      const final = transcriptSegments.join(" ").trim();
      const display = currentInterim
        ? (final ? `${final} ${currentInterim}` : currentInterim)
        : (final || WELCOME_MESSAGE);

      // Use ScrollView for proper wrapping and scrolling
      transcriptView.setContent(display);
      transcriptView.scrollToBottom();
      displayTranscriptView();
    };

    /** Send prompt to OpenClaw */
    const sendToOpenClaw = (prompt: string) => {
      if (state === SessionState.SENDING || state === SessionState.STREAMING) {
        session.logger.warn("Ignoring send - already processing");
        return;
      }

      if (!prompt) {
        session.logger.warn("Empty prompt, ignoring");
        showTranscript();
        return;
      }

      state = SessionState.SENDING;
      transcriptSegments = [];
      currentInterim = "";
      lastInterimTriggerText = "";
      transcriptView.clear();

      // Reset response rendering state
      stopWordRenderer();
      responseBuffer = "";
      renderedWordCount = 0;
      streamComplete = false;
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
            responseBuffer += delta.replace(/\*/g, "").replace(/#+/g, "").replace(/"/g, "");
            startWordRenderer();
          },
          onDone: () => {
            // Continue rendering remaining words
          },
          onCompleted: () => {
            streamComplete = true;
            if (responseBuffer.length === 0) {
              session.layouts.showTextWall("Done.", { durationMs: 2000 });
              setTimeout(() => {
                state = SessionState.IDLE;
                showWelcome();
              }, 2000);
            }
            // Otherwise renderNextWord handles transition when done
          },
          onFailed: (err) => {
            stopWordRenderer();
            const message = err instanceof Error ? err.message : String(err);
            session.layouts.showTextWall(`Error: ${message.slice(0, 60)}`, { durationMs: 5000 });
            session.logger.error(
              { err: err instanceof Error ? err.stack : String(err) },
              "OpenClaw request failed"
            );
            setTimeout(() => {
              state = SessionState.IDLE;
              responseBuffer = "";
              renderedWordCount = 0;
              streamComplete = false;
              showWelcome();
            }, 5000);
          },
        },
        { user: userId }
      );
    };

    // Show last answer on reconnect, or welcome if no answer yet
    if (lastAnswer) {
      session.layouts.showTextWall(lastAnswer, { durationMs: -1 });
    } else {
      showWelcome();
    }

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

        // Check for clear command in interim for instant response
        if (isClearCommand(text)) {
          currentInterim = "";
          clearTranscript(true);
          return;
        }

        // Check for trigger in interim for faster response
        const trigger = getTriggerMatch(text);
        if (trigger) {
          const payload = buildPayload(text, trigger);
          if (payload) {
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
        showTranscript();
        return;
      }

      // Final transcription
      currentInterim = "";

      if (!text) return;

      session.logger.info(`Final transcription: ${text}`);

      // Check if we already cleared from interim - skip matching final
      if (clearedFromInterim) {
        session.logger.info("Skipping final - already cleared from interim");
        clearedFromInterim = false;
        return;
      }

      // Check if this is the final version of an interim we already triggered on
      const normalizedText = text.toLowerCase().trim();
      if (lastInterimTriggerText && normalizedText.includes(lastInterimTriggerText.slice(0, 10))) {
        session.logger.info("Skipping final - already triggered from interim");
        lastInterimTriggerText = "";
        return;
      }
      lastInterimTriggerText = "";

      // Check for clear command
      if (isClearCommand(text)) {
        clearTranscript(false);
        return;
      }

      // Check for trigger in final
      const trigger = getTriggerMatch(text);
      if (trigger) {
        const payload = buildPayload(text, trigger);
        if (payload) {
          sendToOpenClaw(payload);
        } else {
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
      showTranscript();
    });

    const unsubHeadPosition = session.events.onHeadPosition((data) => {
      if (data.position !== "down") return;

      if (state === SessionState.STREAMING) {
        stopWordRenderer();
        responseBuffer = "";
        renderedWordCount = 0;
        streamComplete = false;
        responseView.clear();
        state = SessionState.IDLE;
        lastAnswer = "";
        showWelcome();
        return;
      }

      if (state === SessionState.IDLE && lastAnswer) {
        lastAnswer = "";
        responseView.clear();
        showWelcome();
        return;
      }

      if (state === SessionState.SENDING) return;

      const parts = [...transcriptSegments];
      if (currentInterim) parts.push(currentInterim);
      const prompt = parts.join(" ").trim();

      if (prompt) {
        currentInterim = "";
        lastInterimTriggerText = "";
        sendToOpenClaw(prompt);
      }
    });

    glassesBatteryLevel = session.device.state.batteryLevel.value;
    const unsubGlassesBattery = session.device.state.batteryLevel.onChange((level) => {
      glassesBatteryLevel = level;
    });

    session.events.onDisconnected(() => {
      session.logger.info(`Session ${sessionId} disconnected.`);
      unsubTranscription();
      unsubHeadPosition();
      unsubGlassesBattery();
      stopWordRenderer();
      stopGreetingRenderer();
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
