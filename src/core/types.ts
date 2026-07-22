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

/** Minimal upstream config for PR1 (subset of the stage-definition schema). */
export interface UpstreamConfig {
  id: string;
  url: string;
  auth?: {
    strategy: "passthrough" | "static" | "none";
    token_env?: string;
  };
  record?: { cassette: string };
}

export interface StageConfig {
  name: string;
  upstream: UpstreamConfig; // single upstream in v1 runtime; schema supports many
}
