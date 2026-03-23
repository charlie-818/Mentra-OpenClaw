import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, Server, IncomingMessage, ServerResponse } from "http";
import {
  getFullPath,
  getClaudeCliPath,
  buildSpawnEnv,
  runSpawnPreflight,
} from "../../src/relay-utils.js";

// Minimal relay server for testing - simulates the actual server behavior
function createTestServer(port: number): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/health" && req.method === "GET") {
      const preflight = runSpawnPreflight();
      if (preflight.canSpawn) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, cli: preflight.cli.path }));
      } else {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, issues: preflight.issues }));
      }
      return;
    }

    if (url.pathname === "/diagnostics" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(runSpawnPreflight()));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
}

describe("Relay Server HTTP Endpoints", () => {
  let server: Server;
  const port = 0; // Let OS assign a port
  let serverUrl: string;

  beforeAll(async () => {
    server = createTestServer(port);
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const address = server.address();
        if (address && typeof address === "object") {
          serverUrl = `http://localhost:${address.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  describe("GET /health", () => {
    it("responds with JSON", async () => {
      const res = await fetch(`${serverUrl}/health`);
      const contentType = res.headers.get("content-type");
      expect(contentType).toContain("application/json");
    });

    it("returns ok field", async () => {
      const res = await fetch(`${serverUrl}/health`);
      const body = await res.json();
      expect(body).toHaveProperty("ok");
      expect(typeof body.ok).toBe("boolean");
    });

    it("returns cli info when ok", async () => {
      const res = await fetch(`${serverUrl}/health`);
      const body = await res.json();
      if (body.ok) {
        expect(body).toHaveProperty("cli");
      }
    });

    it("returns issues when not ok", async () => {
      const res = await fetch(`${serverUrl}/health`);
      const body = await res.json();
      if (!body.ok) {
        expect(body).toHaveProperty("issues");
        expect(Array.isArray(body.issues)).toBe(true);
      }
    });
  });

  describe("GET /diagnostics", () => {
    it("responds with JSON", async () => {
      const res = await fetch(`${serverUrl}/diagnostics`);
      const contentType = res.headers.get("content-type");
      expect(contentType).toContain("application/json");
    });

    it("returns preflight data", async () => {
      const res = await fetch(`${serverUrl}/diagnostics`);
      const body = await res.json();

      expect(body).toHaveProperty("canSpawn");
      expect(body).toHaveProperty("issues");
      expect(body).toHaveProperty("cli");
      expect(body).toHaveProperty("path");
      expect(body).toHaveProperty("nodeInPath");
    });

    it("includes CLI diagnostics", async () => {
      const res = await fetch(`${serverUrl}/diagnostics`);
      const body = await res.json();

      expect(body.cli).toHaveProperty("found");
      expect(body.cli).toHaveProperty("searchedPaths");
    });

    it("includes PATH diagnostics", async () => {
      const res = await fetch(`${serverUrl}/diagnostics`);
      const body = await res.json();

      expect(body.path).toHaveProperty("nodeBinDir");
      expect(body.path).toHaveProperty("fullPath");
    });
  });

  describe("OPTIONS requests (CORS)", () => {
    it("responds with 204 to OPTIONS", async () => {
      const res = await fetch(`${serverUrl}/health`, { method: "OPTIONS" });
      expect(res.status).toBe(204);
    });

    it("includes CORS headers", async () => {
      const res = await fetch(`${serverUrl}/health`, { method: "OPTIONS" });
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    });
  });

  describe("404 handling", () => {
    it("returns 404 for unknown paths", async () => {
      const res = await fetch(`${serverUrl}/unknown`);
      expect(res.status).toBe(404);
    });

    it("returns JSON error for 404", async () => {
      const res = await fetch(`${serverUrl}/unknown`);
      const body = await res.json();
      expect(body).toHaveProperty("error");
    });
  });
});

describe("Relay Utils Integration", () => {
  it("getFullPath returns valid PATH string", () => {
    const path = getFullPath();
    expect(typeof path).toBe("string");
    expect(path.includes(":")).toBe(true);
  });

  it("buildSpawnEnv returns valid environment", () => {
    const env = buildSpawnEnv();
    expect(env).toHaveProperty("PATH");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("runSpawnPreflight returns diagnostic data", () => {
    const preflight = runSpawnPreflight();
    expect(typeof preflight.canSpawn).toBe("boolean");
    expect(typeof preflight.nodeInPath).toBe("boolean");
    expect(Array.isArray(preflight.issues)).toBe(true);
  });
});
