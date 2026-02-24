import { describe, it, beforeAll, expect } from "vitest";
import request from "supertest";

let app: import("express").Express;

describe("HTTP server basic routes", () => {
  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY || "test-key";
    process.env.PACKAGE_NAME = process.env.PACKAGE_NAME || "com.example.mentra-openclaw-bridge.test";
    process.env.PORT = process.env.PORT || "0";

    const mod = await import("../../src/index.js");
    app = mod.app;
  });

  it("responds to /health with 200", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });

  it("responds to /status with 200", async () => {
    const res = await request(app).get("/status");
    expect(res.status).toBe(200);
  });
});

