import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { redactValue } from "./redact.js";
import type { JsonRpcId } from "../core/types.js";

/**
 * The tap: always-on structured JSONL log of every JSON-RPC exchange, in
 * cassette v1 entry format (schemas/cassette.v1.schema.json). Recording a
 * cassette IS the tap writing to a second file — same entries, no divergence
 * between "logs" and "cassettes" by construction.
 *
 * Pairing: requests are held in-flight keyed by (session, rpc id) and emitted
 * as one `exchange` entry when the response arrives; unpaired requests flush
 * as `orphan` entries on session end/shutdown.
 */

interface InflightRequest {
  seq: number;
  sessionId: string;
  ts: string;
  method: string;
  tool?: string;
  request: { id: JsonRpcId; params?: unknown };
  startedAt: number;
}

export interface TapMeta {
  upstream: { id: string; url: string };
  recorderVersion: string;
}

export class Tap {
  private streams: WriteStream[] = [];
  private inflight = new Map<string, InflightRequest>(); // key: sessionId + "\u0000" + rpcId
  private metaWritten = new Set<WriteStream>();

  constructor(private meta: TapMeta) {}

  addOutput(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const ws = createWriteStream(path, { flags: "a" });
    this.streams.push(ws);
  }

  private writeLine(obj: unknown): void {
    const line = JSON.stringify(obj) + "\n";
    for (const ws of this.streams) {
      if (!this.metaWritten.has(ws)) {
        this.metaWritten.add(ws);
        ws.write(
          JSON.stringify({
            type: "meta",
            v: 1,
            created_at: new Date().toISOString(),
            upstream: this.meta.upstream,
            recorder: { name: "mcp-stage", version: this.meta.recorderVersion },
            redacted: true,
          }) + "\n",
        );
      }
      ws.write(line);
    }
  }

  private key(sessionId: string, rpcId: JsonRpcId): string {
    return `${sessionId}\u0000${String(rpcId)}`;
  }

  onRequest(opts: {
    seq: number;
    sessionId: string;
    method: string;
    tool?: string;
    rpcId: JsonRpcId;
    params?: unknown;
  }): void {
    this.inflight.set(this.key(opts.sessionId, opts.rpcId), {
      seq: opts.seq,
      sessionId: opts.sessionId,
      ts: new Date().toISOString(),
      method: opts.method,
      tool: opts.tool,
      request: { id: opts.rpcId, params: redactValue(opts.params) },
      startedAt: performance.now(),
    });
  }

  onResponse(opts: {
    sessionId: string;
    rpcId: JsonRpcId;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
    transport?: { mcp_session_id?: string; status?: number; sse?: boolean };
  }): void {
    const k = this.key(opts.sessionId, opts.rpcId);
    const req = this.inflight.get(k);
    if (!req) return; // response with no recorded request; drop rather than fabricate
    this.inflight.delete(k);
    const response =
      opts.error !== undefined
        ? { error: redactValue(opts.error) }
        : { result: redactValue(opts.result) };
    this.writeLine({
      type: "exchange",
      seq: req.seq,
      session_id: req.sessionId,
      ts: req.ts,
      method: req.method,
      ...(req.tool ? { tool: req.tool } : {}),
      request: req.request,
      response,
      latency_ms: Math.round((performance.now() - req.startedAt) * 100) / 100,
      ...(opts.transport ? { transport: redactTransport(opts.transport) } : {}),
    });
  }

  onNotification(opts: {
    seq: number;
    sessionId: string;
    direction: "client_to_server" | "server_to_client";
    method: string;
    params?: unknown;
  }): void {
    this.writeLine({
      type: "notification",
      seq: opts.seq,
      session_id: opts.sessionId,
      ts: new Date().toISOString(),
      direction: opts.direction,
      method: opts.method,
      params: redactValue(opts.params),
    });
  }

  /** Flush unanswered requests for a session (or all) as orphans. */
  flushOrphans(reason: "timeout" | "cancelled" | "disconnect" | "shutdown", sessionId?: string): void {
    for (const [k, req] of this.inflight) {
      if (sessionId && req.sessionId !== sessionId) continue;
      this.inflight.delete(k);
      this.writeLine({
        type: "orphan",
        seq: req.seq,
        session_id: req.sessionId,
        ts: req.ts,
        method: req.method,
        ...(req.tool ? { tool: req.tool } : {}),
        request: req.request,
        reason,
      });
    }
  }

  async close(): Promise<void> {
    this.flushOrphans("shutdown");
    await Promise.all(
      this.streams.map(
        (ws) => new Promise<void>((res) => ws.end(() => res())),
      ),
    );
    this.streams = [];
  }
}

function redactTransport(t: { mcp_session_id?: string; status?: number; sse?: boolean }) {
  return t; // session ids/status/sse are not secrets; payload+header redaction happens upstream
}
