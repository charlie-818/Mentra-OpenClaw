import { describe, it, beforeAll, expect } from "vitest";
import request from "supertest";

let app: import("express").Express;

describe("AI Mode routes", () => {
  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY || "test-key";
    process.env.PACKAGE_NAME = process.env.PACKAGE_NAME || "com.example.mentra-openclaw-bridge.test";
    process.env.PORT = process.env.PORT || "0";

    const mod = await import("../../src/index.js");
    app = mod.app;
  });

  it("GET /mode responds with 200 and current mode info", async () => {
    const res = await request(app).get("/mode");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("ok", true);
    expect(res.body).toHaveProperty("aiMode");
    expect(res.body).toHaveProperty("available");
    expect(res.body.available).toHaveProperty("openclaw");
    expect(res.body.available).toHaveProperty("claudeCode");
  });

  it("GET /status includes aiMode field", async () => {
    const res = await request(app).get("/status");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("aiMode");
  });

  it("POST /mode with invalid mode returns 400", async () => {
    const res = await request(app)
      .post("/mode")
      .send({ mode: "invalid" });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });
});
