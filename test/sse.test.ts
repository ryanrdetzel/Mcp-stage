import { describe, expect, it } from "vitest";
import { SseParser } from "../src/transport/sse.js";

describe("SseParser", () => {
  it("parses events split across chunks", () => {
    const p = new SseParser();
    expect(p.feed("event: message\ndata: {\"a\"")).toEqual([]);
    const evs = p.feed(":1}\n\ndata: {\"b\":2}\n\n");
    expect(evs).toHaveLength(2);
    expect(JSON.parse(evs[0].data)).toEqual({ a: 1 });
    expect(JSON.parse(evs[1].data)).toEqual({ b: 2 });
  });

  it("joins multi-line data and tolerates CRLF", () => {
    const p = new SseParser();
    const evs = p.feed("data: line1\r\ndata: line2\r\n\r\n");
    expect(evs[0].data).toBe("line1\nline2");
  });
});
