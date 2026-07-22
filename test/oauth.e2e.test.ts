import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createProxyServer } from "../src/transport/httpServer.js";
import { Tap } from "../src/log/tap.js";
import { randomUUID } from "node:crypto";

/**
 * A fake OAuth-protected upstream MCP server:
 *  - GET  /.well-known/oauth-protected-resource/mcp -> protected-resource metadata
 *  - POST /mcp with no bearer  -> 401 + WWW-Authenticate pointing at its own metadata
 *  - POST /mcp with a bearer   -> initialize succeeds
 */
function startOauthUpstream(): Promise<{ server: Server; url: string; origin: string; as: string }> {
  const as = "https://auth.example.test";
  const server = createServer(async (req, res) => {
    const origin = `http://${req.headers.host}`;
    if (req.method === "GET" && req.url === "/.well-known/oauth-protected-resource/mcp") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [as] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const msg = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (!req.headers["authorization"]) {
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`,
      });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32000, message: "unauthorized" } }));
      return;
    }
    const sid = randomUUID();
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": sid });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { serverInfo: { name: "oauth-fake", version: "1.0" } } }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const origin = `http://127.0.0.1:${addr.port}`;
      resolve({ server, url: `${origin}/mcp`, origin, as });
    });
  });
}

describe("oauth discovery proxying (per-upstream addresses)", () => {
  let a: Awaited<ReturnType<typeof startOauthUpstream>>;
  let b: Awaited<ReturnType<typeof startOauthUpstream>>;
  let proxy: Server;
  let base: string;
  let tap: Tap;

  beforeAll(async () => {
    a = await startOauthUpstream();
    b = await startOauthUpstream();
    tap = new Tap({ upstream: { id: "linear", url: a.url }, recorderVersion: "test" });
    proxy = createProxyServer({
      stage: {
        name: "test",
        upstreams: [
          { id: "linear", url: a.url, auth: { strategy: "passthrough" } },
          { id: "github", url: b.url, auth: { strategy: "passthrough" } },
        ],
      },
      tap,
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
    const addr = proxy.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await tap.close();
    proxy.close();
    a.server.close();
    b.server.close();
  });

  it("serves each upstream's protected-resource metadata at its own address", async () => {
    const linear = await fetch(`${base}/.well-known/oauth-protected-resource/u/linear/mcp`).then((r) => r.json());
    const github = await fetch(`${base}/.well-known/oauth-protected-resource/u/github/mcp`).then((r) => r.json());
    // Relayed verbatim: resource + authorization_servers stay the upstream's, so
    // the token the client obtains is scoped to the upstream, not the proxy.
    expect(linear.resource).toBe(a.url);
    expect(linear.authorization_servers).toEqual([a.as]);
    expect(github.resource).toBe(b.url);
    // Distinct upstreams => distinct discovery documents (the "well-known" problem).
    expect(linear.resource).not.toBe(github.resource);
  });

  it("rewrites the upstream 401 challenge to point at the proxy's metadata URL", async () => {
    const res = await fetch(`${base}/u/linear/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" }, // no bearer -> upstream 401s
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate")!;
    expect(challenge).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/u/linear/mcp"`);
    expect(challenge).toContain('error="invalid_token"'); // upstream's other params preserved
    expect(challenge).not.toContain("127.0.0.1:" + new URL(a.url).port); // upstream pointer gone
  });

  it("passes a bearer through so the upstream authenticates", async () => {
    const res = await fetch(`${base}/u/github/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer good-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.serverInfo.name).toBe("oauth-fake");
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("404s an unknown upstream address", async () => {
    const res = await fetch(`${base}/u/stripe/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(404);
  });
});
