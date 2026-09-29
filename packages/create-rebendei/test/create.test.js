import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageDir = join(import.meta.dir, "..");
const cli = join(packageDir, "index.js");
const templateFiles = [
  ".env.example", "docker-compose.yml", "package.json", "README.md",
  "rebendei/README.md", "rebendei/schema.js", "rebendei/messages.js",
  "rebendei/crons.js", "rebendei/rag.js", "rebendei/knowledge.js", "scripts/demo.js",
];
const temp = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "rebendei-create-"));

test("scaffolds the working messages and RAG app, copying .env", () => {
  const directory = temp(), dir = join(directory, "My App");
  try {
    const res = Bun.spawnSync(["node", cli, dir, "--no-install", "--no-git"]);
    expect(res.exitCode).toBe(0);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.name).toBe("my-app");
    expect(pkg.dependencies.rebendei).toMatch(/^\^\d/);
    expect(pkg.scripts.demo).toBe("bun scripts/demo.js");
    for (const file of [...templateFiles, ".gitignore", ".env"]) {
      expect(existsSync(join(dir, file))).toBe(true);
    }
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(readFileSync(join(dir, ".env.example"), "utf8"));
    expect(existsSync(join(dir, "_gitignore"))).toBe(false);
    expect(existsSync(join(dir, ".git"))).toBe(false);
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("npm package includes the full template, including env and demo", () => {
  const directory = temp();
  try {
    const packed = Bun.spawnSync(["npm", "pack", "--dry-run", "--json", "--ignore-scripts", "--cache", directory], { cwd: packageDir });
    expect(packed.exitCode).toBe(0);
    const [{ files }] = JSON.parse(packed.stdout.toString());
    const paths = files.map((/** @type {{path:string}} */ file) => file.path);
    for (const file of [...templateFiles, "_gitignore"]) expect(paths).toContain(`template/${file}`);
    expect(paths).toContain("index.js");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("refuses a non-empty folder without changing it", () => {
  const dir = temp();
  try {
    writeFileSync(join(dir, "x"), "keep");
    const res = Bun.spawnSync(["node", cli, dir, "--no-install", "--no-git"]);
    expect(res.exitCode).toBe(1);
    expect(readFileSync(join(dir, "x"), "utf8")).toBe("keep");
    expect(existsSync(join(dir, "package.json"))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
