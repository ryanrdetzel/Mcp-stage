import { describe, expect, it } from "vitest";
import {
  oauthEnabled, rewriteWwwAuthenticate, prmCandidates, fetchUpstreamPrm,
} from "../src/transport/oauth.js";

describe("oauthEnabled", () => {
  it("defaults on for passthrough, off for static/none", () => {
    expect(oauthEnabled({ id: "a", url: "https://x/mcp" })).toBe(true); // default auth = passthrough
    expect(oauthEnabled({ id: "a", url: "https://x/mcp", auth: { strategy: "passthrough" } })).toBe(true);
    expect(oauthEnabled({ id: "a", url: "https://x/mcp", auth: { strategy: "static" } })).toBe(false);
    expect(oauthEnabled({ id: "a", url: "https://x/mcp", auth: { strategy: "none" } })).toBe(false);
  });

  it("explicit flag wins", () => {
    expect(oauthEnabled({ id: "a", url: "https://x/mcp", auth: { strategy: "static" }, oauth: { enabled: true } })).toBe(true);
    expect(oauthEnabled({ id: "a", url: "https://x/mcp", oauth: { enabled: false } })).toBe(false);
  });
});

describe("rewriteWwwAuthenticate", () => {
  const prm = "http://localhost:8848/.well-known/oauth-protected-resource/u/linear/mcp";

  it("synthesizes a challenge when the upstream sent none", () => {
    expect(rewriteWwwAuthenticate(null, prm)).toBe(`Bearer resource_metadata="${prm}"`);
    expect(rewriteWwwAuthenticate("", prm)).toBe(`Bearer resource_metadata="${prm}"`);
  });

  it("replaces the upstream's resource_metadata pointer", () => {
    const upstream = 'Bearer resource_metadata="https://gw.example/.well-known/oauth-protected-resource/mcp", error="invalid_token"';
    const out = rewriteWwwAuthenticate(upstream, prm);
    expect(out).toContain(`resource_metadata="${prm}"`);
    expect(out).toContain('error="invalid_token"');
    expect(out).not.toContain("gw.example");
  });

  it("appends resource_metadata when the challenge lacks one", () => {
    const out = rewriteWwwAuthenticate('Bearer realm="mcp"', prm);
    expect(out).toBe(`Bearer realm="mcp", resource_metadata="${prm}"`);
  });
});

describe("prmCandidates", () => {
  it("tries the path-suffixed form first, then the bare well-known path", () => {
    expect(prmCandidates("https://gw.example/mcp")).toEqual([
      "https://gw.example/.well-known/oauth-protected-resource/mcp",
      "https://gw.example/.well-known/oauth-protected-resource",
    ]);
  });

  it("collapses to a single candidate at the origin root", () => {
    expect(prmCandidates("https://gw.example/")).toEqual([
      "https://gw.example/.well-known/oauth-protected-resource",
    ]);
  });
});

describe("fetchUpstreamPrm", () => {
  it("returns the first candidate that responds 200", async () => {
    const seen: string[] = [];
    const fake: typeof fetch = (async (url: string) => {
      seen.push(url);
      if (url.endsWith("/oauth-protected-resource/mcp")) {
        return new Response(JSON.stringify({ resource: "https://gw.example/mcp", authorization_servers: ["https://as.example"] }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const prm = await fetchUpstreamPrm("https://gw.example/mcp", fake);
    expect(prm).not.toBeNull();
    expect(JSON.parse(prm!.body).resource).toBe("https://gw.example/mcp");
    expect(seen[0]).toBe("https://gw.example/.well-known/oauth-protected-resource/mcp");
  });

  it("falls back to the bare path and returns null when nothing is advertised", async () => {
    const fake: typeof fetch = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    expect(await fetchUpstreamPrm("https://gw.example/mcp", fake)).toBeNull();
  });
});
