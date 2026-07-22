import type { IncomingMessage } from "node:http";
import type { UpstreamConfig } from "../core/types.js";
import { WELL_KNOWN_PRM, prmPath } from "./router.js";

/**
 * OAuth 2.1 discovery proxying (option 2 — "transparent audience").
 *
 * The proxy does not mint or validate tokens. It only relays *discovery* so a
 * client pointed solely at the proxy can find the upstream's real authorization
 * server and obtain a token whose audience is the upstream. The proxy then
 * forwards that bearer verbatim (see modes/live.ts), and the upstream accepts it
 * because the token was minted for the upstream, not the proxy.
 *
 * Two touch points:
 *   1. Relay the upstream's protected-resource metadata at a per-upstream path
 *      (`fetchUpstreamPrm`). `resource` and `authorization_servers` stay the
 *      upstream's — that is what keeps the token audience transparent.
 *   2. Rewrite the upstream's `WWW-Authenticate` 401 challenge so its
 *      `resource_metadata` points at the proxy's per-upstream metadata URL
 *      (`rewriteWwwAuthenticate`), keeping the client on the proxy for discovery.
 */

/** Discovery proxying is on by default for passthrough auth, off otherwise. */
export function oauthEnabled(upstream: UpstreamConfig): boolean {
  if (upstream.oauth?.enabled !== undefined) return upstream.oauth.enabled;
  const strategy = upstream.auth?.strategy ?? "passthrough";
  return strategy === "passthrough";
}

/** Absolute base URL the client used to reach the proxy (scheme + host). */
export function proxyBaseUrl(req: IncomingMessage): string {
  const host = headerValue(req.headers["host"]) ?? "localhost";
  const proto = headerValue(req.headers["x-forwarded-proto"]) ?? "http";
  return `${proto}://${host}`;
}

/** The proxy's own protected-resource-metadata URL for an upstream. */
export function proxyPrmUrl(req: IncomingMessage, upstreamId: string): string {
  return `${proxyBaseUrl(req)}${prmPath(upstreamId)}`;
}

/**
 * Ensure a `WWW-Authenticate` challenge points at `prmUrl` for discovery.
 * Rewrites an existing `resource_metadata` value, appends one if the header
 * exists without it, or synthesizes a Bearer challenge when there is none.
 */
export function rewriteWwwAuthenticate(existing: string | null | undefined, prmUrl: string): string {
  if (!existing || !existing.trim()) {
    return `Bearer resource_metadata="${prmUrl}"`;
  }
  if (/resource_metadata\s*=\s*"[^"]*"/i.test(existing)) {
    return existing.replace(/resource_metadata\s*=\s*"[^"]*"/i, `resource_metadata="${prmUrl}"`);
  }
  return `${existing.trimEnd().replace(/,\s*$/, "")}, resource_metadata="${prmUrl}"`;
}

export interface RelayedMetadata {
  status: number;
  contentType: string;
  body: string;
}

/**
 * Fetch the upstream's protected-resource metadata so the proxy can serve it
 * under its own address. Tries the path-suffixed form (RFC 9728 §3.1) first,
 * then the bare well-known path. Returns null if the upstream advertises none.
 */
export async function fetchUpstreamPrm(
  upstreamUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RelayedMetadata | null> {
  for (const url of prmCandidates(upstreamUrl)) {
    let res: Response;
    try {
      res = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" } });
    } catch {
      continue; // network/DNS error on this candidate; try the next
    }
    if (res.ok) {
      return {
        status: 200,
        contentType: res.headers.get("content-type") ?? "application/json",
        body: await res.text(),
      };
    }
  }
  return null;
}

/** Candidate upstream PRM URLs, most-specific first. */
export function prmCandidates(upstreamUrl: string): string[] {
  const u = new URL(upstreamUrl);
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
  const suffixed = `${u.origin}${WELL_KNOWN_PRM}${path}`;
  const bare = `${u.origin}${WELL_KNOWN_PRM}`;
  return suffixed === bare ? [bare] : [suffixed, bare];
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
