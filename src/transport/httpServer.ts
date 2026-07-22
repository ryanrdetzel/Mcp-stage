import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { SessionManager, type Session } from "../core/session.js";
import { Tap } from "../log/tap.js";
import { buildUpstreamHeaders, forwardToUpstream } from "../modes/live.js";
import { SseParser } from "./sse.js";
import { routeRequest } from "./router.js";
import { oauthEnabled, fetchUpstreamPrm, rewriteWwwAuthenticate, proxyPrmUrl } from "./oauth.js";
import {
  isNotification, isRequest, isResponse,
  type JsonRpcMessage, type StageConfig, type UpstreamConfig,
} from "../core/types.js";

/**
 * Client-facing Streamable HTTP endpoint. PR-scope: LIVE mode + OAuth discovery
 * proxying.
 *
 * Every upstream is mounted at its own address (`/u/<id>/mcp`) so each gets a
 * distinct OAuth `.well-known` namespace. Requests are routed by path; sessions
 * are bound to the upstream they were initialized against.
 *
 * Pipeline per message: transport -> route -> session -> tap -> live handler.
 *
 * Transparency: request/response bodies are forwarded byte-for-byte; the tap
 * parses a copy. Two deliberate rewrites: Mcp-Session-Id (the proxy mints its
 * own toward the client and maps to the upstream's) and, on a 401, the
 * WWW-Authenticate `resource_metadata` pointer (redirected to the proxy's own
 * per-upstream discovery URL).
 */

const MAX_JSON_BODY = 8 * 1024 * 1024; // buffered-JSON cap; SSE bodies stream and are uncapped

export interface ProxyServerOptions {
  stage: StageConfig;
  /** One tap per upstream id — each records to its own file(s). Optional per id. */
  taps?: Map<string, Tap>;
  sessions?: SessionManager;
}

export function createProxyServer(opts: ProxyServerOptions): Server {
  const sessions = opts.sessions ?? new SessionManager();
  const { stage } = opts;
  const taps = opts.taps ?? new Map<string, Tap>();

  const upstreams = new Map<string, UpstreamConfig>();
  for (const u of stage.upstreams) upstreams.set(u.id, u);
  const knownIds = new Set(upstreams.keys());
  const singleId = upstreams.size === 1 ? [...knownIds][0] : undefined;

  return createServer(async (req, res) => {
    try {
      const route = routeRequest(req.url ?? "/", knownIds, singleId);
      if (route.kind === "prm") {
        return await handlePrm(req, res, upstreams.get(route.upstreamId)!);
      }
      if (route.kind === "mcp") {
        const upstream = upstreams.get(route.upstreamId)!;
        if (req.method === "POST") return await handlePost(req, res, upstream);
        if (req.method === "GET") return await handleGet(req, res, upstream);
        if (req.method === "DELETE") return await handleDelete(req, res, upstream);
        res.writeHead(405, { allow: "GET, POST, DELETE" }).end();
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0", id: null,
        error: { code: -32000, message: "Unknown upstream or path (expected /u/<id>/mcp)" },
      }));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0", id: null,
          error: { code: -32001, message: `mcp-stage upstream error: ${(err as Error).message}` },
        }));
      } else {
        res.end();
      }
    }
  });

  /** Serve the upstream's protected-resource metadata under the proxy's address. */
  async function handlePrm(req: IncomingMessage, res: ServerResponse, upstream: UpstreamConfig): Promise<void> {
    if (!oauthEnabled(upstream)) { res.writeHead(404).end(); return; }
    const prm = await fetchUpstreamPrm(upstream.url);
    if (!prm) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no_protected_resource_metadata", upstream: upstream.id }));
      return;
    }
    // Relay verbatim: `resource` and `authorization_servers` stay the upstream's,
    // so the client obtains a token whose audience is the upstream.
    res.writeHead(prm.status, { "content-type": prm.contentType, "cache-control": "no-store" });
    res.end(prm.body);
  }

  async function handlePost(req: IncomingMessage, res: ServerResponse, upstream: UpstreamConfig): Promise<void> {
    const body = await readBody(req, MAX_JSON_BODY);
    let messages: JsonRpcMessage[];
    try {
      const parsed = JSON.parse(body.toString("utf8"));
      messages = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
      return;
    }

    // Session resolution: initialize creates; everything else requires a header
    // whose session was initialized against *this* upstream address.
    const clientSessionId = header(req, "mcp-session-id");
    const isInit = messages.some((m) => isRequest(m) && m.method === "initialize");
    let session: Session | undefined = sessions.get(clientSessionId);
    if (session && session.upstreamId !== upstream.id) session = undefined; // wrong address for this session
    if (!session) {
      if (!isInit) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Unknown or expired Mcp-Session-Id" } }));
        return;
      }
      session = sessions.create(upstream.id);
    }
    const s = session;
    const tap = taps.get(upstream.id);

    // Tap: log requests/notifications now; responses are logged when upstream answers.
    for (const m of messages) {
      if (isRequest(m)) {
        const tool = m.method === "tools/call" ? toolName(m.params) : undefined;
        if (tool) sessions.bumpToolCall(s, tool);
        tap?.onRequest({ seq: sessions.seq(s), sessionId: s.id, method: m.method, tool, rpcId: m.id, params: m.params });
      } else if (isNotification(m)) {
        tap?.onNotification({ seq: sessions.seq(s), sessionId: s.id, direction: "client_to_server", method: m.method, params: m.params });
      }
    }

    const upstreamHeaders = buildUpstreamHeaders(req.headers, upstream, s);
    const { response, upstreamSessionId } = await forwardToUpstream(upstream, "POST", upstreamHeaders, body);
    if (upstreamSessionId) s.upstreamSessionId = upstreamSessionId;

    const contentType = response.headers.get("content-type") ?? "";
    const outHeaders: Record<string, string> = {
      "content-type": contentType || "application/json",
      "mcp-session-id": s.id, // ALWAYS the proxy-minted id
    };
    // On an auth challenge, redirect discovery to the proxy's own metadata URL.
    if (response.status === 401 && oauthEnabled(upstream)) {
      outHeaders["www-authenticate"] = rewriteWwwAuthenticate(
        response.headers.get("www-authenticate"), proxyPrmUrl(req, upstream.id),
      );
    }

    if (contentType.includes("text/event-stream")) {
      // Stream through unbuffered; tee to an SSE parser for the tap.
      res.writeHead(response.status, outHeaders);
      const parser = new SseParser();
      const reader = response.body?.getReader();
      if (!reader) { res.end(); return; }
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
        for (const ev of parser.feed(decoder.decode(value, { stream: true }))) {
          tapSseData(tap, s, ev.data, response.status);
        }
      }
      res.end();
    } else {
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.length > 0 && contentType.includes("json")) {
        try {
          const parsed = JSON.parse(buf.toString("utf8"));
          for (const m of Array.isArray(parsed) ? parsed : [parsed]) tapUpstreamMessage(tap, s, m, response.status, false);
        } catch { /* non-JSON despite header: forward anyway, tap nothing */ }
      }
      res.writeHead(response.status, outHeaders);
      res.end(buf);
    }
  }

  async function handleGet(req: IncomingMessage, res: ServerResponse, upstream: UpstreamConfig): Promise<void> {
    // Server-initiated SSE stream: forward to upstream, tee for the tap.
    const session = sessions.get(header(req, "mcp-session-id"));
    if (!session || session.upstreamId !== upstream.id) { res.writeHead(404).end(); return; }
    const tap = taps.get(upstream.id);
    const upstreamHeaders = buildUpstreamHeaders(req.headers, upstream, session);
    upstreamHeaders.set("accept", "text/event-stream");
    const { response } = await forwardToUpstream(upstream, "GET", upstreamHeaders);
    if (response.status !== 200 || !response.body) {
      const errHeaders: Record<string, string> = {};
      if (response.status === 401 && oauthEnabled(upstream)) {
        errHeaders["www-authenticate"] = rewriteWwwAuthenticate(
          response.headers.get("www-authenticate"), proxyPrmUrl(req, upstream.id),
        );
      }
      res.writeHead(response.status === 200 ? 502 : response.status, errHeaders).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": session.id });
    const parser = new SseParser();
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    req.on("close", () => { void reader.cancel().catch(() => {}); });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
      for (const ev of parser.feed(decoder.decode(value, { stream: true }))) {
        tapSseData(tap, session, ev.data, 200);
      }
    }
    res.end();
  }

  async function handleDelete(req: IncomingMessage, res: ServerResponse, upstream: UpstreamConfig): Promise<void> {
    const session = sessions.get(header(req, "mcp-session-id"));
    if (!session || session.upstreamId !== upstream.id) { res.writeHead(404).end(); return; }
    try {
      const upstreamHeaders = buildUpstreamHeaders(req.headers, upstream, session);
      await forwardToUpstream(upstream, "DELETE", upstreamHeaders);
    } catch { /* upstream may not support DELETE; terminate locally regardless */ }
    taps.get(upstream.id)?.flushOrphans("disconnect", session.id);
    sessions.delete(session.id);
    res.writeHead(204).end();
  }

  function tapSseData(tap: Tap | undefined, session: Session, data: string, status: number): void {
    try {
      const m = JSON.parse(data) as JsonRpcMessage;
      tapUpstreamMessage(tap, session, m, status, true);
    } catch { /* non-JSON SSE data: ignore for tap */ }
  }

  function tapUpstreamMessage(tap: Tap | undefined, session: Session, m: JsonRpcMessage, status: number, sse: boolean): void {
    if (isResponse(m)) {
      tap?.onResponse({
        sessionId: session.id, rpcId: m.id, result: m.result, error: m.error,
        transport: { mcp_session_id: session.upstreamSessionId, status, sse },
      });
    } else if (isNotification(m)) {
      tap?.onNotification({
        seq: sessions.seq(session), sessionId: session.id,
        direction: "server_to_client", method: m.method, params: m.params,
      });
    }
    // Upstream-initiated requests (sampling/elicitation): forwarded transparently
    // (bytes already passed through); tap support lands with replay.
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function toolName(params: unknown): string | undefined {
  if (params && typeof params === "object" && "name" in params) {
    const n = (params as { name: unknown }).name;
    return typeof n === "string" ? n : undefined;
  }
  return undefined;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error(`body exceeds ${limit} bytes`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
