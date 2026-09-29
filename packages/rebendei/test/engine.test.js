import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { connect } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { createEngine, readSetOverlaps, ENGINE_INTERNAL } from "../src/engine/index.js";
import { encodeKey, compareKeys } from "../src/engine/keys.js";
import { startServer } from "../src/server.js";
/** @type {import('bun').SQL} */ let sql;
/** @type {Awaited<ReturnType<typeof createEngine>>} */ let engine;
const functionsDir = join(import.meta.dir, "fixtures");
beforeAll(async () => { sql = connect(); await migrate(sql); engine = await createEngine({ sql, functionsDir }); });
beforeEach(async () => { await sql`TRUNCATE documents, index_entries, commits`; });
afterAll(async () => { await engine.close(); await sql.close(); });
/** @param {number} score @param {string} [channel] */
const insert = async (score, channel = "a") => (await engine.runMutation("messages:insert", { channel, score, body: "text" })).value;
/** @param {any} args */
const range = async (args) => (await engine.runQuery("messages:range", args)).value;

test("CRUD, system fields, removal by undefined, replacement and deletion", async () => {
  const id = await insert(1);
  const { value: doc, readSet } = await engine.runQuery("messages:get", { id });
  expect(id).toMatch(/^messages:[0-9a-f-]{36}$/); expect(doc._creationTime).toBeNumber();
  expect(doc.body).toBe("text"); expect(readSet.ranges[0].index).toBe("by_id");
  await engine.runMutation("messages:removeBody", { id });
  expect((await engine.runQuery("messages:get", { id })).value.body).toBeUndefined();
  await engine.runMutation("messages:patch", { id, value: { score: 2 } });
  expect((await engine.runQuery("messages:get", { id })).value.score).toBe(2);
  await engine.runMutation("messages:replace", { id, value: { channel: "b", score: 3 } });
  const replaced = (await engine.runQuery("messages:get", { id })).value;
  expect(replaced).toEqual({ channel: "b", score: 3, _id: id, _creationTime: doc._creationTime });
  await engine.runMutation("messages:remove", { id });
  expect((await engine.runQuery("messages:get", { id })).value).toBeNull();
  expect(await range({ channel: "b" })).toEqual([]);
  const [entries] = await sql`SELECT count(*)::int AS n FROM index_entries`; expect(entries.n).toBe(0);
});
test("schema, argument validation and reserved system fields reject invalid writes", async () => {
  await expect(engine.runMutation("messages:unchecked", { channel: "a", score: "bad" })).rejects.toThrow("score");
  await expect(engine.runMutation("messages:insert", { channel: "a", score: 1, extra: true })).rejects.toThrow("args.extra");
  await expect(engine.runMutation("messages:unchecked", { channel: "a", score: 1, _id: "fake" })).rejects.toThrow("reserved");
  const id = await insert(1);
  await expect(engine.runMutation("messages:patch", { id, value: { score: "bad" } })).rejects.toThrow("score");
  expect((await engine.runQuery("messages:get", { id })).value.score).toBe(1);
});
test("indexed eq/range scans, boundary inclusivity, descending, filters and terminals", async () => {
  for (let i = 0; i < 6; i++) await insert(i);
  await insert(2, "b");
  expect((await range({ channel: "a", lo: 1, hi: 4 })).map((/** @type {any} */ d) => d.score)).toEqual([1, 2, 3]);
  expect((await range({ channel: "a", lo: 1, hi: 4, lowerExclusive: true, upperInclusive: true, order: "desc" })).map((/** @type {any} */ d) => d.score)).toEqual([4, 3, 2]);
  expect((await range({ channel: "a", even: true })).map((/** @type {any} */ d) => d.score)).toEqual([0, 2, 4]);
  expect((await range({ channel: "a", terminal: "take", count: 2 })).map((/** @type {any} */ d) => d.score)).toEqual([0, 1]);
  expect((await range({ channel: "a", order: "desc", terminal: "first" })).score).toBe(5);
  expect((await range({ channel: "b", terminal: "unique" })).score).toBe(2);
  expect(await range({ channel: "none", terminal: "unique" })).toBeNull();
  await expect(range({ channel: "a", terminal: "unique" })).rejects.toThrow("more than one");
  expect((await range({ channel: "a", terminal: "iterate" })).length).toBe(6);
  expect((await engine.runQuery("messages:all")).value.length).toBe(7);
});
test("pagination covers every document once across ascending and descending pages", async () => {
  for (let i = 0; i < 7; i++) await insert(i);
  for (const order of ["asc", "desc"]) {
    let cursor = null, done = false;
    const scores = [];
    while (!done) {
      const result = await range({ channel: "a", order, terminal: "paginate", numItems: 3, cursor });
      scores.push(...result.page.map((/** @type {any} */ d) => d.score)); cursor = result.continueCursor; done = result.isDone;
      expect(scores.length).toBeLessThanOrEqual(7);
    }
    expect(scores).toEqual(order === "asc" ? [0, 1, 2, 3, 4, 5, 6] : [6, 5, 4, 3, 2, 1, 0]);
    await expect(range({ channel: "b", order, terminal: "paginate", numItems: 3, cursor })).rejects.toThrow("Cursor");
  }
});
test("read-set overlap checks old and new docs, missing gets, bounds and unrelated tables", async () => {
  const id = await insert(2);
  const read = await engine.runQuery("messages:range", { channel: "a", lo: 1, hi: 3 });
  const moved = await engine.runMutation("messages:patch", { id, value: { channel: "b", score: 9 } });
  expect(readSetOverlaps(read.readSet, moved.writes)).toBe(true); // oldDoc was in range
  const outside = await engine.runMutation("messages:insert", { channel: "a", score: 3 });
  expect(readSetOverlaps(read.readSet, outside.writes)).toBe(false); // exclusive upper
  const inside = await engine.runMutation("messages:insert", { channel: "a", score: 1 });
  expect(readSetOverlaps(read.readSet, inside.writes)).toBe(true);
  const other = await engine.runMutation("counters:insert");
  expect(readSetOverlaps(read.readSet, other.writes)).toBe(false);
  const getRead = (await engine.runQuery("messages:get", { id })).readSet;
  const deleted = await engine.runMutation("messages:remove", { id });
  expect(readSetOverlaps(getRead, deleted.writes)).toBe(true);
  const missing = await engine.runQuery("messages:get", { id });
  expect(missing.value).toBeNull(); expect(readSetOverlaps(missing.readSet, moved.writes)).toBe(true);
});
test("two concurrent increment streams retry serializably and finish at 40", async () => {
  const id = (await engine.runMutation("counters:insert")).value;
  let attempts = 0;
  const countAttempt = (/** @type {string} */ kind) => { if (kind === "mutation") attempts++; };
  engine.extendCtx.push(countAttempt);
  const stream = async () => { for (let i = 0; i < 20; i++) await engine.runMutation("counters:increment", { id }); };
  try { await Promise.all([stream(), stream()]); } finally { engine.extendCtx.pop(); }
  expect(attempts).toBeGreaterThan(40); // prove real serialization failures were retried
  expect((await engine.runQuery("counters:get", { id })).value.count).toBe(40);
  const [row] = await sql`SELECT count(*)::int AS n FROM commits`; expect(row.n).toBe(41);
});
test("commit clocks, persisted write sets, onCommit and transaction rollback", async () => {
  /** @type {string[]} */ const ts = [];
  const unsubscribe = engine.onCommit((stamp) => ts.push(stamp));
  const first = await engine.runMutation("messages:insert", { channel: "a", score: 1 });
  const second = await engine.runMutation("messages:insert", { channel: "a", score: 2 });
  unsubscribe();
  expect(BigInt(second.ts) > BigInt(first.ts)).toBe(true); expect(ts).toEqual([first.ts, second.ts]);
  const rows = await sql`SELECT ts::text, writes FROM commits ORDER BY ts`;
  expect(rows.map((/** @type {any} */ row) => row.ts)).toEqual(ts);
  expect(rows[0].writes).toEqual(first.writes);
  expect((await engine.runQuery("messages:all")).ts).toBe(second.ts);
  await expect(engine.runMutation("messages:rollback")).rejects.toThrow("rollback");
  expect((await engine.runQuery("messages:all")).value.length).toBe(2);
});
test("query snapshot starts at zero without commits and is read-only; actions call each kind", async () => {
  expect((await engine.runQuery("messages:noWriter")).value).toEqual({ writer: "undefined", scheduler: false });
  expect((await engine.runQuery("messages:all")).ts).toBe("0");
  expect((await engine.runAction("messages:internalFromAction")).value).toBe("internal value");
  expect((await engine.runAction("ai/embed:run")).value).toBe("nested action");
  expect((await engine.runAction("ai/embed:default")).value).toBe("nested action");
  expect((await engine.runAction("ai/embed")).value).toBe("nested action");
  const id = (await engine.runMutation("counters:insert")).value;
  await engine.runAction("counters:bumpFromAction", { id });
  expect((await engine.runQuery("counters:get", { id })).value.count).toBe(1);
  await expect(engine.runQuery("messages:secret")).rejects.toThrow("Function not found");
});
test("repeatable-read query retains its snapshot while another mutation commits", async () => {
  const created = await engine.runMutation("messages:insert", { channel: "a", score: 1 });
  /** @type {()=>void} */ let scanned = () => {};
  /** @type {()=>void} */ let resume = () => {};
  const started = new Promise((resolve) => { scanned = () => resolve(undefined); });
  const released = new Promise((resolve) => { resume = () => resolve(undefined); });
  const extend = (/** @type {string} */ kind, /** @type {any} */ ctx) => {
    if (kind === "query") ctx.checkpoint = () => { scanned(); return released; };
  };
  engine.extendCtx.push(extend);
  try {
    const pending = engine.runQuery("messages:snapshot", { id: created.value });
    await started;
    const changed = await engine.runMutation("messages:patch", { id: created.value, value: { score: 2 } });
    resume();
    const snapshot = await pending;
    expect(snapshot.ts).toBe(created.ts); expect(snapshot.value.before.score).toBe(1); expect(snapshot.value.after.score).toBe(1);
    expect((await engine.runQuery("messages:get", { id: created.value })).ts).toBe(changed.ts);
  } finally { resume(); engine.extendCtx.pop(); }
});
test("failing onWrite hook rolls back document, indexes and commit row", async () => {
  const fail = () => { throw new Error("hook failure"); };
  engine.hooks.onWrite.push(fail);
  try { await expect(insert(1)).rejects.toThrow("hook failure"); } finally { engine.hooks.onWrite.pop(); }
  expect((await engine.runQuery("messages:all")).value).toEqual([]);
  const [row] = await sql`SELECT count(*)::int AS n FROM commits`;
  expect(row.n).toBe(0);
});
test("hooks and context extensions execute with txn handles and load schema", async () => {
  /** @type {any[]} */ const calls = [];
  const onWrite = async (/** @type {import('bun').TransactionSQL} */ tx, /** @type {any} */ write) => {
    const [row] = await tx`SELECT id FROM documents WHERE id = ${write.id}`;
    calls.push(row.id);
  };
  const onSchema = async () => { calls.push("schema"); };
  const onLoad = async () => { calls.push("load"); };
  const extend = (/** @type {string} */ kind, /** @type {any} */ ctx, /** @type {any} */ meta) => {
    expect(Object.getOwnPropertyDescriptor(ctx, ENGINE_INTERNAL)?.enumerable).toBe(false);
    expect(ctx[ENGINE_INTERNAL].sql).toBe(meta.sql);
    ctx.custom = kind;
  };
  engine.hooks.onWrite.push(onWrite); engine.hooks.onSchema.push(onSchema); engine.hooks.onLoad.push(onLoad); engine.extendCtx.push(extend);
  try {
    await engine.load(); const id = await insert(1);
    await engine.runQuery("messages:get", { id }); await engine.runAction("ai/embed:run");
    expect(calls).toEqual(["schema", "load", id]);
  } finally { engine.hooks.onWrite.pop(); engine.hooks.onSchema.pop(); engine.hooks.onLoad.pop(); engine.extendCtx.pop(); }
});
test("adding an index and reloading backfills existing documents; untyped schema policy", async () => {
  const temp = await mkdtemp(join(process.env.TMPDIR ?? import.meta.dir, "rebendei-core-"));
  let local;
  const apiURL = new URL("../src/api.js", import.meta.url).href;
  const module = `import { mutation, query } from ${JSON.stringify(apiURL)};
export const add = mutation({ handler: (ctx,args) => ctx.db.insert('items',args) });
export const list = query({ handler: (ctx) => ctx.db.query('items').withIndex('by_score').collect() });`;
  try {
    await Bun.write(join(temp, "items.js"), module);
    local = await createEngine({ sql, functionsDir: temp });
    await local.runMutation("items:add", { score: 2 }); await local.runMutation("items:add", { score: 1 });
    await Bun.write(join(temp, "schema.js"), `import { defineSchema, defineTable, v } from ${JSON.stringify(apiURL)}; export default defineSchema({ items: defineTable({score:v.number()}).index('by_score',['score']) });`);
    await local.load();
    expect((await local.runQuery("items:list")).value.map((/** @type {any} */ doc) => doc.score)).toEqual([1, 2]);
    await local.runMutation("items:add", { score: 3 });
    expect((await local.runQuery("items:list")).value.length).toBe(3);
    await Bun.write(join(temp, "schema.js"), `import { defineSchema } from ${JSON.stringify(apiURL)}; export default defineSchema({});`);
    await local.load(); await expect(local.runMutation("items:add", { score: 4 })).rejects.toThrow("Unknown schema table");
    await Bun.write(join(temp, "schema.js"), `import { defineSchema } from ${JSON.stringify(apiURL)}; export default defineSchema({}, {schemaValidation:false});`);
    await local.load(); await expect(local.runMutation("items:add", { anyField: true })).resolves.toBeDefined();
  } finally { await local?.close(); await rm(temp, { recursive: true, force: true }); await engine.load(); }
});
test("ENGINE_INTERNAL synthetic reads/writes invalidate and action runInMutation commits", async () => {
  await sql`CREATE TABLE IF NOT EXISTS _rag_test (value text)`; await sql`TRUNCATE _rag_test`;
  /** @type {import('../src/engine/types.js').Write[]} */ let writes = []; let ts = "";
  const unsubscribe = engine.onCommit((stamp, changes) => { ts = stamp; writes = changes; });
  try {
    const read = await engine.runQuery("synthetic:read"); expect(read.value).toEqual({ count: 0, hidden: true });
    expect((await engine.runAction("synthetic:write")).value).toBe("committed");
    expect(readSetOverlaps(read.readSet, writes)).toBe(true);
    expect(readSetOverlaps({ ranges: [{ table: "_rag:other", index: "by_id", fields: [], lower: null, upper: null }] }, writes)).toBe(false);
    const [row] = await sql`SELECT writes FROM commits WHERE ts = ${ts}::bigint`;
    expect(row.writes).toEqual([{ table: "_rag:ns", id: "synthetic", oldDoc: null, newDoc: null }]);
    expect((await engine.runQuery("synthetic:read")).value.count).toBe(1);
    await expect(engine.runQuery("synthetic:forbiddenWrite")).rejects.toThrow("read-only");
  } finally { unsubscribe(); await sql`DROP TABLE _rag_test`; }
});
test("HTTP API 200, 400, 404 shapes, internal visibility, nested naming and errorData", async () => {
  const httpSQL = connect(); const app = startServer({ port: 0, sql: httpSQL, functionsDir });
  const post = async (/** @type {string} */ kind, /** @type {any} */ body) => {
    const res = await fetch(`http://localhost:${app.server.port}/api/${kind}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    const created = await post("mutation", { path: "messages:insert", args: { channel: "http", score: 1 } });
    expect(created.status).toBe(200); expect(created.body.status).toBe("success"); expect(created.body.ts).toBeString();
    const queried = await post("query", { path: "messages:get", args: { id: created.body.value } });
    expect(queried.status).toBe(200); expect(queried.body.value.channel).toBe("http"); expect(queried.body.ts).toBe(created.body.ts);
    expect(await post("action", { path: "ai/embed:run", args: {} })).toEqual({ status: 200, body: { status: "success", value: "nested action" } });
    expect(await post("action", { path: "messages:nullArgs", args: null })).toEqual({ status: 200, body: { status: "success", value: null } });
    expect(await post("action", { path: "messages:internalFromAction", args: {} })).toEqual({ status: 200, body: { status: "success", value: "internal value" } });
    for (const path of ["messages:secret", "missing:function", "messages:insert"]) {
      const result = await post("query", { path, args: {} }); expect(result.status).toBe(404); expect(result.body.status).toBe("error"); expect(result.body.errorMessage).toBeString();
    }
    const invalid = await post("mutation", { path: "messages:insert", args: { channel: 1 } });
    expect(invalid.status).toBe(400); expect(invalid.body.status).toBe("error"); expect(invalid.body.errorMessage).toContain("args.channel");
    expect((await post("mutation", { path: "messages:fail", args: {} })).body.errorData).toEqual({ code: "USER_FAILURE" });
    expect((await post("query", { args: {} })).status).toBe(400);
    const malformed = await fetch(`http://localhost:${app.server.port}/api/query`, { method: "POST", body: "{" }); expect(malformed.status).toBe(400);
  } finally { await app.stop(); }
});
test("CLI dev/start load functions from the cwd rebendei folder", async () => {
  const temp = await mkdtemp(join(process.env.TMPDIR ?? import.meta.dir, "rebendei-cli-"));
  const apiURL = new URL("../src/api.js", import.meta.url).href;
  try {
    await mkdir(join(temp, "rebendei"));
    await Bun.write(join(temp, "rebendei", "example.js"), `import { query } from ${JSON.stringify(apiURL)}; export const hello = query({handler:()=> 'cwd functions loaded'});`);
    for (const command of ["dev", "start"]) {
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "bin", "rebendei.js"), command], {
        cwd: temp, env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, PORT: "0" }, stdout: "pipe", stderr: "pipe",
      });
      try {
        const reader = proc.stdout.getReader(); let output = "", port;
        while (port === undefined) {
          const { value, done } = await reader.read();
          if (done) throw new Error(`CLI exited: ${output} ${await new Response(proc.stderr).text()}`);
          output += new TextDecoder().decode(value);
          const match = output.match(/listening on http:\/\/localhost:(\d+)/);
          if (match) port = Number(match[1]);
        }
        const res = await fetch(`http://localhost:${port}/api/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "example:hello", args: {} }) });
        expect(res.status).toBe(200); expect((await res.json()).value).toBe("cwd functions loaded");
      } finally { proc.kill("SIGTERM"); await proc.exited; }
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
test("encodeKey ordering matches independent comparison and real Postgres bytea ORDER BY", async () => {
  let seed = 19307;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const strings = ["", "a", "a\0", "a\0b", "é", "中", "😀", "\uffff", "\0", "aa"];
  /** @param {number} depth @returns {any} */
  function value(depth) {
    const type = Math.floor(random() * (depth ? 7 : 5));
    if (type === 0) return undefined; if (type === 1) return null;
    if (type === 2) return (random() - 0.5) * 10 ** Math.floor(random() * 100);
    if (type === 3) return random() < 0.5;
    if (type === 4) return strings[Math.floor(random() * strings.length)];
    if (type === 5) return Array.from({ length: Math.floor(random() * 4) }, () => value(depth - 1));
    return Object.fromEntries(Array.from({ length: Math.floor(random() * 4) }, () => [strings[Math.floor(random() * strings.length)], value(depth - 1)]));
  }
  /** @type {any[][]} */ const keys = [[undefined], [null], [-Number.MAX_VALUE], [-Number.MIN_VALUE], [-0], [0], [Number.MIN_VALUE], [Number.MAX_VALUE], [false], [true], [""], [[]], [{}]];
  for (let i = 0; i < 300; i++) keys.push(Array.from({ length: 1 + Math.floor(random() * 3) }, () => value(2)));
  const expected = keys.map((key, id) => ({ key, id })).sort((a, b) => compareKeys(a.key, b.key) || a.id - b.id).map((row) => row.id);
  const binary = keys.map((key, id) => ({ key: encodeKey(key), id })).sort((a, b) => Buffer.compare(a.key, b.key) || a.id - b.id).map((row) => row.id);
  expect(binary).toEqual(expected);
  await sql.begin(async (tx) => {
    await tx`CREATE TEMP TABLE key_order_test (id int, key bytea) ON COMMIT DROP`;
    for (const [id, key] of keys.entries()) await tx`INSERT INTO key_order_test VALUES (${id}, ${encodeKey(key)})`;
    const rows = await tx`SELECT id FROM key_order_test ORDER BY key, id`;
    expect(rows.map((/** @type {any} */ row) => row.id)).toEqual(expected);
  });
});


test("M3 bounded terminals limit real SQL rows and skip take(0)", async () => {
  for (let i = 0; i < 256; i++) await insert(i);
  const { Query } = await import("../src/engine/query.js");
  const { default: schema } = await import("./fixtures/schema.js");
  await sql.begin(async (tx) => {
    let scanned = 0;
    /** @type {number[]} */ const batches = [];
    const measured = new Proxy(tx, { get(target, property) {
      if (property === "unsafe") return async (/** @type {string} */ query, /** @type {any[]} */ params) => {
        const rows = await target.unsafe(query, params);
        if (query.includes("FROM index_entries e")) { scanned += rows.length; batches.push(rows.length); }
        return rows;
      };
      return Reflect.get(target, property);
    } });
    const q = () => new Query(measured, schema, "messages", () => {}).withIndex("by_channel_score", r => r.eq("channel", "a"));
    expect(await q().take(0)).toEqual([]); expect(scanned).toBe(0);
    expect((await q().take(1))[0].score).toBe(0); expect(scanned).toBe(1);
    scanned = 0; expect((await q().first())?.score).toBe(0); expect(scanned).toBe(1);
    scanned = 0; await expect(q().unique()).rejects.toThrow("more than one"); expect(scanned).toBe(2);
    scanned = 0; const page = await q().paginate({ numItems: 1 });
    expect(page.page[0].score).toBe(0); expect(page.isDone).toBe(false); expect(scanned).toBe(2);
    scanned = 0; batches.length = 0; let evaluated = 0;
    const filtered = await q().filter(doc => { evaluated++; return doc.score >= 70; }).take(1);
    expect(filtered[0].score).toBe(70); expect(evaluated).toBe(71);
    expect(scanned).toBeLessThan(256); expect(Math.max(...batches)).toBeLessThanOrEqual(1024);
    await expect(q().take(8193)).rejects.toThrow("8192");
    await expect(q().paginate({ numItems: 8193 })).rejects.toThrow("8192");
  });
});

test("M3 narrowed terminal ranges invalidate inside but not just beyond scanned keys", async () => {
  const ids = []; for (let i = 0; i < 8; i++) ids.push(await insert(i));
  for (const order of ["asc", "desc"]) {
    for (const terminal of ["take", "first", "paginate"]) {
      const read = await engine.runQuery("messages:range", { channel: "a", terminal, order, count: 1, numItems: 1 });
      const last = terminal === "paginate" ? 1 : 0;
      const beyond = order === "asc" ? last + 1 : 6 - last;
      const outside = await engine.runMutation("messages:patch", { id: ids[beyond], value: { body: "outside" } });
      expect(readSetOverlaps(read.readSet, outside.writes)).toBe(false);
      const inside = await engine.runMutation("messages:patch", { id: ids[order === "asc" ? 0 : 7], value: { body: "inside" } });
      expect(readSetOverlaps(read.readSet, inside.writes)).toBe(true);
    }
    const filtered = await engine.runQuery("messages:range", { channel: "a", terminal: "take", count: 1, order, even: true });
    const flip = await engine.runMutation("messages:patch", { id: ids[order === "asc" ? 0 : 7], value: { score: order === "asc" ? -2 : 8 } });
    expect(readSetOverlaps(filtered.readSet, flip.writes)).toBe(true);
    // Restore ordering for subsequent checks.
    await engine.runMutation("messages:patch", { id: ids[order === "asc" ? 0 : 7], value: { score: order === "asc" ? 0 : 7 } });
  }
  const exhausted = await engine.runQuery("messages:range", { channel: "a", terminal: "take", count: 20, even: true });
  const added = await engine.runMutation("messages:insert", { channel: "a", score: 100 });
  expect(readSetOverlaps(exhausted.readSet, added.writes)).toBe(true);
});


test("M3 filtered batches and streaming iteration keep conservative finite scanned ranges", async () => {
  const ids = []; for (let i = 0; i < 256; i++) ids.push(await insert(i));
  for (const order of ["asc", "desc"]) {
    const read = await engine.runQuery("messages:range", { channel: "a", terminal: "take", count: 1, order, even: true });
    const insideIndex = order === "asc" ? 1 : 255;
    const outsideIndex = order === "asc" ? 64 : 191;
    const outside = await engine.runMutation("messages:patch", { id: ids[outsideIndex], value: { body: "outside batch" } });
    expect(readSetOverlaps(read.readSet, outside.writes)).toBe(false);
    const flip = await engine.runMutation("messages:patch", { id: ids[insideIndex], value: { score: order === "asc" ? -2 : 256 } });
    expect(readSetOverlaps(read.readSet, flip.writes)).toBe(true);
    await engine.runMutation("messages:patch", { id: ids[insideIndex], value: { score: insideIndex } });
  }
  const { Query } = await import("../src/engine/query.js");
  const { default: schema } = await import("./fixtures/schema.js");
  await sql.begin(async tx => {
    let scanned = 0;
    /** @type {import('../src/engine/types.js').Range[]} */ const ranges = [];
    const measured = new Proxy(tx, { get(target, property) {
      if (property === "unsafe") return async (/** @type {string} */ text, /** @type {any[]} */ params) => {
        const rows = await target.unsafe(text, params); scanned += rows.length; return rows;
      };
      return Reflect.get(target, property);
    } });
    const q = new Query(measured, schema, "messages", range => ranges.push(range)).withIndex("by_channel_score", r => r.eq("channel", "a"));
    for await (const doc of q) { expect(doc.score).toBe(0); break; }
    expect(scanned).toBe(64);
    expect(ranges[0].upper?.key[1]).toBe(63);
  });
});

test("M3 pagination excludes previous pages, including deleted cursor rows and missing index fields", async () => {
  for (const order of ["asc", "desc"]) {
    const ids = []; for (let i = 0; i < 8; i++) ids.push(await insert(i, order));
    const args = { channel: order, terminal: "paginate", order, numItems: 2, even: true };
    const first = await engine.runQuery("messages:range", args);
    const second = await engine.runQuery("messages:range", { ...args, cursor: first.value.continueCursor });
    expect(second.value.page.map((/** @type {any} */ doc) => doc.score)).toEqual(order === "asc" ? [4, 6] : [2, 0]);
    expect(second.value.isDone).toBe(true);
    const earlier = await engine.runMutation("messages:patch", { id: ids[order === "asc" ? 0 : 7], value: { body: "previous page" } });
    expect(readSetOverlaps(second.readSet, earlier.writes)).toBe(false);
    // Deleting the last document from page one must not destroy the cursor's key.
    const cursorId = first.value.page.at(-1)._id;
    const removed = await engine.runMutation("messages:remove", { id: cursorId });
    expect(readSetOverlaps(second.readSet, removed.writes)).toBe(false);
    expect((await engine.runQuery("messages:range", { ...args, cursor: first.value.continueCursor })).value.page).toEqual(second.value.page);
    // Each direction has its own channel, independent of the deleted cursor row.
  }
  const { Query } = await import("../src/engine/query.js");
  const { default: schema } = await import("./fixtures/schema.js");
  const missingIds = [await insert(1, "missing"), await insert(2, "missing")];
  const { writeIndexes } = await import("../src/engine/indexes.js");
  const missingSchema = { ...schema, tables: { messages: { ...schema.tables.messages,
    indexes: [...schema.tables.messages.indexes, { name: "by_missing", fields: ["optionalField"] }] } } };
  const missingDocs = await Promise.all(missingIds.map(async id => (await engine.runQuery("messages:get", { id })).value));
  await sql.begin(async tx => {
    for (const doc of missingDocs) await writeIndexes(tx, missingSchema, "messages", doc);
    const q = () => new Query(tx, missingSchema, "messages", () => {}).withIndex("by_missing", r => r.eq("optionalField", undefined));
    const first = await q().paginate({ numItems: 1 });
    const second = await q().paginate({ numItems: 1, cursor: first.continueCursor });
    expect(second.page).toHaveLength(1); expect(second.isDone).toBe(true);
    expect(second.page[0]._id).not.toBe(first.page[0]._id);
    const legacy = JSON.parse(Buffer.from(first.continueCursor, "base64url").toString()); delete legacy.values;
    expect((await q().paginate({ numItems: 1, cursor: Buffer.from(JSON.stringify(legacy)).toString("base64url") })).page).toEqual(second.page);
  });
});
