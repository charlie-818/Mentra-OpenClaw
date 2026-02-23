/**
 * LLM pre-filter for copilot mode: classify transcript batch as SKIP or RELEVANT.
 * Uses FILTER_LLM_URL (e.g. Claude Haiku) to reduce API cost.
 */

const FILTER_LLM_URL = process.env.FILTER_LLM_URL;
const FILTER_LLM_API_KEY = process.env.FILTER_LLM_API_KEY;
const FILTER_LLM_MODEL = process.env.FILTER_LLM_MODEL ?? "haiku";

export type FilterResult = "SKIP" | "RELEVANT";

const SYSTEM_PROMPT = `You classify short transcript snippets from a conversation.
Reply with exactly one word: SKIP or RELEVANT.

SKIP: chitchat, filler (hm, yeah, okay), fragments, unclear speech, small talk, greetings.
RELEVANT: factual claims, questions, someone addressing the AI by name, numbers/dates that could be checked, topics that could use a brief fact or suggestion.`;

export function isFilterConfigured(): boolean {
  return !!(FILTER_LLM_URL && FILTER_LLM_API_KEY);
}

/**
 * Classify a transcript batch. Returns SKIP or RELEVANT.
 * If the API fails, returns RELEVANT (safe fallback: send to main AI).
 */
export async function classifyTranscript(
  batch: string,
  _context: string
): Promise<FilterResult> {
  if (!FILTER_LLM_URL || !FILTER_LLM_API_KEY) {
    return "RELEVANT";
  }

  const body = {
    model: FILTER_LLM_MODEL,
    max_tokens: 10,
    messages: [
      { role: "system" as const, content: SYSTEM_PROMPT },
      { role: "user" as const, content: `Classify:\n"${batch.slice(0, 500)}"` },
    ],
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(FILTER_LLM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${FILTER_LLM_API_KEY}`,
        "x-api-key": FILTER_LLM_API_KEY,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      console.error(`[copilot-filter] HTTP ${res.status}`);
      return "RELEVANT";
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data?.choices?.[0]?.message?.content?.trim().toUpperCase() ?? "";
    if (text.includes("SKIP")) return "SKIP";
    return "RELEVANT";
  } catch (err) {
    clearTimeout(timeoutId);
    console.error("[copilot-filter] request failed:", err);
    return "RELEVANT";
  }
}
