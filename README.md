# mcp-stage

**The stateful staging environment for MCP servers** — record, replay, and *fork* live servers so agents can be tested against realistic state, edge cases, and failures without touching production.

> Status: PR1 — LIVE passthrough proxy + recording. Replay, fork, scenarios, assertions, and the control API land in subsequent PRs.

## Quick start (record)

```bash
mcp-stage serve --upstream https://your-gateway.example/mcp \
  --record ./session.cassette.jsonl
# point your MCP client at http://localhost:8848
```

Every JSON-RPC exchange is logged as structured JSONL (the tap). Recording is the same stream written to a cassette — see `schemas/cassette.v1.schema.json`, the format's public contract.

Cassettes are **redacted by construction**: auth headers, bearer/JWT-shaped strings, and sensitive keys are scrubbed before anything hits disk. Safe to commit.

## Honesty clause

mcp-stage guarantees **environment** determinism, not **agent** determinism. The same stage will serve the same world every run; your agent may still take different paths through it. Write assertions against properties and outcomes, not exact call sequences.

## Auth

- `--auth passthrough` (default): the client's `Authorization` header is forwarded untouched. The client must already hold a valid upstream token; the proxy does not participate in OAuth discovery (v1.x).
- `--auth static --token-env NAME`: the proxy injects a token from the environment — for CI, where the harness holds credentials and agents get none.

## License

Apache-2.0
