import { describe, it, expect, beforeEach } from "vitest";
import { streamOpenClawResponse, OpenClawConfig } from "../../src/openclaw.js";

describe("streamOpenClawResponse in test mode", () => {
  beforeEach(() => {
    process.env.OPENCLAW_TEST_MODE = "1";
  });

  it("invokes callbacks with a synthetic response without network calls", async () => {
    const config: OpenClawConfig = {
      baseUrl: "https://example.com",
      token: "dummy",
      agentId: "test",
    };

    const deltas: string[] = [];
    let done = false;
    let completed = false;

    await streamOpenClawResponse(config, "Hello", {
      onDelta: (d) => deltas.push(d),
      onDone: () => {
        done = true;
      },
      onCompleted: () => {
        completed = true;
      },
      onFailed: (err) => {
        throw err instanceof Error ? err : new Error(String(err));
      },
    });

    expect(deltas.length).toBeGreaterThan(0);
    expect(done).toBe(true);
    expect(completed).toBe(true);
    const joined = deltas.join(" ");
    expect(joined).toContain("1. *This* is a **test** response");
  });
});

