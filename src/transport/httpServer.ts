import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { SessionManager, type Session } from "../core/session.js";
import { Tap } from "../log/tap.js";
import { buildUpstreamHeaders, forwardToUpstream } from "../modes/live.js";
import { SseParser } from "./sse.js";
import {
  isNotification, isRequest, isResponse,
  type JsonRpcMessage, type StageConfig,
} from "../core/types.js";

/**
 * Client-facing Streamable HTTP endpoint. PR1 scope: LIVE mode only.
 *
 * Pipeline per message: transport -> session -> tap -> (scenario: PR5) -> live handler.
 *
 * Transparency: request/response bodies are forwarded byte-for-byte; the tap
 * parses a copy. The one deliberate rewrite: Mcp-Session-Id — the proxy mints
 * its own toward the client and maps to the upstream's.
 */

const MAX_JSON_BODY = 8 * 1024 * 1024; // buffered-JSON cap; SSE bodies stream and are uncapped

export interface ProxyServerOptions {
  stage: StageConfig;
  tap: Tap;
  sessions?: SessionManager;
}

export function createProxyServer(opts: ProxyServerOptions): Server {
  const sessions = opts.sessions ?? new SessionManager();
  const { stage, tap } = opts;

  return createServer(async (req, res) => {
    try {
      if (req.method === "POST") return await handlePost(req, res);
      if (req.method === "GET") return await handleGet(req, res);
      if (req.method === "DELETE") return await handleDelete(req, res);
      res.writeHead(405, { allow: "GET, POST, DELETE" }).end();
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

  async function handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

    // Session resolution: initialize creates; everything else requires the header.
    const clientSessionId = header(req, "mcp-session-id");
    const isInit = messages.some((m) => isRequest(m) && m.method === "initialize");
    let session: Session | undefined = sessions.get(clientSessionId);
    if (!session) {
      if (!isInit) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Unknown or expired Mcp-Session-Id" } }));
        return;
      }
      session = sessions.create();
    }
    const s = session;

    // Tap: log requests/notifications now; responses are logged when upstream answers.
    for (const m of messages) {
      if (isRequest(m)) {
        const tool = m.method === "tools/call" ? toolName(m.params) : undefined;
        if (tool) sessions.bumpToolCall(s, tool);
        tap.onRequest({ seq: sessions.seq(s), sessionId: s.id, method: m.method, tool, rpcId: m.id, params: m.params });
      } else if (isNotification(m)) {
        tap.onNotification({ seq: sessions.seq(s), sessionId: s.id, direction: "client_to_server", method: m.method, params: m.params });
      }
    }

    const upstreamHeaders = buildUpstreamHeaders(req.headers, stage.upstream, s);
    const { response, upstreamSessionId } = await forwardToUpstream(stage.upstream, "POST", upstreamHeaders, body);
    if (upstreamSessionId) s.upstreamSessionId = upstreamSessionId;

    const contentType = response.headers.get("content-type") ?? "";
    const outHeaders: Record<string, string> = {
      "content-type": contentType || "application/json",
      "mcp-session-id": s.id, // ALWAYS the proxy-minted id
    };

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
          tapSseData(s, ev.data, response.status);
        }
      }
      res.end();
    } else {
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.length > 0 && contentType.includes("json")) {
        try {
          const parsed = JSON.parse(buf.toString("utf8"));
          for (const m of Array.isArray(parsed) ? parsed : [parsed]) tapUpstreamMessage(s, m, response.status, false);
        } catch { /* non-JSON despite header: forward anyway, tap nothing */ }
      }
      res.writeHead(response.status, outHeaders);
      res.end(buf);
    }
  }

  async function handleGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Server-initiated SSE stream: forward to upstream, tee for the tap.
    const session = sessions.get(header(req, "mcp-session-id"));
    if (!session) { res.writeHead(404).end(); return; }
    const upstreamHeaders = buildUpstreamHeaders(req.headers, stage.upstream, session);
    upstreamHeaders.set("accept", "text/event-stream");
    const { response } = await forwardToUpstream(stage.upstream, "GET", upstreamHeaders);
    if (response.status !== 200 || !response.body) {
      res.writeHead(response.status === 200 ? 502 : response.status).end();
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
        tapSseData(session, ev.data, 200);
      }
    }
    res.end();
  }

  async function handleDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const session = sessions.get(header(req, "mcp-session-id"));
    if (!session) { res.writeHead(404).end(); return; }
    try {
      const upstreamHeaders = buildUpstreamHeaders(req.headers, stage.upstream, session);
      await forwardToUpstream(stage.upstream, "DELETE", upstreamHeaders);
    } catch { /* upstream may not support DELETE; terminate locally regardless */ }
    tap.flushOrphans("disconnect", session.id);
    sessions.delete(session.id);
    res.writeHead(204).end();
  }

  function tapSseData(session: Session, data: string, status: number): void {
    try {
      const m = JSON.parse(data) as JsonRpcMessage;
      tapUpstreamMessage(session, m, status, true);
    } catch { /* non-JSON SSE data: ignore for tap */ }
  }

  function tapUpstreamMessage(session: Session, m: JsonRpcMessage, status: number, sse: boolean): void {
    if (isResponse(m)) {
      tap.onResponse({
        sessionId: session.id, rpcId: m.id, result: m.result, error: m.error,
        transport: { mcp_session_id: session.upstreamSessionId, status, sse },
      });
    } else if (isNotification(m)) {
      tap.onNotification({
        seq: sessions.seq(session), sessionId: session.id,
        direction: "server_to_client", method: m.method, params: m.params,
      });
    }
    // Upstream-initiated requests (sampling/elicitation): PR1 forwards them
    // transparently (bytes already passed through); tap support lands with replay.
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
