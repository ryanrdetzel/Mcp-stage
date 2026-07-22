#!/usr/bin/env node
import { Command } from "commander";
import { createProxyServer } from "../transport/httpServer.js";
import { Tap } from "../log/tap.js";
import { mcpPath, prmPath } from "../transport/router.js";
import { oauthEnabled } from "../transport/oauth.js";
import type { StageConfig, UpstreamConfig } from "../core/types.js";

const program = new Command();
program.name("mcp-stage").description("The stateful staging environment for MCP servers").version("0.1.0");

/** Collect a repeatable option into an array. */
function collect(value: string, acc: string[]): string[] {
  acc.push(value);
  return acc;
}

/** Parse `--server id=url` (or a bare url, id defaulting to "upstream"). */
function parseServer(spec: string): { id: string; url: string } {
  const eq = spec.indexOf("=");
  if (eq === -1) return { id: "upstream", url: spec };
  const id = spec.slice(0, eq).trim();
  const url = spec.slice(eq + 1).trim();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error(`invalid upstream id '${id}' (use [a-z0-9][a-z0-9_-]*)`);
  if (!url) throw new Error(`missing url for upstream '${id}'`);
  return { id, url };
}

program
  .command("serve")
  .description("Run a LIVE passthrough proxy, one address per upstream, with OAuth discovery proxying")
  .option("--server <id=url>", "Upstream as <id>=<url> (repeatable, for multiple servers)", collect, [])
  .option("--upstream <url>", "Single upstream URL (shorthand for --server; id via --id)")
  .option("--id <id>", "Upstream id for --upstream", "upstream")
  .option("--port <port>", "Listen port", "8848")
  .option("--log <path>", "JSONL tap output", ".stage/tap.jsonl")
  .option("--record <path>", "Also record a cassette to this path")
  .option("--auth <strategy>", "passthrough | static | none (applies to all upstreams)", "passthrough")
  .option("--token-env <name>", "Env var holding the token (auth=static)")
  .option("--no-oauth", "Disable OAuth discovery proxying")
  .action((o) => {
    const specs: string[] = o.server.length > 0 ? o.server : o.upstream ? [`${o.id}=${o.upstream}`] : [];
    if (specs.length === 0) {
      console.error("error: provide at least one upstream via --server <id=url> or --upstream <url>");
      process.exit(2);
    }

    let upstreams: UpstreamConfig[];
    try {
      upstreams = specs.map(parseServer).map(({ id, url }) => ({
        id, url,
        auth: { strategy: o.auth, token_env: o.tokenEnv },
        // --no-oauth forces off; otherwise the auth strategy decides the default
        // (on for passthrough, off for static/none) — see oauthEnabled().
        ...(o.oauth === false ? { oauth: { enabled: false } } : {}),
      }));
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      process.exit(2);
      return;
    }

    const ids = new Set(upstreams.map((u) => u.id));
    if (ids.size !== upstreams.length) {
      console.error("error: duplicate upstream id");
      process.exit(2);
    }

    const stage: StageConfig = { name: "cli", upstreams };
    const tap = new Tap({ upstream: { id: upstreams[0].id, url: upstreams[0].url }, recorderVersion: "0.1.0" });
    tap.addOutput(o.log);
    if (o.record) tap.addOutput(o.record);

    const server = createProxyServer({ stage, tap });
    server.listen(Number(o.port), () => {
      const base = `http://localhost:${o.port}`;
      console.log(`mcp-stage LIVE proxy on ${base}`);
      for (const u of upstreams) {
        console.log(`  ${u.id}: ${base}${mcpPath(u.id)} -> ${u.url}`);
        if (oauthEnabled(u)) console.log(`       oauth metadata: ${base}${prmPath(u.id)}`);
      }
      if (o.record) console.log(`recording cassette: ${o.record}`);
    });
    const shutdown = async () => { await tap.close(); server.close(() => process.exit(0)); };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program.parse();
