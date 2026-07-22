import { describe, expect, it } from "vitest";
import { routeRequest, mcpPath, prmPath } from "../src/transport/router.js";

const ids = new Set(["linear", "github"]);

describe("routeRequest", () => {
  it("routes the per-upstream MCP endpoint", () => {
    expect(routeRequest("/u/linear/mcp", ids)).toEqual({ kind: "mcp", upstreamId: "linear" });
    expect(routeRequest("/u/github/mcp?x=1", ids)).toEqual({ kind: "mcp", upstreamId: "github" });
  });

  it("routes the per-upstream protected-resource metadata", () => {
    expect(routeRequest("/.well-known/oauth-protected-resource/u/linear/mcp", ids))
      .toEqual({ kind: "prm", upstreamId: "linear" });
  });

  it("rejects unknown upstream ids", () => {
    expect(routeRequest("/u/stripe/mcp", ids)).toEqual({ kind: "not_found" });
    expect(routeRequest("/.well-known/oauth-protected-resource/u/stripe/mcp", ids))
      .toEqual({ kind: "not_found" });
  });

  it("bare well-known path resolves only when a single upstream is configured", () => {
    expect(routeRequest("/.well-known/oauth-protected-resource", ids)).toEqual({ kind: "not_found" });
    expect(routeRequest("/.well-known/oauth-protected-resource", new Set(["solo"]), "solo"))
      .toEqual({ kind: "prm", upstreamId: "solo" });
  });

  it("rejects stray paths", () => {
    expect(routeRequest("/", ids)).toEqual({ kind: "not_found" });
    expect(routeRequest("/u/linear", ids)).toEqual({ kind: "not_found" });
    expect(routeRequest("/u/linear/mcp/extra", ids)).toEqual({ kind: "not_found" });
  });

  it("path helpers agree with the router", () => {
    expect(routeRequest(mcpPath("linear"), ids)).toEqual({ kind: "mcp", upstreamId: "linear" });
    expect(routeRequest(prmPath("github"), ids)).toEqual({ kind: "prm", upstreamId: "github" });
  });
});
