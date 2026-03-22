/**
 * Settings management module for OpenClaw Bridge.
 * Integrates with MentraOS SettingsManager for user-configurable app settings.
 */

import type { AppSession } from "@mentra/sdk";

/**
 * Setting types matching MentraOS SDK configuration.
 */
export type SettingType = "toggle" | "text" | "select" | "number" | "group";

/**
 * AI mode type.
 */
export type AIMode = "openclaw" | "claude";

/**
 * All configurable settings for OpenClaw Bridge.
 */
export interface OpenClawSettings {
  // General
  show_live_transcription: boolean;
  response_speed: "fast" | "normal" | "slow";
  timezone: string;

  // Voice Commands
  trigger_words: string;
  clear_words: string;
  copilot_mode_default: boolean;
  copilot_debounce_seconds: number;

  // Display/Dashboard
  show_dashboard: boolean;
  show_battery: boolean;
  show_weather: boolean;
  show_stock_price: boolean;
  dashboard_timeout_seconds: number;
  response_timeout_seconds: number;

  // AI Configuration
  default_ai_mode: AIMode;
  ai_response_style: "concise" | "balanced" | "detailed";
  custom_system_prompt: string;
  head_up_delay_seconds: number;

  // Agent Settings
  enable_agent_commands: boolean;
  default_repository: string;
}

/**
 * Default settings values matching app_config.json.
 */
export const DEFAULT_SETTINGS: OpenClawSettings = {
  // General
  show_live_transcription: true,
  response_speed: "normal",
  timezone: "America/Los_Angeles",

  // Voice Commands
  trigger_words: "mac,jarvis,send,execute",
  clear_words: "clear,stop,reset,cancel",
  copilot_mode_default: false,
  copilot_debounce_seconds: 3,

  // Display/Dashboard
  show_dashboard: true,
  show_battery: true,
  show_weather: true,
  show_stock_price: true,
  dashboard_timeout_seconds: 5,
  response_timeout_seconds: 5,

  // AI Configuration
  default_ai_mode: "openclaw",
  ai_response_style: "concise",
  custom_system_prompt: "",
  head_up_delay_seconds: 2,

  // Agent Settings
  enable_agent_commands: true,
  default_repository: "",
};

/**
 * Response speed to milliseconds mapping.
 */
export const RESPONSE_SPEED_MS: Record<OpenClawSettings["response_speed"], number> = {
  fast: 60,
  normal: 120,
  slow: 200,
};

/**
 * AI response style system prompt modifiers.
 */
export const RESPONSE_STYLE_PROMPTS: Record<OpenClawSettings["ai_response_style"], string> = {
  concise:
    "Keep answers extremely brief - 1-2 sentences max. Focus on the most essential information only.",
  balanced:
    "Provide balanced answers with key details. Use 2-4 sentences when needed.",
  detailed:
    "Provide thorough answers with context and explanations. Be comprehensive but stay focused.",
};

/**
 * SessionSettings wraps MentraOS SettingsManager with typed accessors.
 */
export class SessionSettings {
  private session: AppSession;
  private cache: Partial<OpenClawSettings> = {};
  private changeCallbacks: Array<(key: keyof OpenClawSettings, value: unknown) => void> = [];

  constructor(session: AppSession) {
    this.session = session;
    this.initializeFromSession();
    this.setupChangeListeners();
  }

  /**
   * Initialize settings cache from session.
   */
  private initializeFromSession(): void {
    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof OpenClawSettings>) {
      try {
        const value = this.session.settings.get(key, DEFAULT_SETTINGS[key]);
        (this.cache as Record<string, unknown>)[key] = value;
      } catch {
        (this.cache as Record<string, unknown>)[key] = DEFAULT_SETTINGS[key];
      }
    }
  }

  /**
   * Set up listeners for settings changes from MentraOS.
   */
  private setupChangeListeners(): void {
    this.session.events.onSettingsUpdate?.(() => {
      this.refreshAll();
    });
  }

  /**
   * Refresh all settings from session.
   */
  refreshAll(): void {
    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof OpenClawSettings>) {
      const oldValue = this.cache[key];
      const newValue = this.session.settings.get(key, DEFAULT_SETTINGS[key]);
      if (oldValue !== newValue) {
        (this.cache as Record<string, unknown>)[key] = newValue;
        this.notifyChange(key, newValue);
      }
    }
  }

  /**
   * Notify all registered callbacks of a setting change.
   */
  private notifyChange(key: keyof OpenClawSettings, value: unknown): void {
    for (const callback of this.changeCallbacks) {
      try {
        callback(key, value);
      } catch (err) {
        this.session.logger.error({ err, key }, "Error in settings change callback");
      }
    }
  }

  /**
   * Register a callback for settings changes.
   */
  onChange(callback: (key: keyof OpenClawSettings, value: unknown) => void): () => void {
    this.changeCallbacks.push(callback);
    return () => {
      const index = this.changeCallbacks.indexOf(callback);
      if (index !== -1) {
        this.changeCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Get a setting value with type safety.
   */
  get<K extends keyof OpenClawSettings>(key: K): OpenClawSettings[K] {
    if (key in this.cache) {
      return this.cache[key] as OpenClawSettings[K];
    }
    return DEFAULT_SETTINGS[key];
  }

  /**
   * Get all settings.
   */
  getAll(): OpenClawSettings {
    return { ...DEFAULT_SETTINGS, ...this.cache } as OpenClawSettings;
  }

  // Convenience getters for common settings

  get showLiveTranscription(): boolean {
    return this.get("show_live_transcription");
  }

  get responseSpeedMs(): number {
    return RESPONSE_SPEED_MS[this.get("response_speed")];
  }

  get timezone(): string {
    return this.get("timezone") || DEFAULT_SETTINGS.timezone;
  }

  get triggerWords(): string[] {
    const raw = this.get("trigger_words") || DEFAULT_SETTINGS.trigger_words;
    const list = raw
      .split(",")
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean);
    return list.length > 0
      ? list.sort((a, b) => b.length - a.length)
      : DEFAULT_SETTINGS.trigger_words.split(",");
  }

  get clearWords(): string[] {
    const raw = this.get("clear_words") || DEFAULT_SETTINGS.clear_words;
    return raw
      .split(",")
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean);
  }

  get copilotModeDefault(): boolean {
    return this.get("copilot_mode_default");
  }

  get copilotDebounceMs(): number {
    return this.get("copilot_debounce_seconds") * 1000;
  }

  get showDashboard(): boolean {
    return this.get("show_dashboard");
  }

  get showBattery(): boolean {
    return this.get("show_battery");
  }

  get showWeather(): boolean {
    return this.get("show_weather");
  }

  get showStockPrice(): boolean {
    return this.get("show_stock_price");
  }

  get dashboardTimeoutMs(): number {
    return this.get("dashboard_timeout_seconds") * 1000;
  }

  get responseTimeoutMs(): number {
    return this.get("response_timeout_seconds") * 1000;
  }

  get defaultAIMode(): AIMode {
    return this.get("default_ai_mode");
  }

  get aiResponseStyle(): OpenClawSettings["ai_response_style"] {
    return this.get("ai_response_style");
  }

  get customSystemPrompt(): string {
    return this.get("custom_system_prompt");
  }

  get headUpDelayMs(): number {
    return this.get("head_up_delay_seconds") * 1000;
  }

  get enableAgentCommands(): boolean {
    return this.get("enable_agent_commands");
  }

  get defaultRepository(): string {
    return this.get("default_repository");
  }

  /**
   * Build the complete system prompt based on settings.
   */
  buildSystemPrompt(): string {
    const custom = this.customSystemPrompt.trim();
    if (custom) {
      return custom;
    }

    const basePrompt = [
      "You are an assistant for AR smart glasses.",
      "Answer in clear, simple plain language.",
      "Optimize for a very small, narrow display that is read at a glance.",
      "Use short sentences and keep each idea on its own line.",
      "Do not use markdown or formatting syntax of any kind.",
      "Do not use bullets, numbered lists, headings, code blocks, or emojis.",
      "Avoid decorative characters like asterisks, dashes used as bullets, or box drawing.",
    ].join(" ");

    const styleModifier = RESPONSE_STYLE_PROMPTS[this.aiResponseStyle];
    return `${basePrompt} ${styleModifier}`;
  }
}

/**
 * Get environment variable with settings override.
 * Settings from MentraOS take precedence over environment variables.
 */
export function getSettingOrEnv<K extends keyof OpenClawSettings>(
  settings: SessionSettings | null,
  key: K,
  envVar: string
): OpenClawSettings[K] {
  if (settings) {
    return settings.get(key);
  }
  const envValue = process.env[envVar];
  if (envValue !== undefined) {
    // Type coercion based on default value type
    const defaultValue = DEFAULT_SETTINGS[key];
    if (typeof defaultValue === "boolean") {
      return (envValue === "true" || envValue === "1") as OpenClawSettings[K];
    }
    if (typeof defaultValue === "number") {
      return parseFloat(envValue) as OpenClawSettings[K];
    }
    return envValue as OpenClawSettings[K];
  }
  return DEFAULT_SETTINGS[key];
}
