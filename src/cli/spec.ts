/**
 * Parse a `--server` spec into a per-upstream config.
 *
 * Grammar:  <id>=<url>[;<key>=<value>]...
 *   id=<url>            required first segment (the url may contain '=' and '?');
 *                       a bare url with no '=' is accepted, id defaults to "upstream".
 *   auth=<strategy>     passthrough | static | none
 *   token-env=<NAME>    env var holding the token (auth=static); token_env also accepted
 *   oauth=<on|off>      force discovery proxying on/off for this upstream
 *   record=<path>       cassette output path for this upstream
 *   log=<path>          tap (always-on JSONL) output path for this upstream
 *
 * Segments are separated by ';'. A url containing ';' is not supported (MCP
 * endpoints don't use it) — quote the whole spec in your shell.
 */

export interface ServerSpec {
  id: string;
  url: string;
  auth?: "passthrough" | "static" | "none";
  tokenEnv?: string;
  oauth?: boolean;
  record?: string;
  log?: string;
}

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const AUTH_STRATEGIES = new Set(["passthrough", "static", "none"]);

export function parseServerSpec(raw: string): ServerSpec {
  const segments = raw.split(";").map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) throw new Error("empty --server spec");

  // First segment: id=url (or a bare url).
  const first = segments[0];
  const eq = first.indexOf("=");
  let id: string;
  let url: string;
  if (eq === -1) {
    id = "upstream";
    url = first;
  } else {
    id = first.slice(0, eq).trim();
    url = first.slice(eq + 1).trim();
  }
  if (!ID_RE.test(id)) throw new Error(`invalid upstream id '${id}' (use [a-z0-9][a-z0-9_-]*)`);
  if (!url) throw new Error(`missing url for upstream '${id}'`);
  assertUrl(url, id);

  const spec: ServerSpec = { id, url };

  for (const seg of segments.slice(1)) {
    const i = seg.indexOf("=");
    if (i === -1) throw new Error(`malformed attribute '${seg}' in --server ${id} (expected key=value)`);
    const key = seg.slice(0, i).trim().toLowerCase();
    const value = seg.slice(i + 1).trim();
    switch (key) {
      case "auth":
        if (!AUTH_STRATEGIES.has(value)) throw new Error(`invalid auth '${value}' for '${id}' (passthrough|static|none)`);
        spec.auth = value as ServerSpec["auth"];
        break;
      case "token-env":
      case "token_env":
        spec.tokenEnv = value;
        break;
      case "oauth":
        spec.oauth = parseBool(value, id);
        break;
      case "record":
        if (!value) throw new Error(`empty record path for '${id}'`);
        spec.record = value;
        break;
      case "log":
        if (!value) throw new Error(`empty log path for '${id}'`);
        spec.log = value;
        break;
      default:
        throw new Error(`unknown attribute '${key}' in --server ${id}`);
    }
  }
  return spec;
}

function parseBool(value: string, id: string): boolean {
  const v = value.toLowerCase();
  if (["on", "true", "yes", "1"].includes(v)) return true;
  if (["off", "false", "no", "0"].includes(v)) return false;
  throw new Error(`invalid oauth value '${value}' for '${id}' (on|off)`);
}

function assertUrl(url: string, id: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`invalid url '${url}' for upstream '${id}'`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`upstream '${id}' url must be http(s): '${url}'`);
  }
}
