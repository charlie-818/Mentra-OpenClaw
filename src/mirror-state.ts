export interface MirrorState {
  sessionId: string | null;
  sessionState: "IDLE" | "LISTENING" | "DICTATING" | "SENDING" | "STREAMING" | null;
  displayContent: string;
  copilot: boolean;
  updatedAt: number | null;
  sessionCount: number;
}

const state: MirrorState = {
  sessionId: null,
  sessionState: null,
  displayContent: "",
  copilot: false,
  updatedAt: null,
  sessionCount: 0,
};

export function getMirrorState(): MirrorState {
  return { ...state };
}

export function updateMirrorDisplay(sessionId: string, content: string): void {
  state.sessionId = sessionId;
  state.displayContent = content;
  state.updatedAt = Date.now();
}

export function updateMirrorSessionState(
  sessionId: string,
  sessionState: MirrorState["sessionState"],
  copilot: boolean
): void {
  state.sessionId = sessionId;
  state.sessionState = sessionState;
  state.copilot = copilot;
  state.updatedAt = Date.now();
}

export function registerMirrorSession(sessionId: string): void {
  state.sessionId = sessionId;
  state.sessionCount++;
  state.updatedAt = Date.now();
}

export function clearMirrorSession(sessionId: string): void {
  if (state.sessionId === sessionId) {
    state.sessionId = null;
    state.sessionState = null;
    state.displayContent = "";
    state.copilot = false;
    state.updatedAt = Date.now();
  }
}
