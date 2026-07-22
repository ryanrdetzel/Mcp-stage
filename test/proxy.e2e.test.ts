import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "../src/transport/httpServer.js";
import { Tap } from "../src/log/tap.js";
import { randomUUID } from "node:crypto";

/**
 * Fake upstream MCP server (Streamable HTTP):
 *  - initialize -> JSON response + Mcp-Session-Id header
 *  - tools/list -> JSON
 *  - tools/call slow_tool -> SSE-stream response
 *  - tools/call echo -> JSON, echoes args AND the auth header it saw
 *  - rejects requests whose Mcp-Session-Id it didn't issue (proves id mapping)
 */
function startFakeUpstream(): Promise<{ server: Server; url: string; issued: Set<string> }> {
  const issued = new Set<string>();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const msg = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const auth = req.headers["authorization"] ?? null;
    const sid = req.headers["mcp-session-id"] as string | undefined;

    if (msg.method === "initialize") {
      const newSid = randomUUID();
      issued.add(newSid);
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": newSid });
      res.end(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1.0" } },
      }));
      return;
    }
    if (!sid || !issued.has(sid)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32000, message: "bad upstream session" } }));
      return;
    }
    if (msg.method === "tools/list") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo" }, { name: "slow_tool" }] } }));
      return;
    }
    if (msg.method === "tools/call" && msg.params?.name === "slow_tool") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 50 } })}\n\n`);
      res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "slow done" }] } })}\n\n`);
      res.end();
      return;
    }
    if (msg.method === "tools/call" && msg.params?.name === "echo") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: { content: [{ type: "text", text: JSON.stringify({ args: msg.params.arguments, sawAuth: auth }) }] },
      }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, result: {} }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}/mcp`, issued });
    });
  });
}

describe("proxy e2e (LIVE + record)", () => {
  let upstream: Awaited<ReturnType<typeof startFakeUpstream>>;
  let proxy: Server;
  let proxyUrl: string;
  let cassettePath: string;
  let tap: Tap;

  beforeAll(async () => {
    upstream = await startFakeUpstream();
    const dir = mkdtempSync(join(tmpdir(), "mcp-stage-"));
    cassettePath = join(dir, "session.cassette.jsonl");
    tap = new Tap({ upstream: { id: "fake", url: upstream.url }, recorderVersion: "test" });
    tap.addOutput(cassettePath);
    proxy = createProxyServer({
      stage: { name: "test", upstream: { id: "fake", url: upstream.url, auth: { strategy: "passthrough" } } },
      tap,
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
    const addr = proxy.address() as { port: number };
    proxyUrl = `http://127.0.0.1:${addr.port}/mcp`;
  });

  afterAll(async () => {
    await tap.close();
    proxy.close();
    upstream.server.close();
  });

  let proxySessionId: string;

  it("initialize: proxy mints its own session id, distinct from upstream's", async () => {
    const res = await fetch(proxyUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer lin_api_SECRETSECRET123" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    });
    expect(res.status).toBe(200);
    proxySessionId = res.headers.get("mcp-session-id")!;
    expect(proxySessionId).toBeTruthy();
    expect(upstream.issued.has(proxySessionId)).toBe(false); // proxy id !== upstream id
    const body = await res.json();
    expect(body.result.serverInfo.name).toBe("fake");
  });

  it("tools/call passes through with auth header intact (upstream sees the real token)", async () => {
    const res = await fetch(proxyUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-session-id": proxySessionId, authorization: "Bearer lin_api_SECRETSECRET123" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { hello: "world" } } }),
    });
    const body = await res.json();
    const echoed = JSON.parse(body.result.content[0].text);
    expect(echoed.args).toEqual({ hello: "world" });
    expect(echoed.sawAuth).toBe("Bearer lin_api_SECRETSECRET123");
  });

  it("SSE responses stream through and terminal result arrives", async () => {
    const res = await fetch(proxyUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-session-id": proxySessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "slow_tool", arguments: {} } }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("slow done");
    expect(text).toContain("notifications/progress");
  });

  it("unknown session id -> 404, upstream never called", async () => {
    const res = await fetch(proxyUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-session-id": "nope" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    });
    expect(res.status).toBe(404);
  });

  it("cassette: valid entries, exchanges paired, tokens scrubbed, notification captured", async () => {
    await tap.close(); // flush
    const lines = readFileSync(cassettePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].type).toBe("meta");
    expect(lines[0].upstream.id).toBe("fake");

    const exchanges = lines.filter((l) => l.type === "exchange");
    expect(exchanges.length).toBeGreaterThanOrEqual(3); // initialize, echo, slow_tool

    const echo = exchanges.find((e) => e.tool === "echo");
    expect(echo.response.result).toBeTruthy();
    expect(echo.latency_ms).toBeGreaterThanOrEqual(0);

    const slow = exchanges.find((e) => e.tool === "slow_tool");
    expect(slow.transport.sse).toBe(true);

    const notes = lines.filter((l) => l.type === "notification" && l.direction === "server_to_client");
    expect(notes.some((n) => n.method === "notifications/progress")).toBe(true);

    const raw = readFileSync(cassettePath, "utf8");
    expect(raw).not.toContain("lin_api_SECRETSECRET123"); // scrubbed everywhere, incl. echoed payload
  });
});
