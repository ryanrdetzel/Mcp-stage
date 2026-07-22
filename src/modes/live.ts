import type { Session } from "../core/session.js";
import type { UpstreamConfig } from "../core/types.js";

/**
 * LIVE mode upstream client: forwards a client HTTP request to the upstream
 * MCP endpoint and returns the raw Response for streaming back.
 *
 * Transparency rule: forward bytes, don't re-serialize. The caller (transport
 * layer) tees the body for the tap.
 */

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
]);

export function buildUpstreamHeaders(
  clientHeaders: Record<string, string | string[] | undefined>,
  upstream: UpstreamConfig,
  session: Session,
): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(clientHeaders)) {
    const lk = k.toLowerCase();
    if (v === undefined || HOP_BY_HOP.has(lk)) continue;
    if (lk === "mcp-session-id") continue; // replaced with upstream's id below
    if (lk === "authorization" && upstream.auth?.strategy !== "passthrough" && upstream.auth?.strategy !== undefined) continue;
    h.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  const strategy = upstream.auth?.strategy ?? "passthrough";
  if (strategy === "static") {
    const envName = upstream.auth?.token_env;
    const token = envName ? process.env[envName] : undefined;
    if (!token) throw new Error(`auth.strategy=static but env var ${envName ?? "(unset)"} is empty`);
    h.set("authorization", `Bearer ${token}`);
  }
  if (session.upstreamSessionId) h.set("mcp-session-id", session.upstreamSessionId);
  return h;
}

export interface UpstreamResult {
  response: Response;
  /** Upstream-issued session id, if present on this response. */
  upstreamSessionId?: string;
}

export async function forwardToUpstream(
  upstream: UpstreamConfig,
  method: "POST" | "GET" | "DELETE",
  headers: Headers,
  body?: Buffer,
): Promise<UpstreamResult> {
  const response = await fetch(upstream.url, {
    method,
    headers,
    body: method === "POST" ? new Uint8Array(body ?? Buffer.alloc(0)) : undefined,
  });
  return {
    response,
    upstreamSessionId: response.headers.get("mcp-session-id") ?? undefined,
  };
}
