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

/** Throttle display updates for transcript. */
const DISPLAY_THROTTLE_MS = 150;

/** Delay between rendering each word (ms) - slower = more readable. */
const WORD_RENDER_DELAY_MS = 120;

/** G1 display constants from SDK */
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

if (!MENTRAOS_API_KEY) {
  console.error("MENTRAOS_API_KEY environment variable is required");
  process.exit(1);
}

/**
 * Clean response text for readable display on glasses.
 * Removes markdown formatting while preserving structure.
 */
function cleanResponseText(text: string): string {
  return text
    // Remove bold markers
    .replace(/\*\*/g, "")
    // Remove italic markers (single asterisk not at word boundary)
    .replace(/(?<!\s)\*(?!\s)/g, "")
    .replace(/\*(?=\w)/g, "")
    .replace(/(?<=\w)\*/g, "")
    // Remove underscores used for emphasis
    .replace(/(?<!\s)_(?!\s)/g, "")
    // Remove inline code backticks
    .replace(/`/g, "")
    // Remove code block markers
    .replace(/```\w*\n?/g, "")
    // Clean up bullet points - normalize to dash
    .replace(/^[\s]*[•●○]\s*/gm, "- ")
    // Normalize numbered lists with parenthesis to period
    .replace(/^(\d+)\)\s*/gm, "$1. ")
    // Remove trailing whitespace from lines
    .replace(/[ \t]+$/gm, "")
    // Normalize multiple spaces to single
    .replace(/  +/g, " ")
    // Normalize 3+ newlines to double newline (paragraph break)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Tokenize text into words and newline markers for rendering.
 * Preserves paragraph structure by tracking newlines.
 */
function tokenizeForRendering(text: string): string[] {
  const tokens: string[] = [];
  // Split into lines first to preserve newline structure
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Split line into words
    const words = line.split(/\s+/).filter(Boolean);
    tokens.push(...words);

    // Add newline token between lines (not after last line)
    if (i < lines.length - 1) {
      // Double newline = paragraph break, single = line break
      const nextLine = lines[i + 1];
      if (nextLine === "" && i + 2 < lines.length) {
        tokens.push("\n\n"); // Paragraph break
        i++; // Skip the empty line
      } else if (nextLine !== undefined) {
        tokens.push("\n"); // Line break
      }
    }
  }

  return tokens;
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

    // Track if we cleared from interim to skip the matching final
    let clearedFromInterim = false;

    // Response buffer for streaming (raw from OpenClaw)
    let responseBuffer = "";

    // Token-by-token rendering state (words + newlines)
    let renderedText = "";             // Text currently shown on display
    let pendingTokens: string[] = [];  // Tokens waiting to be rendered
    let wordRenderTimer: ReturnType<typeof setTimeout> | null = null;
    let streamComplete = false;        // True when OpenClaw stream is done
    let lastProcessedLength = 0;       // Track how much of responseBuffer we've processed

    // Greeting letter-by-letter rendering state
    let greetingRenderTimer: ReturnType<typeof setTimeout> | null = null;
    let greetingRenderedText = "";
    let greetingIndex = 0;

    const WELCOME_MESSAGE = "Hey Charlie, What can I help you with today?";
    const GREETING_LETTER_DELAY_MS = 50; // Delay between each letter

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
        // Done rendering greeting
        greetingRenderTimer = null;
        return;
      }

      // Add next letter
      greetingRenderedText += WELCOME_MESSAGE[greetingIndex];
      greetingIndex++;

      // Update display
      session.layouts.showTextWall(greetingRenderedText, { durationMs: -1 });

      // Schedule next letter
      greetingRenderTimer = setTimeout(renderNextGreetingLetter, GREETING_LETTER_DELAY_MS);
    };

    /** Display welcome message letter by letter */
    const showWelcome = () => {
      // Stop any existing greeting animation
      stopGreetingRenderer();

      // Reset greeting state
      greetingRenderedText = "";
      greetingIndex = 0;

      // Start letter-by-letter rendering
      renderNextGreetingLetter();
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

    /** Stop word rendering timer */
    const stopWordRenderer = () => {
      if (wordRenderTimer) {
        clearTimeout(wordRenderTimer);
        wordRenderTimer = null;
      }
    };

    /** Render next token from pending queue */
    const renderNextToken = () => {
      if (pendingTokens.length === 0) {
        // No more tokens to render
        if (streamComplete) {
          // Stream is done and all tokens rendered - hold then return to welcome
          setTimeout(() => {
            state = SessionState.IDLE;
            responseBuffer = "";
            renderedText = "";
            pendingTokens = [];
            lastProcessedLength = 0;
            streamComplete = false;
            showWelcome();
          }, 3000);
        }
        return;
      }

      // Get next token and add to rendered text
      const token = pendingTokens.shift()!;

      // Handle newline tokens vs word tokens
      if (token === "\n" || token === "\n\n") {
        renderedText = renderedText + token;
      } else {
        // Regular word - add space before if not at start and not after newline
        const needsSpace = renderedText.length > 0 &&
                          !renderedText.endsWith("\n") &&
                          !renderedText.endsWith(" ");
        renderedText = needsSpace ? `${renderedText} ${token}` : `${renderedText}${token}`;
      }

      // Update display
      responseView.setContent(renderedText);
      responseView.scrollToBottom();
      displayViewport(responseView);

      // Schedule next token
      wordRenderTimer = setTimeout(renderNextToken, WORD_RENDER_DELAY_MS);
    };

    /** Process new response text - clean, tokenize, and queue for rendering */
    const processResponseDelta = () => {
      // Only process new content
      if (responseBuffer.length <= lastProcessedLength) return;

      // Clean and tokenize the full response
      const cleanedText = cleanResponseText(responseBuffer);
      const allTokens = tokenizeForRendering(cleanedText);

      // Queue only new tokens (tokens we haven't processed yet)
      const currentTokenCount = pendingTokens.length +
        tokenizeForRendering(cleanResponseText(responseBuffer.slice(0, lastProcessedLength))).length;

      const newTokens = allTokens.slice(currentTokenCount);
      if (newTokens.length > 0) {
        pendingTokens.push(...newTokens);
        lastProcessedLength = responseBuffer.length;

        // Start renderer if not running
        if (!wordRenderTimer && pendingTokens.length > 0) {
          renderNextToken();
        }
      }
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
      // Stop greeting animation when user starts speaking
      stopGreetingRenderer();
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

      // Reset response rendering state
      stopWordRenderer();
      responseBuffer = "";
      renderedText = "";
      pendingTokens = [];
      lastProcessedLength = 0;
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
            // Accumulate raw response
            responseBuffer += delta;
            // Process and queue new words for rendering
            processResponseDelta();
          },
          onDone: () => {
            // Process any remaining text
            processResponseDelta();
          },
          onCompleted: () => {
            streamComplete = true;
            // Process final words
            processResponseDelta();

            // If no words were rendered, show done message
            if (responseBuffer.length === 0) {
              session.layouts.showTextWall("Done.", { durationMs: 2000 });
              setTimeout(() => {
                state = SessionState.IDLE;
                showWelcome();
              }, 2000);
            }
            // Otherwise renderNextWord will handle the transition when done
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
              renderedText = "";
              pendingTokens = [];
              lastProcessedLength = 0;
              streamComplete = false;
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

        // Check for clear command in interim for instant response
        if (isClearCommand(text)) {
          currentInterim = "";
          clearTranscript(true);
          return;
        }

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

      // Check if we already cleared from interim - skip matching final
      if (clearedFromInterim) {
        session.logger.info("Skipping final - already cleared from interim");
        clearedFromInterim = false;
        return;
      }

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
