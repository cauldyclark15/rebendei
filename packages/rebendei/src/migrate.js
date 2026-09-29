import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "./db.js";

const dir = join(import.meta.dir, "..", "migrations");

/** Applies every *.sql file in migrations/ not yet recorded, in filename order.
 * @param {import("bun").SQL} sql */
export async function migrate(sql) {
  await sql`CREATE TABLE IF NOT EXISTS _migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;
  const done = new Set((await sql`SELECT name FROM _migrations`).map((/** @type {{name:string}} */ r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const body = await Bun.file(join(dir, file)).text();
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO _migrations (name) VALUES (${file})`;
    });
    applied.push(file);
  }
  return applied;
}

if (import.meta.main) {
  const sql = connect();
  const applied = await migrate(sql);
  console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
  await sql.close();
}
