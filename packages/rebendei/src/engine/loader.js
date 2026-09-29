import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { isFunctionDef } from "../api.js";
let generation = 0;
/** @param {string} functionsDir */
export async function loadFunctions(functionsDir) {
  /** @type {Map<string,import('../api.js').FunctionDef>} */ const functions = new Map();
  /** @type {import('../schema.js').Schema|null} */ let schema = null;
  let crons = null;
  const suffix = `?rebendei_load=${++generation}`;
  /** @param {string} dir */
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (error) { if (dir === functionsDir && /** @type {any} */ (error).code === "ENOENT") return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (/^[_.]/.test(entry.name)) continue;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
      const name = relative(functionsDir, file).split(sep).join("/").slice(0, -3);
      // Bun 1.3 strips cache-busting queries from file: URLs; absolute paths retain them.
      const module = await import(file + suffix);
      if (name === "schema") { schema = module.default; continue; }
      if (name === "crons") { crons = module.default; continue; }
      for (const [exportName, value] of Object.entries(module)) if (isFunctionDef(value)) {
        functions.set(`${name}:${exportName}`, value);
        if (exportName === "default") functions.set(name, value);
      }
    }
  }
  await walk(functionsDir);
  return { functions, schema, crons };
}
