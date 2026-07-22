#!/usr/bin/env node
import { Command } from "commander";
import { createProxyServer } from "../transport/httpServer.js";
import { Tap } from "../log/tap.js";
import type { StageConfig } from "../core/types.js";

const program = new Command();
program.name("mcp-stage").description("The stateful staging environment for MCP servers").version("0.1.0");

program
  .command("serve")
  .description("Run a LIVE passthrough proxy for a single upstream (PR1)")
  .requiredOption("--upstream <url>", "Upstream MCP endpoint URL")
  .option("--id <id>", "Upstream id", "upstream")
  .option("--port <port>", "Listen port", "8848")
  .option("--log <path>", "JSONL tap output", ".stage/tap.jsonl")
  .option("--record <path>", "Also record a cassette to this path")
  .option("--auth <strategy>", "passthrough | static | none", "passthrough")
  .option("--token-env <name>", "Env var holding the token (auth=static)")
  .action((o) => {
    const stage: StageConfig = {
      name: "cli",
      upstream: {
        id: o.id, url: o.upstream,
        auth: { strategy: o.auth, token_env: o.tokenEnv },
      },
    };
    const tap = new Tap({ upstream: { id: o.id, url: o.upstream }, recorderVersion: "0.1.0" });
    tap.addOutput(o.log);
    if (o.record) tap.addOutput(o.record);
    const server = createProxyServer({ stage, tap });
    server.listen(Number(o.port), () => {
      console.log(`mcp-stage LIVE proxy on http://localhost:${o.port} -> ${o.upstream}`);
      if (o.record) console.log(`recording cassette: ${o.record}`);
    });
    const shutdown = async () => { await tap.close(); server.close(() => process.exit(0)); };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program.parse();
