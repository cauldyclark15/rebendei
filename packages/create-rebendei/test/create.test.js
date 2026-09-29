import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "..", "index.js");

test("scaffolds a new app", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "rebendei-")), "My App");
  const res = Bun.spawnSync(["node", cli, dir, "--no-install", "--no-git"]);
  expect(res.exitCode).toBe(0);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  expect(pkg.name).toBe("my-app");
  expect(pkg.dependencies.rebendei).toMatch(/^\^\d/);
  for (const f of [".gitignore", ".env", "docker-compose.yml", "rebendei/README.md"]) {
    expect(existsSync(join(dir, f))).toBe(true);
  }
});

test("refuses a non-empty folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "rebendei-"));
  Bun.write(join(dir, "x"), "x");
  const res = Bun.spawnSync(["node", cli, dir, "--no-install"]);
  expect(res.exitCode).toBe(1);
});
