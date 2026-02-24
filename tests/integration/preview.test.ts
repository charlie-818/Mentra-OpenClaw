import { describe, it, beforeAll, expect } from "vitest";
import request from "supertest";

let app: import("express").Express;

describe("Preview endpoints", () => {
  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY || "test-key";
    process.env.PACKAGE_NAME = process.env.PACKAGE_NAME || "com.example.mentra-openclaw-bridge.test";
    process.env.PORT = process.env.PORT || "0";
    process.env.OPENCLAW_TEST_MODE = "1";
    process.env.OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || "https://example.com";
    process.env.OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "dummy-token";

    const mod = await import("../../src/index.js");
    app = mod.app;
  });

  it("rejects missing prompt", async () => {
    const res = await request(app).post("/preview/prompt").send({});
    expect(res.status).toBe(400);
  });

  it("streams a synthetic preview response and exposes it via /preview/state", async () => {
    const startRes = await request(app)
      .post("/preview/prompt")
      .send({ prompt: "Test preview" })
      .set("Content-Type", "application/json");

    expect(startRes.status).toBe(202);

    const stateRes = await request(app).get("/preview/state");
    expect(stateRes.status).toBe(200);
    expect(stateRes.body.status === "completed" || stateRes.body.status === "streaming").toBe(true);
    const content: string = stateRes.body.content;
    expect(content).toContain("This is a test response");
    expect(content.includes("*")).toBe(false);
    expect(content.includes("**")).toBe(false);
  });
});

