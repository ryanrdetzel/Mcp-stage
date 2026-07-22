/**
 * Token scrubbing (MVP hygiene): nothing token-shaped hits disk unredacted.
 * Applied to every tap entry — headers AND payloads — before serialization.
 *
 * Strategy: structural (known header/field names) + pattern (bearer-ish strings).
 * Deliberately aggressive; a scrubbed cassette that replays is worth more than
 * a byte-perfect one that leaks a Linear token into git.
 */

const REDACTED = "[REDACTED:mcp-stage]";

/** Header names that always get scrubbed (lowercase). */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "cookie",
  "set-cookie",
]);

/** Object keys (case-insensitive) whose string values get scrubbed wherever they appear. */
const SENSITIVE_KEYS = /^(authorization|access_token|refresh_token|id_token|api[_-]?key|client_secret|password|secret|bearer)$/i;

/**
 * String patterns scrubbed inside values:
 *  - "Bearer <token>" / "Basic <b64>"
 *  - JWTs (three dot-separated base64url segments)
 *  - long high-entropy-looking opaque tokens with common prefixes (lin_api_, sk-, ghp_, xoxb-)
 */
const VALUE_PATTERNS: RegExp[] = [
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
  /\b(lin_api_|lin_oauth_|sk-|ghp_|gho_|xox[bap]-)[A-Za-z0-9_-]{8,}\b/g,
];

export function redactString(s: string): string {
  let out = s;
  for (const re of VALUE_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

export function redactHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase())
      ? REDACTED
      : Array.isArray(v)
        ? v.map(redactString)
        : redactString(v);
  }
  return out;
}

/** Deep-redact any JSON-serializable value. Cycles are impossible in parsed JSON; guard anyway. */
export function redactValue(v: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof v === "string") return redactString(v);
  if (v === null || typeof v !== "object") return v;
  if (seen.has(v as object)) return "[CYCLE]";
  seen.add(v as object);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, seen));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.test(k) && typeof val === "string" ? REDACTED : redactValue(val, seen);
  }
  return out;
}

export const REDACTED_MARKER = REDACTED;
