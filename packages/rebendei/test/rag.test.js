import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { connect } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { createEngine, readSetOverlaps } from "../src/engine/index.js";
import { RAG, openaiCompatible } from "../src/rag/index.js";
import { RebendeiError } from "../src/api.js";
/** @type {import('bun').SQL} */ let sql;
/** @type {Awaited<ReturnType<typeof createEngine>>} */ let engine;
/** @type {import('bun').Server<undefined>} */ let server;
let requests = 0, failures = 0, failureStatus = 429, badDimensions = false;
/** @type {number[]} */ let batchSizes = [];
/** @type {any[]} */ let bodies = [];
/** @param {string} text */
function embed(text) {
  const vector = new Array(64).fill(0);
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) vector[createHash("sha256").update(word).digest()[0] % 64]++;
  if (!vector.some(Boolean)) vector[0] = 1;
  return vector;
}
beforeAll(async () => {
  server = Bun.serve({ port: 0, async fetch(req) {
    const body = await req.json(); bodies.push(body);
    if (req.url.endsWith("/embeddings")) {
      requests++; batchSizes.push(body.input.length);
      if (failures > 0) { failures--; return Response.json({ error: req.headers.get("authorization") }, { status: failureStatus }); }
      return Response.json({ data: body.input.map((/** @type {string} */ text, /** @type {number} */ index) => ({ index, embedding: badDimensions ? [1] : embed(text) })).reverse() });
    }
    if (req.url.endsWith("/chat/completions")) return Response.json({ choices: [{ message: { content: body.messages.map((/** @type {any} */ m) => m.content).join("\n") } }] });
    return new Response(null, { status: 404 });
  } });
  process.env.RAG_TEST_BASE_URL = `http://localhost:${server.port}/v1`;
  sql = connect(); await migrate(sql); engine = await createEngine({ sql, functionsDir: `${import.meta.dir}/rag-fixtures` });
});
beforeEach(async () => {
  const ns = await sql`SELECT name FROM rag_namespaces`;
  for (const row of ns) await engine.runMutation("docs:removeNamespace", { namespace: row.name });
  requests = 0; failures = 0; badDimensions = false; batchSizes = []; bodies = []; failureStatus = 429;
});
afterAll(async () => { await engine.close(); await sql.close(); server.stop(true); delete process.env.RAG_TEST_BASE_URL; });
/** @param {any} args */
const add = async (args) => (await engine.runAction("docs:add", { namespace: "knowledge", ...args })).value;
/** @param {any} args */
const search = async (args) => (await engine.runAction("docs:search", { namespace: "knowledge", ...args })).value;
/** @param {any} [args] */
const list = async (args = {}) => (await engine.runQuery("docs:list", { namespace: "knowledge", ...args })).value;
/** @param {any} [options] */
const provider = (options = {}) => openaiCompatible.embedding({ baseURL: process.env.RAG_TEST_BASE_URL, model: "hashed", dimensions: 64, ...options });

test("vector, text and hybrid retrieve the relevant document first, group titles, and embed only once", async () => {
  const apple = await add({ key: "fruit", title: "Apples", text: "apple orchard fruit apple harvest", metadata: { source: "farm" } });
  await add({ key: "space", title: "Space", text: "rocket planet astronaut orbit" });
  for (const searchType of ["vector", "text", "hybrid"]) {
    const count = requests;
    const result = await search({ query: "apple orchard", searchType });
    expect(result.results[0].entryId).toBe(apple.entryId);
    expect(result.text).toContain("# Apples"); expect(result.entries[0].metadata).toEqual({ source: "farm" });
    expect(requests - count).toBe(searchType === "text" ? 0 : 1);
  }
  const count = requests;
  expect((await search({ query: embed("apple orchard"), searchType: "vector" })).results[0].entryId).toBe(apple.entryId);
  expect(requests).toBe(count);
  const [index] = await sql`SELECT indexdef FROM pg_indexes WHERE indexname LIKE 'rag_hnsw_%'`;
  expect(index.indexdef).toContain("USING hnsw"); expect(index.indexdef).toContain("WHERE"); expect(index.indexdef).toContain("vector(64)");
  const [ns] = await sql`SELECT id FROM rag_namespaces WHERE name='knowledge'`;
  const plan = await sql.begin(async (tx) => {
    await tx`SET LOCAL enable_seqscan=off`;
    return tx.unsafe(`EXPLAIN (FORMAT JSON) SELECT c.* FROM rag_chunks c WHERE namespace_id='${ns.id}' ORDER BY embedding::vector(64) <=> $1::vector LIMIT 1`, [JSON.stringify(embed("apple"))]);
  });
  expect(JSON.stringify(plan)).toContain(`rag_hnsw_${ns.id.slice(0, 40)}`);
});
test("filters are exact-match AND and unknown filter names reject before embedding", async () => {
  const a = await add({ key: "a", text: "apple", filterValues: [{ name: "category", value: "fruit" }, { name: "userId", value: "one" }] });
  await add({ key: "b", text: "apple", filterValues: [{ name: "category", value: "fruit" }, { name: "userId", value: "two" }] });
  expect((await search({ query: "apple", filters: [{ name: "category", value: "fruit" }, { name: "userId", value: "one" }] })).entries.map((/** @type {any} */ e) => e.entryId)).toEqual([a.entryId]);
  expect((await search({ query: "apple", filters: [{ name: "category", value: "fru" }] })).results).toEqual([]);
  expect((await search({ query: "apple", filters: [{ name: "category", value: "fruit" }] })).entries.length).toBe(2);
  await add({ key: "nested", text: "apple", filterValues: [{ name: "category", value: ["a", "b"] }] });
  for (const searchType of ["text", "vector", "hybrid"]) {
    expect((await search({ query: "apple", searchType, filters: [{ name: "category", value: ["a"] }] })).results).toEqual([]);
    expect((await search({ query: "apple", searchType, filters: [{ name: "category", value: ["a", "b"] }] })).entries[0].key).toBe("nested");
  }
  const count = requests;
  await expect(add({ text: "apple", filterValues: [{ name: "secret", value: true }] })).rejects.toThrow("Unknown RAG filter");
  expect(requests).toBe(count);
});
test("unchanged normalized content avoids embedding; stable key replacement removes old chunks atomically", async () => {
  const args = { key: "stable", chunks: [{ text: "old apple", metadata: { b: 2, a: 1 } }, "old orchard"], title: "Original", metadata: { b: 2, a: 1 } };
  const first = await add(args), count = requests;
  const same = await add({ ...args, chunks: [{ text: " old apple\r\n", metadata: { a: 1, b: 2 } }, "old orchard"], metadata: { a: 1, b: 2 } });
  expect(same).toEqual({ entryId: first.entryId, status: "unchanged", created: false }); expect(requests).toBe(count);
  const replacement = await add({ key: "stable", text: "new rocket", title: "Replacement" });
  expect(replacement).toEqual({ entryId: first.entryId, status: "replaced", created: false });
  const chunks = await sql`SELECT text FROM rag_chunks WHERE entry_id=${first.entryId}`;
  expect(chunks.map((/** @type {any} */ c) => c.text)).toEqual(["new rocket"]);
  expect((await search({ query: "apple", searchType: "text" })).results).toEqual([]);
});
test("metadata, filters, title, and importance participate in the content hash", async () => {
  const args = { key: "same", text: "apple" };
  await add(args);
  for (const changes of [{ title: "Title" }, { metadata: { updated: true } }, { filterValues: [{ name: "category", value: "fruit" }] }, { importance: 0.5 }]) {
    expect((await add({ ...args, ...changes })).status).toBe("replaced");
  }
});
test("list pagination, get, delete, namespace removal and action deletion", async () => {
  for (let n = 0; n < 5; n++) await add({ key: String(n), text: "apple" });
  let cursor = null, done = false; const keys = [];
  while (!done) { const result = await list({ paginationOpts: { numItems: 2, cursor } }); keys.push(...result.page.map((/** @type {any} */ e) => e.key)); done = result.isDone; cursor = result.continueCursor; }
  expect(keys.sort()).toEqual(["0", "1", "2", "3", "4"]);
  expect((await engine.runQuery("docs:get", { namespace: "knowledge", key: "0" })).value.key).toBe("0");
  await engine.runMutation("docs:remove", { namespace: "knowledge", key: "0" });
  expect((await engine.runQuery("docs:get", { namespace: "knowledge", key: "0" })).value).toBeNull();
  await engine.runAction("docs:removeAction", { namespace: "knowledge", key: "1" });
  expect((await list()).page.length).toBe(3);
  expect((await engine.runMutation("docs:removeNamespace", { namespace: "knowledge" })).value).toBe(3);
  expect((await list()).page).toEqual([]); expect((await search({ query: "apple" })).results).toEqual([]);
  expect((await sql`SELECT count(*)::int AS n FROM rag_chunks`)[0].n).toBe(0);
  expect((await sql`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname LIKE 'rag_hnsw_%'`)[0].n).toBe(0);
});
test("delete is transactional and queries cannot write; add only runs in actions", async () => {
  await add({ key: "keep", text: "apple" });
  await expect(engine.runMutation("docs:rollback", { namespace: "knowledge", key: "keep" })).rejects.toThrow("rollback");
  expect((await list()).page.length).toBe(1);
  await expect(engine.runQuery("docs:forbiddenDelete", { namespace: "knowledge", key: "keep" })).rejects.toThrow("read-only");
  const count = requests;
  await expect(engine.runMutation("docs:forbiddenAdd", { namespace: "knowledge", text: "apple" })).rejects.toThrow("requires an action"); expect(requests).toBe(count);
});
test("429 and 5xx retry, batching at most 64, and retry cap", async () => {
  failures = 1; expect((await provider().embed(["apple"]))[0]).toEqual(embed("apple")); expect(requests).toBe(2);
  failures = 1; failureStatus = 503; await provider().embed(["apple"]); expect(requests).toBe(4);
  batchSizes = []; await provider().embed(Array(130).fill("apple")); expect(batchSizes).toEqual([64, 64, 2]);
  failures = 10; const count = requests; await expect(provider().embed(["apple"])).rejects.toBeInstanceOf(RebendeiError); expect(requests - count).toBe(4);
});
test("401 and fetch errors never leak keys, even when provider reflects authorization", async () => {
  failures = 1; failureStatus = 401; const key = "private-test-key";
  try { await provider({ apiKey: key }).embed(["apple"]); throw new Error("expected failure"); }
  catch (error) { expect(error).toBeInstanceOf(RebendeiError); expect(/** @type {Error} */ (error).message).not.toContain(key); expect(/** @type {RebendeiError} */ (error).data.status).toBe(401); }
  const customFetch = async () => { throw new Error(key); };
  await expect(provider({ apiKey: key, fetch: customFetch }).embed(["apple"])).rejects.toThrow('"status":0');
});
test("provider response and namespace dimension/model mismatches are clear errors", async () => {
  badDimensions = true; await expect(provider().embed(["apple"])).rejects.toThrow("dimension");
  await expect(add({ text: "apple" })).rejects.toThrow("dimension");
  expect((await list()).page).toEqual([]);
  badDimensions = false; await add({ text: "apple" });
  await sql`UPDATE rag_namespaces SET dimensions=32 WHERE name='knowledge'`;
  const count = requests; await expect(add({ text: "apple" })).rejects.toThrow("dimension/model mismatch"); expect(requests).toBe(count);
  await sql`UPDATE rag_namespaces SET dimensions=64,model='other' WHERE name='knowledge'`;
  await expect(search({ query: "apple" })).rejects.toThrow("dimension/model mismatch");
});
test("chunkContext adds neighbors in order and generateText numbers sources and enforces grounding", async () => {
  await add({ key: "source", title: "Fruit guide", chunks: ["Before context", "apple orchard", "After context"] });
  const found = await search({ query: "apple", searchType: "text", chunkContext: { before: 1, after: 1 } });
  expect(found.results[0].content.map((/** @type {any} */ c) => c.text)).toEqual(["Before context", "apple orchard", "After context"]);
  const generated = (await engine.runAction("docs:generate", { namespace: "knowledge", prompt: "apple", search: { searchType: "text" } })).value;
  expect(generated.text).toContain("[1] Fruit guide"); expect(generated.text).toContain("Answer only from the supplied context"); expect(generated.text).toContain("Cite sources with [n]"); expect(generated.context.entries.length).toBe(1);
});
test("synthetic writes persist in the commit and invalidate subscribed list and missing get reads", async () => {
  const read = await engine.runQuery("docs:list", { namespace: "knowledge" });
  const missing = await engine.runQuery("docs:get", { namespace: "knowledge", key: "new" });
  /** @type {import('../src/engine/types.js').Write[]} */ let writes = []; let ts = "";
  const unsubscribe = engine.onCommit((stamp, changes) => { writes = changes; ts = stamp; });
  try {
    await add({ key: "new", text: "apple" });
    expect(readSetOverlaps(read.readSet, writes)).toBe(true); expect(readSetOverlaps(missing.readSet, writes)).toBe(true);
    expect(writes[0].table).toBe("_rag:knowledge");
    expect((await sql`SELECT writes FROM commits WHERE ts=${ts}::bigint`)[0].writes).toEqual(writes);
    expect((await engine.runQuery("docs:list", { namespace: "knowledge" })).value.page[0].key).toBe("new");
    const get = await engine.runQuery("docs:get", { namespace: "knowledge", key: "new" });
    await engine.runMutation("docs:removeNamespace", { namespace: "knowledge" });
    expect(readSetOverlaps(get.readSet, writes)).toBe(true); expect((await list()).page).toEqual([]);
  } finally { unsubscribe(); }
});
test("importance weights vector and hybrid scores; thresholds filter vector results", async () => {
  const strong = await add({ key: "strong", text: "apple orchard", importance: 1 });
  await add({ key: "weak", text: "apple orchard", importance: 0.01 });
  for (const searchType of ["vector", "hybrid"]) expect((await search({ query: "apple orchard", searchType })).results[0].entryId).toBe(strong.entryId);
  expect((await search({ query: "planet astronaut", searchType: "vector", vectorScoreThreshold: 0.99 })).results).toEqual([]);
});
test("concurrent first additions and same-key replacements stay atomic", async () => {
  const first = await Promise.all([add({ key: "one", text: "apple" }), add({ key: "two", text: "rocket" })]);
  expect(first.every((r) => r.status === "ready")).toBe(true); expect((await list()).page.length).toBe(2);
  const changed = await Promise.all([add({ key: "one", chunks: ["new apple", "new orchard"] }), add({ key: "one", chunks: ["new rocket", "new orbit"] })]);
  expect(changed.every((r) => r.status === "replaced")).toBe(true);
  const rows = await sql`SELECT text FROM rag_chunks WHERE entry_id=${first[0].entryId} ORDER BY "order"`;
  const texts = rows.map((/** @type {any} */ r) => r.text);
  expect(texts.join(" ")).toMatch(/^(new apple new orchard|new rocket new orbit)$/);
});
test("scalar and null metadata round-trip and failed replacement preserves original chunks", async () => {
  const old = await add({ key: "keep", chunks: [{ text: "original apple", metadata: "chunk-source" }], metadata: null });
  expect((await engine.runQuery("docs:get", { namespace: "knowledge", key: "keep" })).value.metadata).toBeNull();
  expect((await search({ query: "apple", searchType: "text" })).results[0].content[0].metadata).toBe("chunk-source");
  failures = 1; failureStatus = 401;
  await expect(add({ key: "keep", text: "replacement rocket" })).rejects.toThrow('"status":401');
  expect((await sql`SELECT text FROM rag_chunks WHERE entry_id=${old.entryId}`)[0].text).toBe("original apple");
});
test("provider supports custom headers/fetch, sends timeout signals, and reorders response indices", async () => {
  expect(await provider().embed(["apple", "rocket"])).toEqual([embed("apple"), embed("rocket")]);
  let inspected = false;
  /** @type {NonNullable<import('../src/rag/providers.js').ProviderOptions['fetch']>} */
  const custom = async (url, init) => {
    expect(String(url)).toEndWith("/embeddings");
    expect(new Headers(init?.headers).get("x-source")).toBe("test");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-test-key");
    expect(init?.signal).toBeInstanceOf(AbortSignal); inspected = true;
    const body = JSON.parse(String(init?.body)); expect(body.dimensions).toBe(64); expect(body.model).toBe("hashed");
    return Response.json({ data: [{ index: 0, embedding: embed("apple") }] });
  };
  await provider({ apiKey: "private-test-key", headers: { "x-source": "test" }, fetch: custom }).embed(["apple"]); expect(inspected).toBe(true);
  const chat = openaiCompatible.chat({ baseURL: process.env.RAG_TEST_BASE_URL, model: "echo", apiKey: "private-test-key", fetch: async () => Response.json({ error: "private-test-key" }, { status: 401 }) });
  try { await chat.generate({ messages: [{ role: "user", content: "Hi" }] }); throw new Error("expected failure"); }
  catch (error) { expect(error).toBeInstanceOf(RebendeiError); expect(/** @type {Error} */ (error).message).not.toContain("private-test-key"); }
});
test("namespace identifiers cannot inject SQL and cursors are namespace scoped", async () => {
  const namespace = "tenant'; DROP TABLE rag_entries; -- / 🥭";
  await add({ namespace, key: "one", text: "apple" }); await add({ namespace, key: "two", text: "apple" });
  expect((await search({ namespace, query: "apple" })).entries.length).toBe(2);
  const page = await list({ namespace, paginationOpts: { numItems: 1 } });
  await expect(list({ paginationOpts: { numItems: 1, cursor: page.continueCursor } })).rejects.toThrow("cursor");
  expect((await sql`SELECT count(*)::int AS n FROM rag_entries`)[0].n).toBe(2);
  await engine.runMutation("docs:removeNamespace", { namespace });
  expect((await search({ namespace, query: "apple" })).results).toEqual([]);
});
test("default is free local Ollama and constructor rejects unsupported HNSW dimensions", () => {
  expect(new RAG().embedding.model).toBe("nomic-embed-text");
  expect(() => new RAG({ embedding: { model: "too-big", dimensions: 3000, embed: async () => [] } })).toThrow("2000");
});
