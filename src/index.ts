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
import {
  getClaudeCodeConfigFromEnv,
  streamClaudeCodeResponse,
} from "./claude-code.js";
import * as registry from "./session-registry.js";
import * as pushRoutes from "./push-routes.js";
import { appendTranscript } from "./transcript-log.js";
import { isFilterConfigured, classifyTranscript } from "./copilot-filter.js";
import { parseAgentCommand, deployAgent, getAgentStatus } from "./agent-deploy.js";
import {
  startPreview,
  appendPreviewDelta,
  completePreview,
  failPreview,
  getPreviewState,
} from "./preview-state.js";
import { formatResponseText, formatForDisplay } from "./display-format.js";
import {
  getMirrorState,
  updateMirrorDisplay,
  updateMirrorSessionState,
  registerMirrorSession,
  clearMirrorSession,
} from "./mirror-state.js";
import { SessionSettings, DEFAULT_SETTINGS } from "./settings.js";

const PACKAGE_NAME = process.env.PACKAGE_NAME ?? "com.example.mentra-openclaw-bridge";
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY ?? "";

/** Delay between rendering each word (ms). */
const WORD_RENDER_DELAY_MS = 120;

/** Default system prompt for OpenClaw responses, tuned for G1 glasses readability. */
const DEFAULT_OPENCLAW_SYSTEM_PROMPT =
  [
    "You are an assistant for AR smart glasses.",
    "Answer in clear, simple plain language.",
    "Optimize for a very small, narrow display that is read at a glance.",
    "Use short sentences and keep each idea on its own line.",
    "Do not use markdown or formatting syntax of any kind.",
    "Do not use bullets, numbered lists, headings, code blocks, or emojis.",
    "Avoid decorative characters like asterisks, dashes used as bullets, or box drawing.",
    "Keep answers concise and focused on what the user asked.",
  ].join(" ");

const getOpenClawSystemPrompt = (): string => {
  const fromEnv = process.env.OPENCLAW_SYSTEM_PROMPT;
  const trimmed = fromEnv?.trim();
  if (trimmed && trimmed.length > 0) {
    return trimmed;
  }
  return DEFAULT_OPENCLAW_SYSTEM_PROMPT;
};

/** Join viewport lines for display without introducing extra spaces inside words. */
const joinViewportLinesWithSpaces = (lines: string[]): string =>
  lines.join("\n");

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

/** AI mode voice toggle phrases. */
const AI_MODE_PHRASES = {
  claude: ["claude"],
  openclaw: ["open"],
  toggle: ["switch mode", "toggle mode"],
};

let lastAnswer = "";

/** Process-level SPY price cache (Yahoo Finance). */
let spyPriceUsd: number | null = null;
let spyChangePercent: number | null = null;

/** Free SPY quote API (no key required). */
const SPY_QUOTE_URL = "https://stockprices.dev/api/etfs/SPY";

/** Westwood, LA weather (Open-Meteo, no key required). */
const WESTWOOD_WEATHER_URL =
  "https://api.open-meteo.com/v1/forecast?latitude=34.0625&longitude=-118.4452&current=temperature_2m&temperature_unit=celsius";

let weatherTempC: number | null = null;

async function fetchSpyPrice(): Promise<void> {
  try {
    const res = await fetch(SPY_QUOTE_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MentraOpenClaw/1.0)" },
    });
    if (!res.ok) return;
    const data = (await res.json()) as {
      Price?: number;
      ChangePercentage?: number;
    };
    const price = data?.Price;
    const change = data?.ChangePercentage;
    if (typeof price === "number") spyPriceUsd = price;
    if (typeof change === "number") spyChangePercent = change;
  } catch {
    // Leave existing cache unchanged
  }
}

async function fetchWestwoodWeather(): Promise<void> {
  try {
    const res = await fetch(WESTWOOD_WEATHER_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MentraOpenClaw/1.0)" },
    });
    if (!res.ok) return;
    const data = (await res.json()) as {
      current?: { temperature_2m?: number };
    };
    const temp = data?.current?.temperature_2m;
    if (typeof temp === "number") weatherTempC = temp;
  } catch {
    // Leave existing cache unchanged
  }
}

if (!MENTRAOS_API_KEY && process.env.NODE_ENV !== "test") {
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

    // Initialize settings from MentraOS
    const settings = new SessionSettings(session);
    session.logger.info({ settings: settings.getAll() }, "Session settings initialized");

    // Settings-aware helper functions
    const getTriggerWords = () => settings.triggerWords;
    const getClearWords = () => settings.clearWords;
    const getWordRenderDelayMs = () => settings.responseSpeedMs;
    const getDashboardTimeoutMs = () => settings.dashboardTimeoutMs;
    const getResponseTimeoutMs = () => settings.responseTimeoutMs;
    const getCopilotDebounceMs = () => settings.copilotDebounceMs;
    const getHeadUpDelayMs = () => settings.headUpDelayMs;
    const getSystemPrompt = () => {
      const fromEnv = process.env.OPENCLAW_SYSTEM_PROMPT?.trim();
      if (fromEnv && fromEnv.length > 0) return fromEnv;
      return settings.buildSystemPrompt();
    };

    const openclawConfig = getOpenClawConfigFromEnv();
    const claudeCodeConfig = getClaudeCodeConfigFromEnv();

    if (!openclawConfig && !claudeCodeConfig) {
      session.layouts.showTextWall(
        "Mentra connected. No AI backend configured."
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
    const pushView = new ScrollView(measurer, wrapper, G1_MAX_LINES);

    let pushTokens: string[] = [];
    let pushRenderedWordCount = 0;
    let pushWordRenderTimer: ReturnType<typeof setTimeout> | null = null;
    const stopPushScroll = () => {
      if (pushWordRenderTimer) {
        clearTimeout(pushWordRenderTimer);
        pushWordRenderTimer = null;
      }
    };

    // State machine
    let state: SessionState = SessionState.IDLE;

    // Register session for mirror display
    registerMirrorSession(sessionId);

    // Wrapper to update mirror state on every display update
    const showDisplay = (text: string, opts?: { durationMs?: number }) => {
      session.layouts.showTextWall(text, opts);
      updateMirrorDisplay(sessionId, text);
    };

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
    // Track if next content needs a leading space (set when we receive whitespace-only deltas)
    let pendingSpace = false;

    // Word-by-word rendering state
    let renderedWordCount = 0;
    let wordRenderTimer: ReturnType<typeof setTimeout> | null = null;
    let streamComplete = false;

    /** Clear dashboard if user doesn't look up within this time (ms) */
    // Dashboard and response clear timers - use settings for durations
    let dashboardClearTimer: ReturnType<typeof setTimeout> | null = null;
    let responseClearTimer: ReturnType<typeof setTimeout> | null = null;
    let headUpStartTranscriptionTimer: ReturnType<typeof setTimeout> | null = null;

    // Status bar state
    let glassesBatteryLevel: number | null = null;

    const getStatusLine = () => {
      const tz = process.env.TIMEZONE || "America/Los_Angeles";
      const timeStr = new Date().toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true });
      const battery = glassesBatteryLevel !== null ? `${glassesBatteryLevel}%` : "--";
      const tempStr = weatherTempC != null ? `${weatherTempC}°C` : "-- °C";
      const line1 = `${timeStr}  ${battery}  ${tempStr}`;
      const spyLine =
        spyPriceUsd != null
          ? `SPY $${spyPriceUsd.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 0 })}${spyChangePercent != null ? ` ${spyChangePercent >= 0 ? "+" : ""}${spyChangePercent.toFixed(1)}%` : ""}`
          : "SPY --";
      return `${line1}\n${spyLine}`;
    };

    const DIVIDER = "---------------------";

    /** Stop the timer that clears the dashboard */
    const stopDashboardClearTimer = () => {
      if (dashboardClearTimer) {
        clearTimeout(dashboardClearTimer);
        dashboardClearTimer = null;
      }
    };

    /** Stop the timer that clears the display after a finished response */
    const stopResponseClearTimer = () => {
      if (responseClearTimer) {
        clearTimeout(responseClearTimer);
        responseClearTimer = null;
      }
    };

    /** Cancel pending head-up-to-start-transcription (sustained 2s) */
    const stopHeadUpStartTranscriptionTimer = () => {
      if (headUpStartTranscriptionTimer) {
        clearTimeout(headUpStartTranscriptionTimer);
        headUpStartTranscriptionTimer = null;
      }
    };

    /** Display dashboard (status line only); clear after timeout if user doesn't look up */
    const showDashboard = () => {
      if (!settings.showDashboard) {
        showDisplay(" ", { durationMs: -1 });
        return;
      }
      stopDashboardClearTimer();
      showDisplay(getStatusLine(), { durationMs: -1 });
      const timeout = getDashboardTimeoutMs();
      if (timeout > 0) {
        dashboardClearTimer = setTimeout(() => {
          dashboardClearTimer = null;
          if (state === SessionState.IDLE) {
            showDisplay(" ", { durationMs: -1 });
          }
        }, timeout);
      }
    };

    const entry: registry.SessionEntry = {
      session,
      sessionId,
      userId,
      state: SessionState.IDLE as registry.SessionStateLabel,
      copilot: settings.copilotModeDefault,
      aiMode: settings.defaultAIMode,
      lastTranscriptAt: null,
      copilotPipeline: { totalFiltered: 0, totalPassed: 0, bufferSize: 0, inflight: false },
      requestListening(listening: boolean) {
        if (listening && state === SessionState.IDLE) {
          stopDashboardClearTimer();
          setState(SessionState.LISTENING);
          showDisplay("Starting Transcription...", { durationMs: -1 });
        } else if (!listening && (state === SessionState.LISTENING || state === SessionState.DICTATING)) {
          setState(SessionState.IDLE);
          showDashboard();
        }
      },
      showPushText(text: string, durationMs: number) {
        stopPushScroll();
        const content = text.trim() || " ";
        pushTokens = content.split(/(\n)| +/).filter(Boolean);
        pushRenderedWordCount = 0;

        const displayPushViewport = () => {
          const viewport = pushView.getViewport();
          showDisplay(joinViewportLinesWithSpaces(viewport.lines), { durationMs: -1 });
        };

        const renderNextPushWord = () => {
          if (pushRenderedWordCount >= pushTokens.length) {
            pushWordRenderTimer = null;
            return;
          }
          pushRenderedWordCount++;
          let textToShow = "";
          for (let i = 0; i < pushRenderedWordCount; i++) {
            const token = pushTokens[i];
            if (token === "\n") {
              textToShow += "\n";
            } else {
              if (textToShow.length > 0 && !textToShow.endsWith("\n")) {
                textToShow += " ";
              }
              textToShow += token;
            }
          }
          pushView.setContent(textToShow, { breakMode: "strict-word" });
          pushView.scrollToBottom();
          displayPushViewport();
          if (pushRenderedWordCount < pushTokens.length) {
            pushWordRenderTimer = setTimeout(renderNextPushWord, getWordRenderDelayMs());
          }
        };

        if (pushTokens.length === 0) {
          pushView.setContent(content, { breakMode: "strict-word" });
          pushView.scrollToBottom();
          displayPushViewport();
        } else {
          renderNextPushWord();
        }
        // Keep push text on display; do not restore welcome/transcript/response
      },
    };
    registry.register(entry);

    const setState = (s: SessionState) => {
      state = s;
      entry.state = s as registry.SessionStateLabel;
      updateMirrorSessionState(sessionId, s, entry.copilot);
      if (s === SessionState.IDLE) setImmediate(tryProcessPendingCopilotBatch);
    };

    // Copilot mode buffer - debounce time from settings
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
      showDisplay(text, { durationMs: -1 });
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
          pendingSpace = false;
          renderedWordCount = 0;
          streamComplete = false;
          if (noReply) {
            showDashboard();
          } else {
            // Keep response on display for 5s, then clear
            stopResponseClearTimer();
            responseClearTimer = setTimeout(() => {
              responseClearTimer = null;
              if (state === SessionState.IDLE) {
                showDisplay(" ", { durationMs: -1 });
              }
            }, getResponseTimeoutMs());
          }
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
      wordRenderTimer = setTimeout(renderNextWord, getWordRenderDelayMs());
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
      const triggers = getTriggerWords();
      for (const trigger of triggers) {
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
      const clears = getClearWords();
      return clears.some((c) => s === c || s.endsWith(" " + c));
    };

    /** Check for copilot voice command; returns "on" | "off" | "toggle" | null */
    const getCopilotVoiceCommand = (text: string): "on" | "off" | "toggle" | null => {
      const s = text.trim().toLowerCase();
      if (s.includes("copilot on") || s.includes("copilot an")) return "on";
      if (s.includes("copilot off") || s.includes("copilot aus")) return "off";
      if (s.includes("copilot mode") || s.includes("new session") || s.includes("neue session")) return "toggle";
      return null;
    };

    /** Check for AI mode voice command; returns "claude" | "openclaw" | "toggle" | null */
    const getAIModeVoiceCommand = (text: string): "claude" | "openclaw" | "toggle" | null => {
      const s = text.trim().toLowerCase();
      for (const phrase of AI_MODE_PHRASES.claude) {
        if (s.includes(phrase)) return "claude";
      }
      for (const phrase of AI_MODE_PHRASES.openclaw) {
        if (s.includes(phrase)) return "openclaw";
      }
      for (const phrase of AI_MODE_PHRASES.toggle) {
        if (s.includes(phrase)) return "toggle";
      }
      return null;
    };

    /** Clear display from any state - hides all text silently */
    const clearDisplay = (fromInterim = false) => {
      // Stop any ongoing streaming/rendering
      stopWordRenderer();
      stopResponseClearTimer();
      stopDashboardClearTimer();

      // Clear all state
      transcriptSegments = [];
      currentInterim = "";
      lastInterimTriggerText = "";
      clearedFromInterim = fromInterim;
      responseBuffer = "";
      pendingSpace = false;
      renderedWordCount = 0;
      streamComplete = false;
      lastAnswer = "";

      // Clear views
      transcriptView.clear();
      responseView.clear();

      // Set to IDLE and hide display (blank screen)
      setState(SessionState.IDLE);
      showDisplay(" ", { durationMs: -1 });
    };

    /** Clear transcript and reset to idle (alias for clearDisplay) */
    const clearTranscript = (fromInterim = false) => {
      clearDisplay(fromInterim);
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
      showDisplay(text, { durationMs: -1 });
    };

    /** Show transcript on display with ScrollView */
    const showTranscript = () => {
      if (state === SessionState.SENDING || state === SessionState.STREAMING) return;

      // Check if live transcription display is enabled
      if (!settings.showLiveTranscription) return;

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

    /** Deploy an agent (Cursor or Claude) */
    const handleAgentDeploy = async (prompt: string, agentType: "cursor" | "claude") => {
      setState(SessionState.SENDING);
      transcriptSegments = [];
      currentInterim = "";
      lastInterimTriggerText = "";
      transcriptView.clear();

      const agentName = agentType === "cursor" ? "Cursor" : "Claude";
      showDisplay(`Deploying ${agentName} agent...`, { durationMs: -1 });
      session.logger.info(`[AgentDeploy] Deploying ${agentType} agent: "${prompt.slice(0, 50)}..."`);

      try {
        // Check if configured
        const status = getAgentStatus();
        if (agentType === "cursor" && !status.cursor.configured) {
          showDisplay("Cursor not configured. Set CURSOR_API_KEY.", { durationMs: 5000 });
          setTimeout(() => { setState(SessionState.IDLE); showDashboard(); }, 5000);
          return;
        }
        if (agentType === "claude" && !status.claude.configured) {
          showDisplay("Claude not configured. Set ANTHROPIC_API_KEY.", { durationMs: 5000 });
          setTimeout(() => { setState(SessionState.IDLE); showDashboard(); }, 5000);
          return;
        }

        // Get default repository from env for Cursor
        const repository = process.env.CURSOR_DEFAULT_REPO || process.env.GITHUB_REPOSITORY;

        const result = await deployAgent({
          type: agentType,
          prompt,
          repository: agentType === "cursor" ? repository : undefined,
          autoCreatePr: true,
          allowedTools: ["Read", "Edit", "Bash", "Glob", "Grep", "Write"],
        });

        if (result.success) {
          const statusText = result.status === "RUNNING" ? "running" : "deployed";
          const idShort = result.agentId?.slice(-8) || "";
          showDisplay(`${agentName} agent ${statusText}${idShort ? `: ${idShort}` : ""}`, { durationMs: 5000 });
          session.logger.info(`[AgentDeploy] Success: ${result.agentId} status=${result.status}`);
        } else {
          showDisplay(`Deploy failed: ${result.error?.slice(0, 50)}`, { durationMs: 5000 });
          session.logger.error(`[AgentDeploy] Failed: ${result.error}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        showDisplay(`Error: ${message.slice(0, 50)}`, { durationMs: 5000 });
        session.logger.error(`[AgentDeploy] Error: ${message}`);
      }

      setTimeout(() => { setState(SessionState.IDLE); showDashboard(); }, 5000);
    };

    /** Common streaming callbacks for both OpenClaw and Claude Code */
    const getStreamCallbacks = () => ({
      onDelta: (delta: string) => {
        if (state !== SessionState.STREAMING) {
          setState(SessionState.STREAMING);
        }
        // Detect word boundary BEFORE any trimming: space at end of buffer OR start of delta OR pending from previous whitespace-only delta
        const bufferHadTrailingSpace = /\s$/.test(responseBuffer);
        const deltaHasLeadingSpace = /^\s/.test(delta);
        const needsSpace = pendingSpace || bufferHadTrailingSpace || deltaHasLeadingSpace;

        // Normalize: remove trailing space from buffer
        responseBuffer = responseBuffer.replace(/\s+$/, "");

        // Contraction: don't add space before "'t", "'s", etc.
        if (delta.startsWith("'")) {
          pendingSpace = false;
          responseBuffer += delta;
          responseBuffer = formatResponseText(responseBuffer);
          if (process.env.DEBUG === "1" || process.env.LOG_SSE === "1") {
            session.logger.info(
              { deltaLen: delta.length, bufferLen: responseBuffer.length, tail: responseBuffer.slice(-100) },
              "onDelta"
            );
          }
          startWordRenderer();
          return;
        }
        const deltaTrimmed = delta.replace(/^\s+/, "");
        if (deltaTrimmed.length === 0) {
          // Whitespace-only delta: remember to add space before next content
          pendingSpace = true;
          responseBuffer = formatResponseText(responseBuffer);
          if (process.env.DEBUG === "1" || process.env.LOG_SSE === "1") {
            session.logger.info(
              { deltaLen: delta.length, bufferLen: responseBuffer.length, tail: responseBuffer.slice(-100) },
              "onDelta"
            );
          }
          startWordRenderer();
          return;
        }
        // Only add space if the original stream had whitespace at the boundary
        // This preserves word integrity: "opencl" + "aw" -> "openclaw" (no space)
        // But "open" + " claw" -> "open claw" (space from delta)
        if (responseBuffer.length > 0 && needsSpace) {
          responseBuffer += " ";
        }
        pendingSpace = false;
        responseBuffer += deltaTrimmed;
        // Format the entire buffer for proper list display
        responseBuffer = formatResponseText(responseBuffer);
        if (process.env.DEBUG === "1" || process.env.LOG_SSE === "1") {
          session.logger.info(
            { deltaLen: delta.length, bufferLen: responseBuffer.length, tail: responseBuffer.slice(-100) },
            "onDelta"
          );
        }
        startWordRenderer();
      },
      onDone: () => {
        // Continue rendering remaining words
      },
      onCompleted: () => {
        if (process.env.DEBUG === "1" || process.env.LOG_SSE === "1") {
          session.logger.info(
            { responseLen: responseBuffer.length, tail: responseBuffer.slice(-200) },
            "stream completed"
          );
        }
        streamComplete = true;
        if (responseBuffer.length === 0) {
          currentSendIsCopilot = false;
          showDisplay("Done.", { durationMs: 2000 });
          setTimeout(() => {
            setState(SessionState.IDLE);
            showDashboard();
          }, 2000);
        }
        // Otherwise renderNextWord handles transition when done
      },
      onFailed: (err: unknown) => {
        currentSendIsCopilot = false;
        stopWordRenderer();
        const message = err instanceof Error ? err.message : String(err);
        const backend = entry.aiMode === "claude" ? "Claude Code" : "OpenClaw";
        showDisplay(`Error: ${message.slice(0, 60)}`, { durationMs: 5000 });
        session.logger.error(
          { err: err instanceof Error ? err.stack : String(err) },
          `${backend} request failed`
        );
        setTimeout(() => {
          setState(SessionState.IDLE);
          responseBuffer = "";
          pendingSpace = false;
          renderedWordCount = 0;
          streamComplete = false;
          showDashboard();
        }, 5000);
      },
    });

    /** Send prompt to AI backend (OpenClaw or Claude Code based on entry.aiMode) */
    const sendToAI = (prompt: string) => {
      if (state === SessionState.SENDING || state === SessionState.STREAMING) {
        session.logger.warn("Ignoring send - already processing");
        return;
      }

      if (!prompt) {
        session.logger.warn("Empty prompt, ignoring");
        showTranscript();
        return;
      }

      // Check for agent deployment commands
      const agentCmd = parseAgentCommand(prompt);
      if (agentCmd.isAgentCommand && agentCmd.request) {
        session.logger.info(`[AgentCommand] Detected ${agentCmd.request.type} agent command`);
        handleAgentDeploy(agentCmd.request.prompt, agentCmd.request.type);
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
      pendingSpace = false;
      renderedWordCount = 0;
      streamComplete = false;
      responseView.clear();

      showDisplay("Thinking...", { durationMs: -1 });

      const callbacks = getStreamCallbacks();

      // Route to appropriate AI backend based on mode
      if (entry.aiMode === "claude") {
        if (!claudeCodeConfig) {
          showDisplay("Claude Code not configured. Set ANTHROPIC_API_KEY.", { durationMs: 5000 });
          setTimeout(() => { setState(SessionState.IDLE); showDashboard(); }, 5000);
          return;
        }
        session.logger.info(
          `Sending to Claude Code: prompt="${prompt.slice(0, 50)}${prompt.length > 50 ? "..." : ""}"`
        );
        streamClaudeCodeResponse(claudeCodeConfig, prompt, callbacks, {
          systemPrompt: getSystemPrompt(),
        });
      } else {
        if (!openclawConfig) {
          showDisplay("OpenClaw not configured. Set OPENCLAW_GATEWAY_URL.", { durationMs: 5000 });
          setTimeout(() => { setState(SessionState.IDLE); showDashboard(); }, 5000);
          return;
        }
        const openclawUrl = `${openclawConfig.baseUrl.replace(/\/$/, "")}/v1/responses`;
        session.logger.info(
          `Sending to OpenClaw: ${openclawUrl} prompt="${prompt.slice(0, 50)}${prompt.length > 50 ? "..." : ""}"`
        );
        streamOpenClawResponse(openclawConfig, prompt, callbacks, {
          user: userId,
          systemPrompt: getSystemPrompt(),
        });
      }
    };

    /** Alias for backward compatibility */
    const sendToOpenClaw = sendToAI;

    // Show last answer on reconnect, or welcome if no answer yet
    if (lastAnswer) {
      showDisplay(lastAnswer, { durationMs: -1 });
    } else {
      showDashboard();
    }

    // Handle transcription events
    const unsubTranscription = session.events.onTranscription((data) => {
      const text = data.text?.trim() ?? "";

      // Check for clear command FIRST - works in any state, hides display without transcribing
      if (text && isClearCommand(text)) {
        clearDisplay(data.isFinal ? false : true);
        return;
      }

      // Ignore other transcription while idle (welcome showing), sending, or streaming
      if (state === SessionState.IDLE || state === SessionState.SENDING || state === SessionState.STREAMING) {
        return;
      }

      if (!data.isFinal) {
        // Interim transcription
        currentInterim = text;

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

      const copilotCmd = getCopilotVoiceCommand(text);
      if (copilotCmd !== null) {
        if (copilotCmd === "toggle") {
          entry.copilot = !entry.copilot;
        } else if (copilotCmd === "on") {
          entry.copilot = true;
        } else {
          entry.copilot = false;
        }
        showDisplay(
          `Copilot ${entry.copilot ? "on" : "off"}.`,
          { durationMs: 2000 }
        );
        setTimeout(showDashboard, 2000);
        return;
      }

      // Check for AI mode voice command (claude mode / openclaw mode / switch mode)
      const aiModeCmd = getAIModeVoiceCommand(text);
      if (aiModeCmd !== null) {
        if (aiModeCmd === "toggle") {
          entry.aiMode = entry.aiMode === "openclaw" ? "claude" : "openclaw";
        } else {
          entry.aiMode = aiModeCmd;
        }
        const modeName = entry.aiMode === "claude" ? "Claude" : "OpenClaw";
        showDisplay(`${modeName} mode.`, { durationMs: 2000 });
        session.logger.info(`[AIMode] Switched to ${entry.aiMode} mode`);
        setTimeout(showDashboard, 2000);
        return;
      }

      // When copilot is on: accumulate in buffer and debounce; do not send on trigger
      if (entry.copilot) {
        copilotBuffer.push(text);
        entry.copilotPipeline.bufferSize = copilotBuffer.length;
        clearCopilotDebounce();
        copilotDebounceTimer = setTimeout(flushCopilotBuffer, getCopilotDebounceMs());
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
          showDisplay("Say something before the trigger word.", { durationMs: 2000 });
          setTimeout(showDashboard, 2000);
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
      // Head up: start listening for transcription after sustained 2s
      if (data.position === "up") {
        if (state === SessionState.IDLE && !headUpStartTranscriptionTimer) {
          headUpStartTranscriptionTimer = setTimeout(() => {
            headUpStartTranscriptionTimer = null;
            stopDashboardClearTimer();
            setState(SessionState.LISTENING);
            showDisplay("Starting Transcription...", { durationMs: -1 });
          }, getHeadUpDelayMs());
        }
        return;
      }

      // Head no longer up: cancel pending start-transcription
      stopHeadUpStartTranscriptionTimer();

      // Head down: various actions
      if (data.position !== "down") return;

      if (state === SessionState.STREAMING) {
        stopResponseClearTimer();
        stopWordRenderer();
        responseBuffer = "";
        pendingSpace = false;
        renderedWordCount = 0;
        streamComplete = false;
        responseView.clear();
        setState(SessionState.IDLE);
        lastAnswer = "";
        showDashboard();
        return;
      }

      if (state === SessionState.IDLE && lastAnswer) {
        stopResponseClearTimer();
        lastAnswer = "";
        responseView.clear();
        showDashboard();
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
          showDashboard();
        }
      }
    });

    glassesBatteryLevel = session.device.state.batteryLevel.value;
    const unsubGlassesBattery = session.device.state.batteryLevel.onChange((level) => {
      glassesBatteryLevel = level;
    });

    // Listen for settings changes from MentraOS
    const unsubSettings = settings.onChange((key, value) => {
      session.logger.info({ key, value }, "Setting changed");

      // Handle specific setting changes that need runtime adjustments
      if (key === "show_dashboard" && state === SessionState.IDLE) {
        showDashboard();
      }
    });

    session.events.onDisconnected(() => {
      session.logger.info(`Session ${sessionId} disconnected.`);
      clearCopilotDebounce();
      registry.unregister(sessionId);
      clearMirrorSession(sessionId);
      unsubTranscription();
      unsubHeadPosition();
      unsubGlassesBattery();
      unsubSettings();
      stopWordRenderer();
      stopDashboardClearTimer();
      stopResponseClearTimer();
      stopHeadUpStartTranscriptionTimer();
      stopPushScroll();
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
app.post("/mode", pushRoutes.handleModePost);
app.get("/mode", pushRoutes.handleModeGet);
app.get("/status", pushRoutes.handleStatus);
app.get("/debug", pushRoutes.handleDebug);
// Agent deployment routes
app.get("/agents/status", pushRoutes.handleAgentsStatus);
app.post("/agents/deploy", pushRoutes.handleAgentDeploy);
app.get("/agents/cursor", pushRoutes.handleCursorAgentsList);
app.get("/agents/cursor/:id", pushRoutes.handleCursorAgentStatus);
app.post("/preview/prompt", (req, res) => {
  const promptRaw = req.body?.prompt;
  if (typeof promptRaw !== "string" || !promptRaw.trim()) {
    res.status(400).json({ error: "prompt is required" });
    return;
  }
  const prompt = promptRaw.trim();

  const config = getOpenClawConfigFromEnv();
  if (!config && process.env.OPENCLAW_TEST_MODE !== "1") {
    res.status(503).json({ error: "OpenClaw not configured" });
    return;
  }

  startPreview(prompt);

  const effectiveConfig =
    config ??
    ({
      baseUrl: "http://localhost",
      token: "test-token",
      agentId: "preview-test",
    } as const);

  void streamOpenClawResponse(
    effectiveConfig,
    prompt,
    {
      onDelta: (delta) => appendPreviewDelta(delta),
      onDone: () => {
        /* no-op */
      },
      onCompleted: () => {
        completePreview();
      },
      onFailed: (err) => {
        failPreview(err);
      },
    },
    { user: "preview" }
  );

  res.status(202).json({ status: "started" });
});

app.get("/preview/state", (_req, res) => {
  const state = getPreviewState();
  res.json({
    ...state,
    content: formatForDisplay(state.content),
  });
});

app.get("/preview", (_req, res) => {
  const url = new URL("../public/preview.html", import.meta.url);
  res.sendFile(url.pathname);
});

app.get("/mirror/state", (_req, res) => {
  res.json(getMirrorState());
});

app.get("/mirror", (_req, res) => {
  const url = new URL("../public/mirror.html", import.meta.url);
  res.sendFile(url.pathname);
});
export { app, server };

if (process.env.NODE_ENV !== "test") {
  server.start()
    .then(() => {
      fetchSpyPrice();
      fetchWestwoodWeather();
      setInterval(fetchSpyPrice, 60_000);
      setInterval(fetchWestwoodWeather, 60_000);
    })
    .catch((err) => {
      console.error("Failed to start server:", err);
      process.exit(1);
    });
}
