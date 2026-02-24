export type PreviewStatus = "idle" | "pending" | "streaming" | "completed" | "error";

export interface PreviewState {
  status: PreviewStatus;
  prompt: string | null;
  content: string;
  error: string | null;
  updatedAt: number | null;
}

const state: PreviewState = {
  status: "idle",
  prompt: null,
  content: "",
  error: null,
  updatedAt: null,
};

export function startPreview(prompt: string): void {
  state.status = "pending";
  state.prompt = prompt;
  state.content = "";
  state.error = null;
  state.updatedAt = Date.now();
}

export function appendPreviewDelta(delta: string): void {
  if (!delta) return;
  if (state.status === "idle") {
    state.status = "streaming";
  } else if (state.status === "pending") {
    state.status = "streaming";
  }
  state.content += (state.content ? " " : "") + delta;
  state.updatedAt = Date.now();
}

export function completePreview(): void {
  if (state.status === "pending" || state.status === "streaming") {
    state.status = "completed";
    state.updatedAt = Date.now();
  }
}

export function failPreview(err: unknown): void {
  state.status = "error";
  state.error =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : (() => {
            try {
              return JSON.stringify(err);
            } catch {
              return String(err);
            }
          })();
  state.updatedAt = Date.now();
}

export function getPreviewState(): PreviewState {
  // The raw state.content holds the unformatted stream; callers can choose to
  // format it for display. For API consumers we return it as-is and let the
  // shared formatter (used by the preview page and glasses) shape it.
  return { ...state };
}

