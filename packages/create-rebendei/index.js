#!/usr/bin/env node
// Runs under Node or Bun so `npx`, `bunx`, `npm create` and `bun create` all work.
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("-")));
const positional = args.filter((a) => !a.startsWith("-"));

if (flags.has("-h") || flags.has("--help")) {
  console.log(`create-rebendei ${version}

Usage: npx create-rebendei <dir> [--no-install] [--no-git]
       bunx create-rebendei <dir>`);
  process.exit(0);
}

const target = resolve(positional[0] ?? "my-rebendei-app");
const name = basename(target).toLowerCase().replace(/[^a-z0-9-_.]/g, "-");

if (existsSync(target) && readdirSync(target).length > 0) {
  console.error(`${target} is not empty. Pick a new folder name.`);
  process.exit(1);
}

cpSync(join(here, "template"), target, { recursive: true });
// npm strips .gitignore from published packages, so the template ships it as _gitignore.
renameSync(join(target, "_gitignore"), join(target, ".gitignore"));
cpSync(join(target, ".env.example"), join(target, ".env"));

const pkgPath = join(target, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.name = name;
pkg.dependencies.rebendei = process.env.REBENDEI_VERSION ?? `^${version}`;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

const hasBun = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
const run = (/** @type {string} */ cmd, /** @type {string[]} */ a) =>
  spawnSync(cmd, a, { cwd: target, stdio: "inherit" }).status === 0;

if (!flags.has("--no-install")) {
  if (!hasBun) {
    console.warn("\nBun not found, skipping install. Get it at https://bun.sh then run `bun install`.");
  } else if (!run("bun", ["install"])) {
    console.warn("\nbun install failed; run it yourself inside the folder.");
  }
}

if (!flags.has("--no-git") && spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0) {
  run("git", ["init", "-q"]);
}

const rel = positional[0] ?? "my-rebendei-app";
console.log(`
Created ${name} in ${target}

Next:
  cd ${rel}
  bun run db:up     # Postgres + pgvector in Docker
  bun run dev       # http://localhost:3210
`);
