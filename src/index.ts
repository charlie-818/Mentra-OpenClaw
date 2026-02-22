import "dotenv/config";
import { AppServer, AppSession } from "@mentra/sdk";
import {
  getOpenClawConfigFromEnv,
  streamOpenClawResponse,
} from "./openclaw";

const PACKAGE_NAME = process.env.PACKAGE_NAME ?? "com.example.mentra-openclaw-bridge";
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY;

/** Throttle display updates to respect Mentra ~1 update per 200ms. */
const DISPLAY_THROTTLE_MS = 250;

if (!MENTRAOS_API_KEY) {
  console.error("MENTRAOS_API_KEY environment variable is required");
  process.exit(1);
}

/**
 * OpenClawBridgeServer – MentraOS app that connects Even G1 glasses to OpenClaw.
 * Voice (final transcription) → OpenClaw; streaming response → TextWall (throttled).
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
        "Mentra connected. You should see this on your glasses."
      );
      session.events.onDisconnected(() => {
        session.logger.info(`Session ${sessionId} disconnected.`);
      });
      return;
    }

    session.layouts.showTextWall("Connected. Say something or press the button.");

    let busy = false;
    let buffer = "";
    let lastDisplayTime = 0;
    let throttleTimer: ReturnType<typeof setTimeout> | null = null;

    const flushDisplay = () => {
      if (buffer.length > 0) {
        session.layouts.showTextWall(buffer);
        lastDisplayTime = Date.now();
      }
      throttleTimer = null;
    };

    const scheduleThrottledDisplay = () => {
      if (throttleTimer !== null) return;
      const elapsed = Date.now() - lastDisplayTime;
      if (elapsed >= DISPLAY_THROTTLE_MS) {
        flushDisplay();
      } else {
        throttleTimer = setTimeout(flushDisplay, DISPLAY_THROTTLE_MS - elapsed);
      }
    };

    const sendToOpenClaw = (userText: string) => {
      if (busy) {
        session.layouts.showTextWall("Busy. Wait for the current response.");
        return;
      }
      busy = true;
      buffer = "";
      lastDisplayTime = 0;
      if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
      }
      session.layouts.showTextWall("Thinking...");

      const openclawUrl = `${openclawConfig.baseUrl.replace(/\/$/, "")}/v1/responses`;
      session.logger.info(
        `Sending to OpenClaw: ${openclawUrl} text="${userText.slice(0, 50)}${userText.length > 50 ? "..." : ""}"`
      );

      streamOpenClawResponse(
        openclawConfig,
        userText,
        {
          onDelta: (delta) => {
            buffer += delta;
            scheduleThrottledDisplay();
          },
          onDone: () => {
            flushDisplay();
          },
          onCompleted: () => {
            if (buffer.length === 0) {
              session.layouts.showTextWall("Done.");
            } else {
              session.layouts.showTextWall(buffer);
            }
            buffer = "";
            busy = false;
            if (throttleTimer) {
              clearTimeout(throttleTimer);
              throttleTimer = null;
            }
          },
          onFailed: (err) => {
            const message = err instanceof Error ? err.message : String(err);
            session.layouts.showTextWall(`OpenClaw error: ${message.slice(0, 80)}`);
            session.logger.error(
              { err: err instanceof Error ? err.stack : String(err) },
              "OpenClaw request failed"
            );
            buffer = "";
            busy = false;
            if (throttleTimer) {
              clearTimeout(throttleTimer);
              throttleTimer = null;
            }
          },
        },
        { user: userId }
      );
    };

    const unsubTranscription = session.events.onTranscription((data) => {
      if (!data.isFinal) return;
      const text = data.text?.trim() ?? "";
      if (text.length > 0) {
        session.logger.info(`Final transcription received: ${text}`);
        sendToOpenClaw(text);
      }
    });

    session.events.onDisconnected(() => {
      session.logger.info(`Session ${sessionId} disconnected.`);
      unsubTranscription();
      if (throttleTimer) clearTimeout(throttleTimer);
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
