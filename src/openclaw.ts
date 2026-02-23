/**
 * OpenClaw Gateway client: POST /v1/responses with stream: true, parse SSE events.
 */

export interface OpenClawConfig {
  baseUrl: string;
  token: string;
  agentId?: string;
}

export type OpenResponsesInput =
  | string
  | Array<{
      type: "message";
      role: "user" | "assistant" | "system";
      content: Array<{ type: "input_text"; text: string }>;
    }>;

export interface SSEEvent {
  event: string;
  data: unknown;
}

export interface OutputTextDelta {
  delta?: string;
  text?: string;
  [key: string]: unknown;
}

/** Token usage from OpenResponses/OpenClaw response (when provider reports it). Supports both naming conventions. */
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  /** OpenAI/OpenClaw style (same as input_tokens). */
  prompt_tokens?: number;
  /** OpenAI/OpenClaw style (same as output_tokens). */
  completion_tokens?: number;
}

/** Payload for response.completed SSE event. */
export interface CompletedPayload {
  usage?: Usage;
  [key: string]: unknown;
}

/**
 * Parse SSE stream from response body. Yields { event, data } for each event.
 */
async function* parseSSE(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  let currentData = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          currentData = line.slice(5).trim();
          if (currentData === "[DONE]") {
            yield { event: "done", data: null };
            currentEvent = "";
            currentData = "";
            continue;
          }
          try {
            const data = JSON.parse(currentData) as unknown;
            yield { event: currentEvent, data };
          } catch {
            yield { event: currentEvent, data: currentData };
          }
          currentEvent = "";
          currentData = "";
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export interface StreamCallbacks {
  onDelta?: (text: string) => void;
  onDone?: () => void;
  onCompleted?: (payload?: CompletedPayload) => void;
  onFailed?: (error: unknown) => void;
}

/**
 * Send a prompt to OpenClaw and stream the response. Invokes callbacks for
 * response.output_text.delta (with delta text), response.output_text.done,
 * response.completed, and response.failed.
 */
export async function streamOpenClawResponse(
  config: OpenClawConfig,
  userMessage: string,
  callbacks: StreamCallbacks,
  options?: { user?: string }
): Promise<void> {
  const url = `${config.baseUrl.replace(/\/$/, "")}/v1/responses`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.token}`,
    "Content-Type": "application/json",
  };
  if (config.agentId) {
    headers["x-openclaw-agent-id"] = config.agentId;
  }

  const body = {
    model: "openclaw",
    stream: true,
    input: [
      {
        type: "message" as const,
        role: "user" as const,
        content: [{ type: "input_text" as const, text: userMessage }],
      },
    ],
    ...(options?.user && { user: options.user }),
  };

  const timeoutMs = 60_000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[OpenClaw] fetch failed: ${url} - ${msg}`);
    const friendlyErr =
      msg.toLowerCase().includes("abort") || msg.toLowerCase().includes("timeout")
        ? new Error(
            `Request timed out (${timeoutMs / 1000}s) - OpenClaw gateway unreachable or slow. Check OPENCLAW_GATEWAY_URL, network, and firewall.`
          )
        : err;
    callbacks.onFailed?.(friendlyErr);
    return;
  } finally {
    clearTimeout(timeoutId);
  }

  console.log(`[OpenClaw] POST ${url} → ${res.status}`);

  if (!res.ok) {
    const errBody = await res.text();
    console.error(`[OpenClaw] HTTP ${res.status}: ${errBody.slice(0, 200)}`);
    callbacks.onFailed?.(new Error(`OpenClaw HTTP ${res.status}: ${errBody}`));
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    callbacks.onFailed?.(new Error("No response body"));
    return;
  }

  const logSSE = process.env.DEBUG === "1" || process.env.LOG_SSE === "1";

  try {
    let hasSentDelta = false;
    for await (const { event, data } of parseSSE(reader)) {
      if (logSSE && typeof data === "object" && data !== null) {
        console.log(`[OpenClaw] SSE event: ${event} keys: ${Object.keys(data).join(", ")}`);
      }
      if (event === "response.output_text.delta") {
        const payload = data as OutputTextDelta;
        const chunk =
          typeof payload?.delta === "string"
            ? payload.delta
            : typeof payload?.text === "string"
              ? payload.text
              : "";
        if (chunk.length > 0) {
          hasSentDelta = true;
          callbacks.onDelta?.(chunk);
        }
      } else if (event === "response.output_text.done") {
        const payload = data as OutputTextDelta;
        if (!hasSentDelta && typeof payload?.text === "string" && payload.text.length > 0) {
          callbacks.onDelta?.(payload.text);
        }
        callbacks.onDone?.();
      } else if (event === "response.completed") {
        callbacks.onCompleted?.(data as CompletedPayload);
      } else if (event === "response.failed") {
        callbacks.onFailed?.(data);
      }
    }
  } catch (err) {
    callbacks.onFailed?.(err);
  }
}

/**
 * Load OpenClaw config from environment.
 */
export function getOpenClawConfigFromEnv(): OpenClawConfig | null {
  const baseUrl = process.env.OPENCLAW_GATEWAY_URL;
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!baseUrl || !token) return null;
  return {
    baseUrl,
    token,
    agentId: process.env.OPENCLAW_AGENT_ID ?? "main",
  };
}
