#!/usr/bin/env node
import { Command } from "commander";
import { join } from "node:path";
import { createProxyServer } from "../transport/httpServer.js";
import { Tap } from "../log/tap.js";
import { mcpPath, prmPath } from "../transport/router.js";
import { oauthEnabled } from "../transport/oauth.js";
import { parseServerSpec, type ServerSpec } from "./spec.js";
import type { StageConfig, UpstreamConfig } from "../core/types.js";

const program = new Command();
program.name("mcp-stage").description("The stateful staging environment for MCP servers").version("0.1.0");

/** Collect a repeatable option into an array. */
function collect(value: string, acc: string[]): string[] {
  acc.push(value);
  return acc;
}

program
  .command("serve")
  .description("Run a LIVE passthrough proxy, one address per upstream, with OAuth discovery proxying")
  .option("--server <spec>", "Upstream as <id>=<url>[;auth=..;token-env=..;oauth=off;record=..;log=..] (repeatable)", collect, [])
  .option("--upstream <url>", "Single upstream URL (shorthand for --server; id via --id)")
  .option("--id <id>", "Upstream id for --upstream", "upstream")
  .option("--port <port>", "Listen port", "8848")
  .option("--auth <strategy>", "Default auth for all upstreams: passthrough | static | none", "passthrough")
  .option("--token-env <name>", "Default env var holding the token (auth=static)")
  .option("--no-oauth", "Disable OAuth discovery proxying by default")
  .option("--log-dir <dir>", "Directory for per-upstream tap logs (<dir>/<id>.tap.jsonl)", ".stage")
  .option("--record-dir <dir>", "Record a cassette per upstream to <dir>/<id>.cassette.jsonl")
  .option("--log <path>", "Tap log path (single upstream only; use --log-dir for many)")
  .option("--record <path>", "Cassette path (single upstream only; use --record-dir for many)")
  .action((o) => {
    const rawSpecs: string[] = o.server.length > 0 ? o.server : o.upstream ? [`${o.id}=${o.upstream}`] : [];
    if (rawSpecs.length === 0) {
      fail("provide at least one upstream via --server <id=url> or --upstream <url>");
    }

    let specs: ServerSpec[];
    try {
      specs = rawSpecs.map(parseServerSpec);
    } catch (err) {
      fail((err as Error).message);
      return;
    }

    const ids = new Set(specs.map((s) => s.id));
    if (ids.size !== specs.length) fail("duplicate upstream id");

    const many = specs.length > 1;
    if (many && o.log) fail("--log is single-upstream only; use --log-dir or per-server log=<path>");
    if (many && o.record) fail("--record is single-upstream only; use --record-dir or per-server record=<path>");

    const upstreams: UpstreamConfig[] = specs.map((s) => {
      const strategy = (s.auth ?? o.auth) as "passthrough" | "static" | "none";
      // Per-server oauth wins; else a global --no-oauth forces off; else default by strategy.
      const oauth = s.oauth !== undefined ? { enabled: s.oauth } : o.oauth === false ? { enabled: false } : undefined;
      return {
        id: s.id,
        url: s.url,
        auth: { strategy, token_env: s.tokenEnv ?? o.tokenEnv },
        ...(oauth ? { oauth } : {}),
      };
    });

    // One tap per upstream: its own always-on log plus an optional cassette.
    const taps = new Map<string, Tap>();
    const recordPaths = new Map<string, string>();
    for (const s of specs) {
      const logPath = s.log ?? (o.log && !many ? o.log : join(o.logDir, `${s.id}.tap.jsonl`));
      const recordPath = s.record ?? (o.recordDir ? join(o.recordDir, `${s.id}.cassette.jsonl`) : o.record && !many ? o.record : undefined);
      const tap = new Tap({ upstream: { id: s.id, url: s.url }, recorderVersion: "0.1.0" });
      tap.addOutput(logPath);
      if (recordPath) { tap.addOutput(recordPath); recordPaths.set(s.id, recordPath); }
      taps.set(s.id, tap);
    }

    const stage: StageConfig = { name: "cli", upstreams };
    const server = createProxyServer({ stage, taps });
    server.listen(Number(o.port), () => {
      const base = `http://localhost:${o.port}`;
      console.log(`mcp-stage LIVE proxy on ${base}`);
      for (const u of upstreams) {
        console.log(`  ${u.id}: ${base}${mcpPath(u.id)} -> ${u.url}  [auth=${u.auth?.strategy}]`);
        if (oauthEnabled(u)) console.log(`       oauth metadata: ${base}${prmPath(u.id)}`);
        const rec = recordPaths.get(u.id);
        if (rec) console.log(`       recording: ${rec}`);
      }
    });
    const shutdown = async () => {
      await Promise.all([...taps.values()].map((t) => t.close()));
      server.close(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
}

program.parse();
