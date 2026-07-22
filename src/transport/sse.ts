/**
 * Incremental SSE parser for the tee: feed raw chunks, get parsed events.
 * Only `data:` lines matter for MCP (each event's data is one JSON-RPC message).
 */
export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

export class SseParser {
  private buf = "";

  feed(chunk: string): SseEvent[] {
    this.buf += chunk;
    const events: SseEvent[] = [];
    let idx: number;
    // events are separated by a blank line (\n\n); tolerate \r\n
    while ((idx = this.buf.search(/\r?\n\r?\n/)) !== -1) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx).replace(/^\r?\n\r?\n/, "");
      const ev: SseEvent = { data: "" };
      const dataLines: string[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        else if (line.startsWith("event:")) ev.event = line.slice(6).trim();
        else if (line.startsWith("id:")) ev.id = line.slice(3).trim();
      }
      ev.data = dataLines.join("\n");
      if (ev.data.length > 0) events.push(ev);
    }
    return events;
  }
}
