/**
 * Path routing for per-upstream addresses.
 *
 * Every upstream is mounted at its own address so each gets a distinct OAuth
 * discovery namespace (a single shared `.well-known` document cannot describe
 * N different protected resources):
 *
 *   MCP endpoint          /u/<id>/mcp
 *   Protected-resource    /.well-known/oauth-protected-resource/u/<id>/mcp
 *   metadata (RFC 9728)   /.well-known/oauth-protected-resource        (single-upstream alias)
 *
 * The path suffix after `/.well-known/oauth-protected-resource` mirrors the MCP
 * endpoint path, per RFC 9728 §3.1 (metadata for a resource with a path lives at
 * the well-known prefix with that path appended).
 */

export const WELL_KNOWN_PRM = "/.well-known/oauth-protected-resource";

export type Route =
  | { kind: "mcp"; upstreamId: string }
  | { kind: "prm"; upstreamId: string }
  | { kind: "not_found" };

/** The client-facing MCP endpoint path for an upstream. */
export function mcpPath(id: string): string {
  return `/u/${id}/mcp`;
}

/** The client-facing protected-resource-metadata path for an upstream. */
export function prmPath(id: string): string {
  return `${WELL_KNOWN_PRM}/u/${id}/mcp`;
}

/**
 * Resolve a request path to a route. `knownIds` gates unknown upstreams to
 * `not_found`; `singleId` (set only when exactly one upstream is configured)
 * enables the bare `/.well-known/oauth-protected-resource` alias.
 */
export function routeRequest(rawUrl: string, knownIds: Set<string>, singleId?: string): Route {
  // Strip query/hash; tolerate a missing leading slash.
  const path = decodeURIComponent(rawUrl.split(/[?#]/, 1)[0] || "/");

  // Protected-resource metadata: /.well-known/oauth-protected-resource[/u/<id>/mcp]
  if (path === WELL_KNOWN_PRM || path.startsWith(`${WELL_KNOWN_PRM}/`)) {
    const suffix = path.slice(WELL_KNOWN_PRM.length); // "" | "/u/<id>/mcp"
    if (suffix === "" || suffix === "/") {
      return singleId ? { kind: "prm", upstreamId: singleId } : { kind: "not_found" };
    }
    const id = matchUpstreamSuffix(suffix);
    if (id && knownIds.has(id)) return { kind: "prm", upstreamId: id };
    return { kind: "not_found" };
  }

  // MCP endpoint: /u/<id>/mcp
  const id = matchUpstreamSuffix(path);
  if (id && knownIds.has(id)) return { kind: "mcp", upstreamId: id };

  return { kind: "not_found" };
}

/** Match `/u/<id>/mcp` and return `<id>`, or undefined. */
function matchUpstreamSuffix(path: string): string | undefined {
  const m = /^\/u\/([a-z0-9][a-z0-9_-]*)\/mcp$/.exec(path);
  return m ? m[1] : undefined;
}
