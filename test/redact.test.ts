import { describe, expect, it } from "vitest";
import { redactHeaders, redactString, redactValue, REDACTED_MARKER } from "../src/log/redact.js";

describe("redact", () => {
  it("scrubs Authorization header regardless of value", () => {
    const h = redactHeaders({ authorization: "Bearer abc123def456", "content-type": "application/json" });
    expect(h.authorization).toBe(REDACTED_MARKER);
    expect(h["content-type"]).toBe("application/json");
  });

  it("scrubs bearer-shaped strings inside values", () => {
    expect(redactString("token is Bearer sk_live_abcdef123456 ok")).not.toContain("sk_live");
  });

  it("scrubs JWTs anywhere", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";
    expect(redactString(`x ${jwt} y`)).toBe(`x ${REDACTED_MARKER} y`);
  });

  it("scrubs known token prefixes (lin_api_, sk-, ghp_)", () => {
    for (const t of ["lin_api_AAAABBBBCCCC1234", "sk-proj-abcdefgh12345678", "ghp_ABCDEFGH12345678"]) {
      expect(redactString(`use ${t} here`)).not.toContain(t);
    }
  });

  it("scrubs sensitive keys deep in payloads", () => {
    const v = redactValue({ a: { access_token: "opaque-short", nested: [{ api_key: "k" }] }, keep: "me" }) as any;
    expect(v.a.access_token).toBe(REDACTED_MARKER);
    expect(v.a.nested[0].api_key).toBe(REDACTED_MARKER);
    expect(v.keep).toBe("me");
  });
});
