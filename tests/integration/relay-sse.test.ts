import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, Server, IncomingMessage, ServerResponse } from "http";

// Mock SSE server for testing SSE format (doesn't actually spawn Claude)
function createMockSseServer(port: number): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/mock-query" && req.method === "POST") {
      // Parse body
      let body = "";
      for await (const chunk of req) {
        body += chunk;
      }

      let query: string;
      try {
        const parsed = JSON.parse(body);
        query = parsed.query;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      if (!query) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "query is required" }));
        return;
      }

      // Set up SSE
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      // Send mock SSE events
      res.write(`data: ${JSON.stringify({ type: "delta", text: "Hello " })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "delta", text: "from " })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "delta", text: "mock" })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
      res.end();
      return;
    }

    if (url.pathname === "/mock-error" && req.method === "POST") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      res.write(`data: ${JSON.stringify({ type: "error", error: "Simulated error" })}\n\n`);
      res.end();
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
}

// Helper to parse SSE stream
async function parseSSE(response: Response): Promise<Array<{ type: string; text?: string; error?: string }>> {
  const text = await response.text();
  const events: Array<{ type: string; text?: string; error?: string }> = [];

  const lines = text.split("\n");
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const data = line.slice(6);
      try {
        events.push(JSON.parse(data));
      } catch {
        // Skip malformed JSON
      }
    }
  }

  return events;
}

describe("SSE Streaming Format", () => {
  let server: Server;
  let serverUrl: string;

  beforeAll(async () => {
    server = createMockSseServer(0);
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

  describe("POST /mock-query", () => {
    it("returns text/event-stream content type", async () => {
      const res = await fetch(`${serverUrl}/mock-query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test" }),
      });
      expect(res.headers.get("content-type")).toBe("text/event-stream");
    });

    it("returns 200 status for valid request", async () => {
      const res = await fetch(`${serverUrl}/mock-query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test" }),
      });
      expect(res.status).toBe(200);
    });

    it("streams multiple delta events", async () => {
      const res = await fetch(`${serverUrl}/mock-query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test" }),
      });

      const events = await parseSSE(res);
      const deltas = events.filter((e) => e.type === "delta");
      expect(deltas.length).toBe(3);
    });

    it("ends with done event", async () => {
      const res = await fetch(`${serverUrl}/mock-query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test" }),
      });

      const events = await parseSSE(res);
      const lastEvent = events[events.length - 1];
      expect(lastEvent.type).toBe("done");
    });

    it("delta events contain text", async () => {
      const res = await fetch(`${serverUrl}/mock-query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test" }),
      });

      const events = await parseSSE(res);
      const deltas = events.filter((e) => e.type === "delta");
      for (const delta of deltas) {
        expect(delta).toHaveProperty("text");
        expect(typeof delta.text).toBe("string");
      }
    });

    it("reconstructs full response from deltas", async () => {
      const res = await fetch(`${serverUrl}/mock-query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test" }),
      });

      const events = await parseSSE(res);
      const deltas = events.filter((e) => e.type === "delta");
      const fullText = deltas.map((d) => d.text).join("");
      expect(fullText).toBe("Hello from mock");
    });
  });

  describe("Error handling via SSE", () => {
    it("sends error event type", async () => {
      const res = await fetch(`${serverUrl}/mock-error`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test" }),
      });

      const events = await parseSSE(res);
      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeDefined();
    });

    it("error event contains error message", async () => {
      const res = await fetch(`${serverUrl}/mock-error`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test" }),
      });

      const events = await parseSSE(res);
      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent?.error).toBe("Simulated error");
    });
  });

  describe("Request validation", () => {
    it("returns 400 for invalid JSON", async () => {
      const res = await fetch(`${serverUrl}/mock-query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when query is missing", async () => {
      const res = await fetch(`${serverUrl}/mock-query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("error response is JSON", async () => {
      const res = await fetch(`${serverUrl}/mock-query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      expect(body).toHaveProperty("error");
    });
  });
});
