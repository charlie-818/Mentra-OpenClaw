import "dotenv/config";
import express from "express";
import { AppServer, AppSession } from "@mentra/sdk";
import {
  createG1Toolkit,
  ScrollView,
} from "@mentra/sdk/display-utils";
import {
  getOpenClawConfigFromEnv,
  streamOpenClawResponse,
} from "./openclaw.js";
import * as registry from "./session-registry.js";
import * as pushRoutes from "./push-routes.js";
import { appendTranscript } from "./transcript-log.js";
import { isFilterConfigured, classifyTranscript } from "./copilot-filter.js";

const PACKAGE_NAME = process.env.PACKAGE_NAME ?? "com.example.mentra-openclaw-bridge";
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY;

/** Delay between rendering each word (ms). */
const WORD_RENDER_DELAY_MS = 120;

/** Format response text for readability - put list items on their own lines */
const formatResponseText = (text: string): string => {
  return text
    // Strip markdown formatting
    .replace(/\*+/g, "")
    .replace(/#+\s*/g, "")
    .replace(/"/g, "")
    // Normalize whitespace (collapse multiple spaces)
    .replace(/  +/g, " ")
    // Add newline before numbered list items (1. 2. 3. etc) - handles mid-sentence numbers
    .replace(/([.!?])\s+(\d+\.)\s/g, "$1\n$2 ")
    .replace(/([a-z])\s+(\d+\.)\s/g, "$1\n$2 ")
    // Add newline before bullet dashes that follow text
    .replace(/([.!?a-z])\s+-\s+/gi, "$1\n- ")
    // Clean up any double newlines
    .replace(/\n\n+/g, "\n")
    .trim();
};

/** Join viewport lines for display, reinserting space at wrapped word boundaries so words don't run together on the glasses. */
const joinViewportLinesWithSpaces = (lines: string[]): string =>
  lines.join("\n").replace(/([^\s])\n(?=[^\s])/g, "$1 \n");

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

/** Copilot voice toggle phrases (normalized). */
const COPILOT_TOGGLE_PHRASES = [
  "copilot mode",
  "copilot on",
  "copilot off",
  "copilot an",
  "copilot aus",
  "new session",
  "neue session",
];

let lastAnswer = "";

if (!MENTRAOS_API_KEY) {
  console.error("MENTRAOS_API_KEY environment variable is required");
  process.exit(1);
}

/** Session state machine */
enum SessionState {
  IDLE = "IDLE",
  LISTENING = "LISTENING",
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

    const entry: registry.SessionEntry = {
      session,
      sessionId,
      userId,
      state: SessionState.IDLE as registry.SessionStateLabel,
      copilot: false,
      lastTranscriptAt: null,
      copilotPipeline: { totalFiltered: 0, totalPassed: 0, bufferSize: 0, inflight: false },
      requestListening(listening: boolean) {
        if (listening && state === SessionState.IDLE) {
          setState(SessionState.LISTENING);
          stopGreetingRenderer();
          session.layouts.showTextWall(`${getStatusLine()}\n${DIVIDER}\nStarting Transcription...`, { durationMs: -1 });
        } else if (!listening && (state === SessionState.LISTENING || state === SessionState.DICTATING)) {
          setState(SessionState.IDLE);
          showWelcome();
        }
      },
    };
    registry.register(entry);

    const setState = (s: SessionState) => {
      state = s;
      entry.state = s as registry.SessionStateLabel;
      if (s === SessionState.IDLE) setImmediate(tryProcessPendingCopilotBatch);
    };

    const COPILOT_DEBOUNCE_MS = 3000;
    let copilotBuffer: string[] = [];
    const recentCopilotBatches: string[] = [];
    const COPILOT_CONTEXT_BATCHES = 5;
    let copilotDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingCopilotBatch: string | null = null;
    let pendingCopilotContext: string[] = [];
    let currentSendIsCopilot = false;

    const clearCopilotDebounce = () => {
      if (copilotDebounceTimer) {
        clearTimeout(copilotDebounceTimer);
        copilotDebounceTimer = null;
      }
    };

    const processCopilotBatch = async (batch: string, contextBatches: string[]) => {
      if (state === SessionState.SENDING || state === SessionState.STREAMING) {
        pendingCopilotBatch = batch;
        pendingCopilotContext = [...contextBatches];
        return;
      }
      if (!batch.trim()) return;
      entry.copilotPipeline.inflight = true;
      const contextStr = contextBatches.map((b) => b.trim()).join("\n");
      if (isFilterConfigured()) {
        const tag = await classifyTranscript(batch, contextStr);
        appendTranscript("copilot", batch, tag);
        if (tag === "SKIP") {
          entry.copilotPipeline.totalFiltered++;
          entry.copilotPipeline.inflight = false;
          return;
        }
        entry.copilotPipeline.totalPassed++;
      } else {
        appendTranscript("copilot", batch, null);
        entry.copilotPipeline.totalPassed++;
      }
      const context = contextBatches.length > 0
        ? `Recent context:\n${contextStr}\n\nCurrent: ${batch}`
        : batch;
      const message = contextBatches.length > 0
        ? `⚠️ G1 COPILOT MODE: The user is having a conversation nearby. Context (last ${contextBatches.length} batches) + current:\n\n${context}`
        : `⚠️ G1 COPILOT MODE: The user is having a conversation nearby.\n\n${batch}`;
      currentSendIsCopilot = true;
      sendToOpenClaw(message);
      entry.copilotPipeline.inflight = false;
    };

    const flushCopilotBuffer = () => {
      clearCopilotDebounce();
      const batch = copilotBuffer.join(" ").trim();
      copilotBuffer = [];
      entry.copilotPipeline.bufferSize = copilotBuffer.length;
      if (!batch) return;
      while (recentCopilotBatches.length >= COPILOT_CONTEXT_BATCHES) {
        recentCopilotBatches.shift();
      }
      recentCopilotBatches.push(batch);
      processCopilotBatch(batch, recentCopilotBatches.slice(0, -1));
    };

    const tryProcessPendingCopilotBatch = () => {
      if (pendingCopilotBatch === null || state !== SessionState.IDLE) return;
      const batch = pendingCopilotBatch;
      const context = pendingCopilotContext;
      pendingCopilotBatch = null;
      pendingCopilotContext = [];
      processCopilotBatch(batch, context);
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
      const text = joinViewportLinesWithSpaces(viewport.lines);
      session.layouts.showTextWall(text, { durationMs: -1 });
    };

    /** Render next word from buffer */
    const renderNextWord = () => {
      // Split into tokens preserving newlines as separate tokens
      const tokens = responseBuffer.split(/(\n)| +/).filter(Boolean);

      if (renderedWordCount >= tokens.length) {
        // No more tokens to render
        wordRenderTimer = null;
        if (streamComplete) {
          const noReply = currentSendIsCopilot && responseBuffer.trim().toUpperCase() === "NO_REPLY";
          currentSendIsCopilot = false;
          if (!noReply) lastAnswer = responseBuffer;
          setState(SessionState.IDLE);
          responseBuffer = "";
          renderedWordCount = 0;
          streamComplete = false;
          if (noReply) showWelcome();
        }
        return;
      }

      // Build text from tokens rendered so far + next token
      renderedWordCount++;
      // Join tokens, adding space between words but not around newlines
      let textToShow = "";
      for (let i = 0; i < renderedWordCount; i++) {
        const token = tokens[i];
        if (token === "\n") {
          textToShow += "\n";
        } else {
          if (textToShow.length > 0 && !textToShow.endsWith("\n")) {
            textToShow += " ";
          }
          textToShow += token;
        }
      }

      // Update ScrollView and display
      responseView.setContent(textToShow, { breakMode: 'strict-word' });
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

    /** Check for copilot voice command; returns "on" | "off" | "toggle" | null */
    const getCopilotVoiceCommand = (text: string): "on" | "off" | "toggle" | null => {
      const s = text.trim().toLowerCase();
      if (s.includes("copilot on") || s.includes("copilot an")) return "on";
      if (s.includes("copilot off") || s.includes("copilot aus")) return "off";
      if (s.includes("copilot mode") || s.includes("new session") || s.includes("neue session")) return "toggle";
      return null;
    };

    /** Clear transcript and reset to idle */
    const clearTranscript = (fromInterim = false) => {
      transcriptSegments = [];
      currentInterim = "";
      lastInterimTriggerText = "";
      clearedFromInterim = fromInterim;
      setState(SessionState.IDLE);
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
      const text = joinViewportLinesWithSpaces(viewport.lines);
      session.layouts.showTextWall(text, { durationMs: -1 });
    };

    /** Show transcript on display with ScrollView */
    const showTranscript = () => {
      if (state === SessionState.SENDING || state === SessionState.STREAMING) return;
      stopGreetingRenderer();
      const final = transcriptSegments.join(" ").trim();
      const display = currentInterim
        ? (final ? `${final} ${currentInterim}` : currentInterim)
        : final;

      if (!display) return; // Nothing to show

      // Use ScrollView for proper wrapping and scrolling
      transcriptView.setContent(`${getStatusLine()}\n${DIVIDER}\n${display}`, { breakMode: 'strict-word' });
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

      setState(SessionState.SENDING);
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
              setState(SessionState.STREAMING);
            }
            responseBuffer += delta;
            // Format the entire buffer for proper list display
            responseBuffer = formatResponseText(responseBuffer);
            startWordRenderer();
          },
          onDone: () => {
            // Continue rendering remaining words
          },
          onCompleted: () => {
            streamComplete = true;
            if (responseBuffer.length === 0) {
              currentSendIsCopilot = false;
              session.layouts.showTextWall("Done.", { durationMs: 2000 });
              setTimeout(() => {
                setState(SessionState.IDLE);
                showWelcome();
              }, 2000);
            }
            // Otherwise renderNextWord handles transition when done
          },
          onFailed: (err) => {
            currentSendIsCopilot = false;
            stopWordRenderer();
            const message = err instanceof Error ? err.message : String(err);
            session.layouts.showTextWall(`Error: ${message.slice(0, 60)}`, { durationMs: 5000 });
            session.logger.error(
              { err: err instanceof Error ? err.stack : String(err) },
              "OpenClaw request failed"
            );
            setTimeout(() => {
              setState(SessionState.IDLE);
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

      // Ignore transcription while idle (welcome showing), sending, or streaming
      if (state === SessionState.IDLE || state === SessionState.SENDING || state === SessionState.STREAMING) {
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

        // Check for trigger in interim for faster response (skip when copilot on)
        const trigger = getTriggerMatch(text);
        if (trigger && !entry.copilot) {
          const payload = buildPayload(text, trigger);
          if (payload) {
            lastInterimTriggerText = text.toLowerCase().trim();
            currentInterim = "";
            sendToOpenClaw(payload);
            return;
          }
        }

        // Transition from LISTENING to DICTATING when user starts talking
        if (state === SessionState.LISTENING) {
          setState(SessionState.DICTATING);
        }
        showTranscript();
        return;
      }

      // Final transcription
      currentInterim = "";

      if (!text) return;

      session.logger.info(`Final transcription: ${text}`);
      entry.lastTranscriptAt = Date.now();

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

      const copilotCmd = getCopilotVoiceCommand(text);
      if (copilotCmd !== null) {
        if (copilotCmd === "toggle") {
          entry.copilot = !entry.copilot;
        } else if (copilotCmd === "on") {
          entry.copilot = true;
        } else {
          entry.copilot = false;
        }
        session.layouts.showTextWall(
          `Copilot ${entry.copilot ? "on" : "off"}.`,
          { durationMs: 2000 }
        );
        setTimeout(showWelcome, 2000);
        return;
      }

      // When copilot is on: accumulate in buffer and debounce; do not send on trigger
      if (entry.copilot) {
        copilotBuffer.push(text);
        entry.copilotPipeline.bufferSize = copilotBuffer.length;
        clearCopilotDebounce();
        copilotDebounceTimer = setTimeout(flushCopilotBuffer, COPILOT_DEBOUNCE_MS);
        transcriptSegments.push(text);
        showTranscript();
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

      // Transition from LISTENING to DICTATING when user starts talking
      if (state === SessionState.LISTENING) {
        setState(SessionState.DICTATING);
      }
      transcriptSegments.push(text);
      appendTranscript("normal", text);
      showTranscript();
    });

    const unsubHeadPosition = session.events.onHeadPosition((data) => {
      // Head up: start listening for transcription
      if (data.position === "up") {
        if (state === SessionState.IDLE) {
          stopGreetingRenderer();
          setState(SessionState.LISTENING);
          session.layouts.showTextWall(`${getStatusLine()}\n${DIVIDER}\nStarting Transcription...`, { durationMs: -1 });
        }
        return;
      }

      // Head down: various actions
      if (data.position !== "down") return;

      if (state === SessionState.STREAMING) {
        stopWordRenderer();
        responseBuffer = "";
        renderedWordCount = 0;
        streamComplete = false;
        responseView.clear();
        setState(SessionState.IDLE);
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

      // Check if there are any transcribed words
      const parts = [...transcriptSegments];
      if (currentInterim) parts.push(currentInterim);
      const prompt = parts.join(" ").trim();

      // Head down while listening/dictating - submit if words, else go back to welcome
      if (state === SessionState.LISTENING || state === SessionState.DICTATING) {
        if (prompt) {
          currentInterim = "";
          lastInterimTriggerText = "";
          if (entry.copilot) {
            copilotBuffer.push(prompt);
            entry.copilotPipeline.bufferSize = copilotBuffer.length;
            flushCopilotBuffer();
          } else {
            sendToOpenClaw(prompt);
          }
        } else {
          setState(SessionState.IDLE);
          showWelcome();
        }
      }
    });

    glassesBatteryLevel = session.device.state.batteryLevel.value;
    const unsubGlassesBattery = session.device.state.batteryLevel.onChange((level) => {
      glassesBatteryLevel = level;
    });

    session.events.onDisconnected(() => {
      session.logger.info(`Session ${sessionId} disconnected.`);
      clearCopilotDebounce();
      registry.unregister(sessionId);
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

const app = server.getExpressApp();
app.use(express.json());
app.post("/push", pushRoutes.handlePush);
app.post("/push-bitmap", pushRoutes.handlePushBitmap);
app.post("/mic", pushRoutes.handleMic);
app.post("/copilot", pushRoutes.handleCopilotPost);
app.get("/copilot", pushRoutes.handleCopilotGet);
app.get("/status", pushRoutes.handleStatus);
app.get("/debug", pushRoutes.handleDebug);

server.start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
