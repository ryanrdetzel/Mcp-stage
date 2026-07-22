import { describe, expect, it } from "vitest";
import { parseServerSpec } from "../src/cli/spec.js";

describe("parseServerSpec", () => {
  it("parses the id=url shorthand", () => {
    expect(parseServerSpec("linear=https://mcp.linear.app/mcp")).toEqual({
      id: "linear", url: "https://mcp.linear.app/mcp",
    });
  });

  it("keeps '=' and query strings in the url", () => {
    const s = parseServerSpec("gh=https://api.example/mcp?a=b&c=d");
    expect(s.url).toBe("https://api.example/mcp?a=b&c=d");
  });

  it("defaults the id to 'upstream' for a bare url", () => {
    expect(parseServerSpec("https://x.example/mcp").id).toBe("upstream");
  });

  it("parses per-server attributes", () => {
    expect(parseServerSpec("ci=https://x.example/mcp;auth=static;token-env=CI_TOKEN;oauth=off;record=./ci.jsonl;log=./ci.tap.jsonl"))
      .toEqual({
        id: "ci", url: "https://x.example/mcp",
        auth: "static", tokenEnv: "CI_TOKEN", oauth: false,
        record: "./ci.jsonl", log: "./ci.tap.jsonl",
      });
  });

  it("accepts token_env and on/off/true/false for oauth", () => {
    expect(parseServerSpec("a=https://x.example/mcp;token_env=T").tokenEnv).toBe("T");
    expect(parseServerSpec("a=https://x.example/mcp;oauth=on").oauth).toBe(true);
    expect(parseServerSpec("a=https://x.example/mcp;oauth=true").oauth).toBe(true);
    expect(parseServerSpec("a=https://x.example/mcp;oauth=false").oauth).toBe(false);
  });

  it("rejects bad ids, urls, and attributes", () => {
    expect(() => parseServerSpec("Bad_ID=https://x.example/mcp")).toThrow(/invalid upstream id/);
    expect(() => parseServerSpec("a=ftp://x.example/mcp")).toThrow(/http/);
    expect(() => parseServerSpec("a=not-a-url")).toThrow(/invalid url/);
    expect(() => parseServerSpec("a=https://x.example/mcp;auth=weird")).toThrow(/invalid auth/);
    expect(() => parseServerSpec("a=https://x.example/mcp;oauth=maybe")).toThrow(/invalid oauth/);
    expect(() => parseServerSpec("a=https://x.example/mcp;bogus=1")).toThrow(/unknown attribute/);
    expect(() => parseServerSpec("a=https://x.example/mcp;flag")).toThrow(/malformed attribute/);
  });
});
