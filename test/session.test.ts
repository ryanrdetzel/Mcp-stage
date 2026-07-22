import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session.js";

describe("SessionManager", () => {
  it("mints unique ids and tracks tool call counts", () => {
    const m = new SessionManager();
    const s = m.create();
    expect(m.create().id).not.toBe(s.id);
    expect(m.bumpToolCall(s, "create_issue")).toBe(1);
    expect(m.bumpToolCall(s, "create_issue")).toBe(2);
    expect(m.bumpToolCall(s, "list_issues")).toBe(1);
  });

  it("evicts idle sessions", () => {
    const m = new SessionManager();
    const s = m.create();
    s.lastSeenAt = Date.now() - 10_000;
    expect(m.evictIdle(5_000)).toBe(1);
    expect(m.get(s.id)).toBeUndefined();
  });
});
