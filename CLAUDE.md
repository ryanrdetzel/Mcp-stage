# CLAUDE.md

## Project overview

mcp-stage is a stateful staging environment for MCP (Model Context Protocol) servers. It lets you record, replay, and fork live MCP servers so agents can be tested against realistic state, edge cases, and failures without touching production.

Current status: PR1 — a LIVE passthrough proxy with recording. Replay, fork, scenarios, assertions, and the control API land in subsequent PRs.

## Architecture

- `src/cli/` — `mcp-stage` CLI (commander). The `serve` command runs the proxy.
- `src/transport/` — HTTP proxy server and SSE stream handling between client, proxy, and upstream.
- `src/core/` — session tracking and shared types (`StageConfig`, etc.).
- `src/log/` — the tap: every JSON-RPC exchange is written as structured JSONL. Recording a cassette is the same stream written to a second file. `redact.ts` scrubs auth headers, bearer/JWT-shaped strings, and sensitive keys before anything hits disk — cassettes are redacted by construction.
- `schemas/` — JSON Schemas for the cassette and stage-definition formats; these are public contracts.
- `test/` — vitest unit tests plus an end-to-end proxy test.

## Commands

- `npm run build` — compile TypeScript to `dist/`
- `npm run typecheck` — `tsc --noEmit`
- `npm test` — run the vitest suite

Node >= 20 required. ESM throughout (`"type": "module"`); intra-project imports use `.js` extensions.

## Conventions

- Never add attribution to commits (no Co-Authored-By trailers, no "Generated with" lines, no tool or model credits).
- Cassette and stage-definition schemas are versioned public contracts — breaking changes require a new schema version.
- Redaction must stay ahead of persistence: nothing unredacted may ever be written to the tap or a cassette.
- mcp-stage guarantees environment determinism, not agent determinism — write assertions against properties and outcomes, not exact call sequences.
