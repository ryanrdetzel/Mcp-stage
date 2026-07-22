# mcp-stage

**The stateful staging environment for MCP servers** — record, replay, and *fork* live servers so agents can be tested against realistic state, edge cases, and failures without touching production.

> Status: PR1 — LIVE passthrough proxy + recording. Replay, fork, scenarios, assertions, and the control API land in subsequent PRs.

## Quick start (record)

```bash
mcp-stage serve --upstream https://your-gateway.example/mcp \
  --record ./session.cassette.jsonl
# point your MCP client at http://localhost:8848/u/upstream/mcp
```

Every upstream is mounted at its **own address** — `/u/<id>/mcp` — so each one gets a
distinct OAuth discovery namespace (see below). Run several at once, each with its
own auth strategy and its own cassette:

```bash
mcp-stage serve \
  --server 'linear=https://mcp.linear.app/mcp' \
  --server 'github=https://api.githubcopilot.com/mcp' \
  --server 'ci=https://internal.example/mcp;auth=static;token-env=CI_TOKEN;oauth=off' \
  --record-dir ./cassettes
# clients: http://localhost:8848/u/linear/mcp , …/u/github/mcp , …/u/ci/mcp
# cassettes: ./cassettes/linear.cassette.jsonl , github.cassette.jsonl , ci.cassette.jsonl
```

### Per-upstream configuration

Each `--server` is `<id>=<url>` plus optional `;`-separated attributes:

| attribute | meaning |
|---|---|
| `auth=passthrough\|static\|none` | auth strategy for this upstream (overrides `--auth`) |
| `token-env=NAME` | env var holding the token, for `auth=static` |
| `oauth=on\|off` | force OAuth discovery proxying on/off for this upstream |
| `record=PATH` | cassette path for this upstream |
| `log=PATH` | tap-log path for this upstream |

Global flags set defaults for every upstream: `--auth`, `--token-env`, `--no-oauth`,
`--record-dir <dir>` (records each upstream to `<dir>/<id>.cassette.jsonl`), and
`--log-dir <dir>` (default `.stage`, tap logs at `<dir>/<id>.tap.jsonl`). The
single-file `--record`/`--log` flags are single-upstream only.

### Recording

Every JSON-RPC exchange is logged as structured JSONL (the tap). Recording is the same
stream written to a cassette — see `schemas/cassette.v1.schema.json`, the format's public
contract. **Each upstream records to its own file**, whose `meta` names that upstream, so
a multi-server run yields one clean cassette per server.

Cassettes are **redacted by construction**: auth headers, bearer/JWT-shaped strings, and sensitive keys are scrubbed before anything hits disk. Safe to commit.

## Honesty clause

mcp-stage guarantees **environment** determinism, not **agent** determinism. The same stage will serve the same world every run; your agent may still take different paths through it. Write assertions against properties and outcomes, not exact call sequences.

## Auth

- `--auth passthrough` (default): the client's `Authorization` header is forwarded untouched, and the proxy **proxies OAuth discovery** so a client that only knows the proxy can complete the OAuth 2.1 flow against the upstream's real authorization server (see below).
- `--auth static --token-env NAME`: the proxy injects a token from the environment — for CI, where the harness holds credentials and agents get none. Discovery proxying is off (the client never authenticates).
- `--no-oauth`: disable discovery proxying even under passthrough (pure header forwarding, the v1 behavior).

These are **defaults**; any upstream can override them with `auth=`, `token-env=`, and `oauth=` on its `--server` spec, so a single proxy can front an OAuth upstream and a `static`-token CI upstream at once.

### OAuth discovery proxying

Most MCP servers are now OAuth 2.1 resource servers: the client discovers an
authorization server, runs the auth-code + PKCE flow, and attaches a bearer whose
audience is the server. A proxy in the middle breaks discovery unless it owns the
`.well-known` endpoints — and one shared address cannot describe *N* different
resources. mcp-stage solves this by giving **each upstream its own address**.

For an upstream mounted at `/u/<id>/mcp`, the flow is:

1. Client → proxy `POST /u/<id>/mcp` with no token.
2. Proxy relays the upstream's `401`, **rewriting** the `WWW-Authenticate`
   `resource_metadata` to `…/.well-known/oauth-protected-resource/u/<id>/mcp`.
3. Client fetches that metadata from the proxy; the proxy relays the upstream's
   own document **verbatim** — `resource` and `authorization_servers` stay the
   upstream's.
4. Client runs the OAuth flow **directly** against the upstream's authorization
   server (a browser opens once), requesting a token scoped to the upstream.
5. Client retries through the proxy with `Authorization: Bearer …`; the proxy
   forwards it untouched and the upstream accepts it — the token's audience is
   the upstream, not the proxy.

The proxy never mints, validates, or stores tokens; it only relays discovery.
Bearer tokens are redacted before anything hits the tap or a cassette.

> **Transparent audience.** Because the relayed metadata keeps the upstream's
> `resource`, a strict client that requires `resource` to equal the URL it dialed
> may object. Terminating auth at the proxy (proxy-minted tokens + upstream
> credential injection) is a later, opt-in mode.

## License

Apache-2.0
