import { randomUUID } from "node:crypto";

/**
 * Session identity (design walkthrough, "session layer"):
 * the proxy ALWAYS mints its own Mcp-Session-Id toward the client and maps it
 * to the upstream-issued id (live mode only). In staged modes there is no
 * upstream session and the proxy simply IS the server.
 */
export interface Session {
  /** Proxy-minted id, presented to the client as Mcp-Session-Id. */
  id: string;
  /** Upstream-issued Mcp-Session-Id (live mode), once known. */
  upstreamSessionId?: string;
  createdAt: number;
  lastSeenAt: number;
  /** Per-tool invocation counters (1-based), for scenario `calls` matchers and assertions. */
  toolCallCounts: Map<string, number>;
  /** Monotonic per-session sequence for tap entries. */
  nextSeq: number;
}

export class SessionManager {
  private sessions = new Map<string, Session>();

  create(): Session {
    const s: Session = {
      id: randomUUID(),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      toolCallCounts: new Map(),
      nextSeq: 1,
    };
    this.sessions.set(s.id, s);
    return s;
  }

  get(id: string | undefined): Session | undefined {
    if (!id) return undefined;
    const s = this.sessions.get(id);
    if (s) s.lastSeenAt = Date.now();
    return s;
  }

  /** Returns the new (1-based) count for this tool in this session. */
  bumpToolCall(s: Session, tool: string): number {
    const n = (s.toolCallCounts.get(tool) ?? 0) + 1;
    s.toolCallCounts.set(tool, n);
    return n;
  }

  seq(s: Session): number {
    return s.nextSeq++;
  }

  delete(id: string): boolean {
    return this.sessions.delete(id);
  }

  /** Evict sessions idle longer than ttlMs. Returns evicted count. */
  evictIdle(ttlMs: number): number {
    const cutoff = Date.now() - ttlMs;
    let n = 0;
    for (const [id, s] of this.sessions) {
      if (s.lastSeenAt < cutoff) {
        this.sessions.delete(id);
        n++;
      }
    }
    return n;
  }

  get size(): number {
    return this.sessions.size;
  }
}
