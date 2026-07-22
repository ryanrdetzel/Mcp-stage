/** JSON-RPC 2.0 message shapes (loose on purpose: the proxy forwards, it does not validate). */
export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export function isRequest(m: JsonRpcMessage): m is JsonRpcRequest {
  return "method" in m && "id" in m;
}
export function isNotification(m: JsonRpcMessage): m is JsonRpcNotification {
  return "method" in m && !("id" in m);
}
export function isResponse(m: JsonRpcMessage): m is JsonRpcResponse {
  return !("method" in m) && "id" in m;
}

/** Minimal upstream config (subset of the stage-definition schema). */
export interface UpstreamConfig {
  id: string;
  url: string;
  auth?: {
    strategy: "passthrough" | "static" | "none";
    token_env?: string;
  };
  /**
   * OAuth discovery proxying (PRD §12.8). When enabled, the proxy owns the
   * upstream's `.well-known/oauth-protected-resource` endpoint at a per-upstream
   * address and rewrites the upstream's 401 challenge to point there, so a
   * client pointed only at the proxy can complete the OAuth 2.1 flow against the
   * upstream's real authorization server. Defaults to enabled for passthrough
   * auth (the only strategy where the client authenticates), off otherwise.
   */
  oauth?: { enabled?: boolean };
  record?: { cassette: string };
}

export interface StageConfig {
  name: string;
  /**
   * One or more upstreams. Each is mounted at its own address (`/u/<id>/mcp`)
   * so every upstream gets a distinct `.well-known` namespace — a single shared
   * address cannot represent N different OAuth resources.
   */
  upstreams: UpstreamConfig[];
}
