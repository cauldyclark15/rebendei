import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { createEngine } from "../src/engine/index.js";
import { vectorTableName } from "../src/vector/index.js";
/** @type {import('bun').SQL} */ let sql;
/** @type {Awaited<ReturnType<typeof createEngine>>} */ let engine;
let functionsDir = "";
const apiURL = new URL("../src/api.js", import.meta.url).href;
const tableName = vectorTableName("articles", "by_embedding");
/** @param {string} name */ const quote = (name) => `"${name.replaceAll('"', '""')}"`;
/** @param {any} doc */ const insert = async (doc) => (await engine.runMutation("articles:insert", { doc })).value;
/** @param {any} [options] */ const search = async (options = {}) => (await engine.runAction("articles:search", { vector: [1, 0, 0], ...options })).value;
/** @param {number[]} a @param {number[]} b */
function cosine(a, b) {
  const dot = a.reduce((sum, x, i) => sum + x * b[i], 0);
  return dot / Math.sqrt(a.reduce((sum, x) => sum + x * x, 0) * b.reduce((sum, x) => sum + x * x, 0));
}
/** @param {number|null} dimensions @param {boolean} [schemaValidation] @param {string[]} [filterFields] @param {string} [vectorField] */
async function schema(dimensions, schemaValidation = true, filterFields = ["channel", "tag"], vectorField = "embedding") {
  const code = `import { defineSchema, defineTable, v } from ${JSON.stringify(apiURL)};
export default defineSchema({ articles: defineTable({ embedding:v.optional(v.array(v.number())), other:v.optional(v.array(v.number())), channel:v.optional(v.string()), tag:v.optional(v.any()) })
${dimensions === null ? "" : `.vectorIndex("by_embedding", ${JSON.stringify({ dimensions, vectorField, filterFields })})`} }, {schemaValidation:${schemaValidation}});`;
  await Bun.write(join(functionsDir, "schema.js"), code);
  await engine.load();
}
beforeAll(async () => { sql = connect(); await migrate(sql); });
beforeEach(async () => {
  await sql`TRUNCATE documents, index_entries, commits`;
  const rows = await sql`SELECT pg_table_name FROM vector_indexes`;
  for (const row of rows) await sql.unsafe(`TRUNCATE ${quote(row.pg_table_name)}`);
  functionsDir = await mkdtemp(join(process.env.TMPDIR ?? import.meta.dir, "rebendei-vector-"));
  for (const name of ["schema", "articles"]) {
    const source = await Bun.file(join(import.meta.dir, "vector-fixtures", `${name}.js`)).text();
    await Bun.write(join(functionsDir, `${name}.js`), source.replace('"../../src/api.js"', JSON.stringify(apiURL)));
  }
  engine = await createEngine({ sql, functionsDir });
});
afterEach(async () => { await engine?.close(); await rm(functionsDir, { recursive: true, force: true }); });
afterAll(async () => { await sql.close(); });

test("schema materializes registered pgvector tables, HNSW, GIN and btree indexes", async () => {
  const rows = await sql`SELECT * FROM vector_indexes ORDER BY index_name`;
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ table_name: "articles", index_name: "by_embedding", dimensions: 3, vector_field: "embedding", filter_fields: ["channel", "tag"], pg_table_name: tableName });
  const indexes = await sql`SELECT indexdef FROM pg_indexes WHERE tablename = ${tableName}`;
  expect(indexes.some((/** @type {any} */ row) => row.indexdef.includes("USING hnsw") && row.indexdef.includes("vector_cosine_ops"))).toBe(true);
  expect(indexes.some((/** @type {any} */ row) => row.indexdef.includes("USING gin"))).toBe(true);
  expect(indexes.filter((/** @type {any} */ row) => row.indexdef.includes("USING btree"))).toHaveLength(3);
  const [column] = await sql`SELECT format_type(a.atttypid, a.atttypmod) AS type FROM pg_attribute a WHERE a.attrelid = ${tableName}::regclass AND a.attname = 'embedding'`;
  expect(column.type).toBe("vector(3)");
});
test("mutation inserts search by nearest cosine and scores agree with brute-force JS", async () => {
  const vectors = [[1, 0, 0], [1, 1, 0], [0.5, 0.2, 0.4], [0, 1, 0], [-1, 0, 0]];
  const docs = [];
  for (const vector of vectors) docs.push({ id: await insert({ embedding: vector, other: vector }), vector });
  await insert({ channel: "missing" });
  const query = [1, 0.2, 0.1];
  const brute = docs.map((doc) => ({ _id: doc.id, _score: cosine(doc.vector, query) })).sort((a, b) => b._score - a._score);
  const actual = await search({ vector: query });
  expect(actual.map((/** @type {any} */ row) => row._id)).toEqual(brute.map((row) => row._id));
  actual.forEach((/** @type {any} */ row, /** @type {number} */ i) => expect(row._score).toBeCloseTo(brute[i]._score, 6));
  expect((await search({ index: "by_other", vector: query }))).toEqual(actual);
  expect(await search({ limit: 1, vector: query })).toEqual([actual[0]]);
  expect(Object.keys(actual[0])).toEqual(["_id", "_score"]);
});
test("declared eq/or filters have exact JSON array/object/null semantics and bind values", async () => {
  const a = await insert({ embedding: [1, 0, 0], channel: "a", tag: [1] });
  const b = await insert({ embedding: [1, 1, 0], channel: "b", tag: [1, 2] });
  const c = await insert({ embedding: [0, 1, 0], channel: "c", tag: null });
  const injected = await insert({ embedding: [-1, 0, 0], channel: "' OR true --", tag: { x: 1 } });
  expect((await search({ eq: ["channel", "a"] })).map((/** @type {any} */ row) => row._id)).toEqual([a]);
  expect((await search({ or: [["channel", "a"], ["channel", "b"]] })).map((/** @type {any} */ row) => row._id)).toEqual([a, b]);
  expect((await search({ eq: ["tag", [1]] })).map((/** @type {any} */ row) => row._id)).toEqual([a]);
  expect((await search({ eq: ["tag", null] })).map((/** @type {any} */ row) => row._id)).toEqual([c]);
  expect((await search({ eq: ["tag", { x: 1 }] })).map((/** @type {any} */ row) => row._id)).toEqual([injected]);
  expect((await search({ eq: ["channel", "' OR true --"] })).map((/** @type {any} */ row) => row._id)).toEqual([injected]);
  expect(await search({ eq: ["channel", "absent"] })).toEqual([]);
  await expect(search({ eq: ["not_declared", 1] })).rejects.toThrow("Undeclared vector filter field");
  await expect(search({ forged: true })).rejects.toThrow("must return q.eq or q.or");
  await expect(search({ emptyOr: true })).rejects.toThrow("at least one");
  await expect(search({ rawFilter: { channel: "a" } })).rejects.toThrow("must be a function");
});
test("patch, replacement, filter changes, missing vector and delete keep rows synchronized", async () => {
  const a = await insert({ embedding: [1, 0, 0], channel: "a" });
  const b = await insert({ embedding: [1, 1, 0], channel: "a" });
  await engine.runMutation("articles:patch", { id: a, value: { embedding: [-1, 0, 0], channel: "b" } });
  expect((await search()).map((/** @type {any} */ row) => row._id)).toEqual([b, a]);
  expect((await search({ eq: ["channel", "a"] })).map((/** @type {any} */ row) => row._id)).toEqual([b]);
  await engine.runMutation("articles:replace", { id: a, doc: { embedding: [1, 0, 0], channel: "c" } });
  expect((await search())[0]).toEqual({ _id: a, _score: 1 });
  await engine.runMutation("articles:removeEmbedding", { id: a });
  expect((await search()).map((/** @type {any} */ row) => row._id)).toEqual([b]);
  await engine.runMutation("articles:remove", { id: b });
  expect(await search()).toEqual([]);
  expect((await sql.unsafe(`SELECT * FROM ${quote(tableName)}`))).toHaveLength(0);
});
test("invalid document vectors roll back all rows and commit; schema validation runs first", async () => {
  for (const schemaValidation of [true, false]) {
    await schema(3, schemaValidation);
    await expect(insert({ embedding: [1, 2] })).rejects.toThrow("array of 3 finite float32 numbers");
    await expect(insert({ embedding: [1, "bad", 0] })).rejects.toThrow(schemaValidation ? "embedding.1" : "array of 3 finite float32 numbers");
    await expect(insert({ embedding: [Number.MAX_VALUE, 0, 0] })).rejects.toThrow("finite float32");
  }
  await expect(engine.runMutation("articles:rollback", { doc: { embedding: [1, 0, 0] } })).rejects.toThrow("rollback vector write");
  expect((await sql`SELECT * FROM documents`)).toHaveLength(0);
  expect((await sql`SELECT * FROM commits`)).toHaveLength(0);
  expect((await sql.unsafe(`SELECT * FROM ${quote(tableName)}`))).toHaveLength(0);
  const id = await insert({ embedding: [1, 0, 0] });
  await expect(engine.runMutation("articles:patch", { id, value: { embedding: [1] } })).rejects.toThrow("array of 3");
  expect((await search())[0]._id).toBe(id);
});
test("zero document embeddings are stored but never returned with undefined cosine scores", async () => {
  const zero = await insert({ embedding: [0, 0, 0] });
  const good = await insert({ embedding: [1, 0, 0] });
  expect((await engine.runQuery("articles:get", { id: zero })).value.embedding).toEqual([0, 0, 0]);
  expect((await sql.unsafe(`SELECT * FROM ${quote(tableName)}`))).toHaveLength(2);
  expect(await search()).toEqual([{ _id: good, _score: 1 }]);
});
test("search validates vectors, limits/indexes and is only available in actions", async () => {
  expect((await engine.runQuery("articles:queryContext")).value).toBe("undefined");
  expect((await engine.runMutation("articles:mutationContext")).value).toBe("undefined");
  await expect(search({ vector: [1, 0] })).rejects.toThrow("array of 3");
  await expect(search({ vector: [1, "bad", 0] })).rejects.toThrow("finite float32");
  await expect(search({ vector: [0, 0, 0] })).rejects.toThrow("nonzero");
  await expect(search({ index: "absent" })).rejects.toThrow("Unknown vector index");
  await expect(search({ table: "absent" })).rejects.toThrow("Unknown vector index");
  for (const limit of [0, -1, 1.5, 257, null]) await expect(search({ limit })).rejects.toThrow("between 1 and 256");
  expect(await search({ limit: 256 })).toEqual([]);
});
test("dimension reload rebuilds and backfills compatible documents; unchanged reload retains tables", async () => {
  const old = await insert({ embedding: [1, 0, 0] });
  const [before] = await sql`SELECT ${tableName}::regclass::oid AS oid`;
  await engine.load();
  const [same] = await sql`SELECT ${tableName}::regclass::oid AS oid`;
  expect(same.oid).toBe(before.oid);
  await schema(2);
  const [after] = await sql`SELECT ${tableName}::regclass::oid AS oid`;
  expect(after.oid).not.toBe(before.oid);
  expect((await sql`SELECT dimensions FROM vector_indexes`)[0].dimensions).toBe(2);
  expect((await engine.runQuery("articles:get", { id: old })).value.embedding).toEqual([1, 0, 0]);
  expect(await search({ vector: [1, 0] })).toEqual([]);
  const fresh = await insert({ embedding: [1, 0] });
  expect(await search({ vector: [1, 0] })).toEqual([{ _id: fresh, _score: 1 }]);
  await expect(insert({ embedding: [1, 0, 0] })).rejects.toThrow("array of 2");
});
test("adding an index later backfills only valid historical vectors; removing it drops registry/table", async () => {
  await schema(null, false);
  const good = await insert({ embedding: [1, 0, 0], channel: "a" });
  await insert({ embedding: [1, 0] }); await insert({ embedding: ["bad", 0, 0] });
  await insert({ embedding: "not an array" }); await insert({ channel: "missing" });
  await schema(3, false);
  expect(await search({ eq: ["channel", "a"] })).toEqual([{ _id: good, _score: 1 }]);
  expect(await search()).toHaveLength(1);
  await schema(null);
  expect((await sql`SELECT * FROM vector_indexes`)).toHaveLength(0);
  expect((await sql`SELECT to_regclass(${tableName}) AS table`)[0].table).toBeNull();
  await expect(search()).rejects.toThrow("Unknown vector index");
});
test("vector/filter field changes rebuild historical rows", async () => {
  const id = await insert({ embedding: [1, 0, 0], other: [-1, 0, 0], channel: "a", tag: 1 });
  await schema(3, true, ["tag"], "other");
  expect(await search({ eq: ["tag", 1] })).toEqual([{ _id: id, _score: -1 }]);
  await expect(search({ eq: ["channel", "a"] })).rejects.toThrow("Undeclared");
});
test("long names, uppercase and ambiguous delimiters have distinct bounded physical identifiers", async () => {
  const table = `Articles${"x".repeat(70)}`, index = `Embedding${"y".repeat(70)}`;
  const name = vectorTableName(table, index);
  expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
  expect(name).toBe(vectorTableName(table, index));
  expect(vectorTableName("a__b", "c")).not.toBe(vectorTableName("a", "b__c"));
  expect(vectorTableName("a-b", "c")).not.toBe(vectorTableName("a_b", "c"));
  expect(vectorTableName("Articles", "Embedding")).toMatch(/^rv_t_[0-9a-f]{48}$/);
  await Bun.write(join(functionsDir, "schema.js"), `import {defineSchema, defineTable, v} from ${JSON.stringify(apiURL)};
export default defineSchema({${JSON.stringify(table)}:defineTable({embedding:v.array(v.number())}).vectorIndex(${JSON.stringify(index)}, {vectorField:"embedding",dimensions:3})});`);
  await engine.load();
  const id = (await engine.runMutation("articles:insert", { table, doc: { embedding: [1, 0, 0] } })).value;
  expect(await search({ table, index })).toEqual([{ _id: id, _score: 1 }]);
  const [row] = await sql`SELECT pg_table_name FROM vector_indexes`;
  expect(row.pg_table_name).toBe(name);
});
test("2000 mutation-written documents use HNSW, filtered iterative scan and print latency", async () => {
  let seed = 17019;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const docs = Array.from({ length: 2000 }, (_, i) => ({ embedding: [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1], channel: i % 100 === 0 ? "rare" : "common" }));
  await engine.runMutation("articles:batch", { docs });
  await sql.unsafe(`ANALYZE ${quote(tableName)}`);
  const plan = await sql.begin(async (tx) => {
    await tx`SET LOCAL hnsw.ef_search = 40`;
    await tx`SET LOCAL hnsw.iterative_scan = 'strict_order'`;
    return tx.unsafe(`EXPLAIN (ANALYZE, FORMAT JSON) SELECT doc_id, 1-(embedding <=> $1::vector) FROM ${quote(tableName)} WHERE (embedding <=> $1::vector) < 'NaN'::double precision ORDER BY embedding <=> $1::vector LIMIT 10`, ["[1,0,0]"]);
  });
  const root = plan[0]["QUERY PLAN"][0].Plan;
  expect(JSON.stringify(root)).toContain('"Node Type":"Index Scan"');
  expect(JSON.stringify(root)).toContain("_hnsw");
  const start = performance.now();
  const result = await search();
  const latency = performance.now() - start;
  console.log(`vectorSearch 2000 docs: ${latency.toFixed(2)} ms; EXPLAIN ${root.Plans[0]["Node Type"]} using ${root.Plans[0]["Index Name"]}`);
  expect(result).toHaveLength(10);
  const stored = await sql.unsafe(`SELECT doc_id, embedding::text FROM ${quote(tableName)}`);
  const brute = stored.map((/** @type {any} */ row) => ({ _id: row.doc_id, _score: cosine(JSON.parse(row.embedding), [1, 0, 0]) })).sort((/** @type {any} */ a, /** @type {any} */ b) => b._score - a._score);
  expect(result.map((/** @type {any} */ row) => row._id)).toEqual(brute.slice(0, 10).map((/** @type {any} */ row) => row._id));
  result.forEach((/** @type {any} */ row, /** @type {number} */ i) => expect(row._score).toBeCloseTo(brute[i]._score, 6));
  const filtered = await search({ eq: ["channel", "rare"] });
  expect(filtered).toHaveLength(10);
  for (const row of filtered) expect((await engine.runQuery("articles:get", { id: row._id })).value.channel).toBe("rare");
  // GUC changes are transaction-local, never leaked back into the pool.
  expect((await sql`SELECT current_setting('hnsw.ef_search') AS ef_search`)[0].ef_search).toBe("40");
}, 30000);

test("M2 valid index names cannot collide with another table or its secondary relations", async () => {
  const names = ["embedding", "embedding_hnsw", "embedding_filter", "embedding_f0", "embedding_pkey", "a__b", "a_b"];
  await Bun.write(join(functionsDir, "schema.js"), `import {defineSchema, defineTable, v} from ${JSON.stringify(apiURL)};
export default defineSchema({articles:defineTable({embedding:v.array(v.number()),channel:v.string()})${names.map(name => `.vectorIndex(${JSON.stringify(name)}, {vectorField:"embedding",dimensions:3,filterFields:["channel"]})`).join("")}});`);
  await engine.load();
  const id = await insert({ embedding: [1, 0, 0], channel: "a" });
  const relations = await sql`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'rv_%'`;
  expect(new Set(relations.map((/** @type {any} */ row) => row.relname)).size).toBe(relations.length);
  for (const index of names) expect(await search({ index, eq: ["channel", "a"] })).toEqual([{ _id: id, _score: 1 }]);
});


test("legacy 0004 physical tables rebuild and backfill automatically on reload", async () => {
  const id = await insert({ embedding: [1, 0, 0], channel: "a" });
  const legacy = "rv_articles__by_embedding";
  await sql.begin(async tx => {
    await tx.unsafe(`ALTER TABLE ${quote(tableName)} RENAME TO ${quote(legacy)}`);
    await tx`UPDATE vector_indexes SET pg_table_name=${legacy} WHERE table_name='articles' AND index_name='by_embedding'`;
  });
  await engine.load();
  expect((await sql`SELECT to_regclass(${legacy}) AS relation`)[0].relation).toBeNull();
  expect((await sql`SELECT pg_table_name FROM vector_indexes WHERE table_name='articles' AND index_name='by_embedding'`)[0].pg_table_name).toBe(tableName);
  expect(await search({ eq: ["channel", "a"] })).toEqual([{ _id: id, _score: 1 }]);
  const [before] = await sql`SELECT ${tableName}::regclass::oid AS oid`;
  await engine.load();
  expect((await sql`SELECT ${tableName}::regclass::oid AS oid`)[0].oid).toBe(before.oid);
});
