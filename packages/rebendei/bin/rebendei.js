#!/usr/bin/env bun
import { connect } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { startServer } from "../src/server.js";
import pkg from "../package.json" with { type: "json" };

if (typeof Bun === "undefined") {
  console.error("rebendei needs Bun. Install it from https://bun.sh and run: bunx rebendei");
  process.exit(1);
}

const HELP = `rebendei ${pkg.version}

Usage: rebendei <command>

Commands:
  dev       apply migrations, then start the server
  start     start the server
  migrate   apply pending database migrations
  db:up     start the local Postgres + pgvector container (docker compose)
  db:down   stop it
  version   print the version

Environment (read from .env):
  DATABASE_URL   postgres connection string
  PORT           HTTP/WebSocket port (default 3210)`;

async function runMigrations() {
  const sql = connect();
  try {
    const applied = await migrate(sql);
    console.log(applied.length ? `migrations applied: ${applied.join(", ")}` : "database up to date");
  } finally {
    await sql.close();
  }
}

function serve() {
  const { server, stop } = startServer();
  console.log(`rebendei listening on http://localhost:${server.port}`);
  const shutdown = async () => { await stop(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** @param {string[]} args */
async function compose(args) {
  const proc = Bun.spawn(["docker", "compose", ...args], { stdio: ["inherit", "inherit", "inherit"] });
  process.exit(await proc.exited);
}

const [cmd] = process.argv.slice(2);
try {
  switch (cmd) {
    case "dev": await runMigrations(); serve(); break;
    case "start": serve(); break;
    case "migrate": await runMigrations(); break;
    case "db:up": await compose(["up", "-d", "--wait"]); break;
    case "db:down": await compose(["down"]); break;
    case "version": case "-v": case "--version": console.log(pkg.version); break;
    case undefined: case "help": case "-h": case "--help": console.log(HELP); break;
    default: console.error(`unknown command: ${cmd}\n\n${HELP}`); process.exit(1);
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/ECONNREFUSED|connect/i.test(msg)) {
    console.error(`can't reach the database (${msg}).\nIs it running? Try: rebendei db:up`);
  } else {
    console.error(msg);
  }
  process.exit(1);
}
