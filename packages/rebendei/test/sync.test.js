import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { connect } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { startServer } from "../src/server.js";
import { RebendeiError } from "../src/client/index.js";
import { clientWithFrames, waitFor } from "./sync-fixtures/helpers.js";
const functionsDir = join(import.meta.dir, "sync-fixtures", "functions");
/** @type {ReturnType<typeof startServer>[]} */ let apps = [];
/** @type {ReturnType<typeof clientWithFrames>[]} */ let clients = [];
beforeAll(async () => { const sql = connect(); try { await migrate(sql); } finally { await sql.close(); } });
beforeEach(async () => { const sql = connect(); try { await sql`TRUNCATE documents, index_entries, commits`; } finally { await sql.close(); } });
afterEach(async () => { await Promise.all(clients.map(({ client }) => client.close())); clients = []; await Promise.all(apps.map(app => app.stop())); apps = []; });
function app() { const result = startServer({ port: 0, sql: connect(), functionsDir }); apps.push(result); return result; }
/** @param {ReturnType<typeof startServer>} server */
function client(server) { const result = clientWithFrames(`http://localhost:${server.server.port}`); clients.push(result); return result; }
/** @param {import('../src/client/index.js').RebendeiClient} writer @param {string} [group] @param {number} [score] @param {number} [value] */
async function insert(writer, group = "a", score = 1, value = 0) {
  return /** @type {string} */ (await writer.mutation("items:insert", { group, score, value }));
}
/** @param {any[]} frames @param {number} queryId */
const updates = (frames, queryId) => frames.filter(frame => frame.type === "transition").flatMap(frame => frame.modifications).filter(mod => mod.queryId === queryId);

test("real client: other-client updates and read-your-writes before mutation resolves", async () => {
  const server = app(), a = client(server), b = client(server);
  const id = await insert(a.client);
  const watch = b.client.watchQuery("items:get", { id }); const stop = watch.onUpdate(() => {});
  await waitFor(() => watch.localQueryResult() === 0);
  await a.client.mutation("items:set", { id, value: 1 });
  await waitFor(() => watch.localQueryResult() === 1);
  await b.client.mutation("items:set", { id, value: 2 });
  expect(watch.localQueryResult()).toBe(2);
  const response = b.frames.findLastIndex(frame => frame.type === "mutationResult");
  expect(b.frames.slice(0, response).some(frame => frame.type === "transition" && frame.modifications.some((/** @type {any} */ mod) => mod.value === 2))).toBe(true);
  stop();
});
test("unaffected and unchanged subscriptions are not re-sent; outside index writes do not re-run", async () => {
  const server = app(), writer = client(server), reader = client(server);
  const engine = await server.getEngine();
  const counts = new Map();
  engine.extendCtx.push((kind, _ctx, meta) => { if (kind === "query") counts.set(meta.path, (counts.get(meta.path) ?? 0) + 1); });
  const rangeArgs = { group: "a", lo: 10, hi: 20 };
  reader.client.onUpdate("items:range", rangeArgs, () => {});
  reader.client.onUpdate("items:constant", {}, () => {});
  await waitFor(() => reader.frames.filter(f => f.type === "transition").length === 2);
  const rangeId = reader.frames.find(f => f.type === "transition").modifications[0].queryId;
  const constantId = reader.frames.filter(f => f.type === "transition")[1].modifications[0].queryId;
  await insert(writer.client, "a", 20); await insert(writer.client, "b", 15); await insert(writer.client, "a", 9);
  await Bun.sleep(150);
  expect(counts.get("items:range")).toBe(1);
  expect(updates(reader.frames, rangeId)).toHaveLength(1);
  expect(updates(reader.frames, constantId)).toHaveLength(1);
  await insert(writer.client, "a", 10);
  await waitFor(() => updates(reader.frames, rangeId).length === 2);
  expect(counts.get("items:range")).toBe(2);
  expect(updates(reader.frames, constantId)).toHaveLength(1);
});
test("separate server instances/engines propagate committed writes via dedicated Postgres feed", async () => {
  const serverA = app(), serverB = app(), a = client(serverA), b = client(serverB);
  const id = await insert(a.client);
  expect(await serverA.getEngine()).not.toBe(await serverB.getEngine());
  const watch = b.client.watchQuery("items:get", { id }); watch.onUpdate(() => {});
  await waitFor(() => watch.localQueryResult() === 0);
  await a.client.mutation("items:set", { id, value: 99 });
  await waitFor(() => watch.localQueryResult() === 99);
  expect(b.frames.some(f => f.type === "transition" && f.modifications.some((/** @type {any} */ m) => m.value === 99))).toBe(true);
});
test("throwing/unknown/internal queries send error modifications, errorData survives, throwing read recovers", async () => {
  const c = client(app());
  await expect(c.client.query("items:fail")).rejects.toBeInstanceOf(RebendeiError);
  for (const path of ["missing:query", "items:secret"]) await expect(c.client.query(path)).rejects.toThrow("Function not found");
  expect(c.frames.filter(f => f.type === "transition").flatMap(f => f.modifications).filter(m => m.type === "error")).toHaveLength(3);
  expect(c.frames.find(f => f.type === "transition").modifications[0].errorData).toEqual({ code: "QUERY_FAILED" });
  const id = await insert(c.client);
  /** @type {unknown} */ let value;
  /** @type {Error|undefined} */ let error;
  c.client.onUpdate("items:recover", { id }, next => { value = next; }, next => { error = next; });
  await waitFor(() => !!error);
  await c.client.mutation("items:set", { id, value: 7 });
  expect(value).toBe(7);
});
test("WS actions and failed mutations retain errorData; empty transitions release unwatched/noop mutations", async () => {
  const c = client(app());
  expect(await c.client.mutation("items:noop")).toBeNull();
  expect(await c.client.action("items:echo", { answer: 42 })).toEqual({ answer: 42 });
  for (const [kind, path, code] of [["mutation", "items:failMutation", "MUTATION_FAILED"], ["action", "items:failAction", "ACTION_FAILED"]]) {
    try {
      if (kind === "mutation") await c.client.mutation(path); else await c.client.action(path);
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(RebendeiError);
      expect(/** @type {RebendeiError} */ (error).data).toEqual({ code });
    }
  }
});
test("unsubscribe frees server state and stops transition updates", async () => {
  const server = app(), a = client(server), b = client(server);
  const id = await insert(a.client);
  const stop = b.client.onUpdate("items:get", { id }, () => {});
  await waitFor(() => b.frames.some(f => f.type === "transition"));
  const queryId = b.frames.find(f => f.type === "transition").modifications[0].queryId;
  stop(); await Bun.sleep(50);
  await a.client.mutation("items:set", { id, value: 3 }); await Bun.sleep(150);
  expect(updates(b.frames, queryId)).toHaveLength(1);
});
test("50 rapid mutations converge to final value with monotonically increasing transition timestamps", async () => {
  const a = client(app()), b = client(app());
  const id = await insert(a.client);
  const watch = b.client.watchQuery("items:get", { id }); watch.onUpdate(() => {});
  await waitFor(() => watch.localQueryResult() === 0);
  const pending = Array.from({ length: 50 }, (_, n) => a.client.mutation("items:set", { id, value: n + 1 }));
  await Promise.all(pending);
  await waitFor(() => watch.localQueryResult() === 50);
  let previous = 0n;
  for (const f of b.frames.filter(f => f.type === "transition")) { expect(BigInt(f.ts) >= previous).toBe(true); previous = BigInt(f.ts); }
});
test("one batch keeps a shared snapshot; commits during evaluation invalidate the next batch", async () => {
  const writerServer = app(), readerServer = app(), writer = client(writerServer), reader = client(readerServer);
  const idA = await insert(writer.client), idB = await insert(writer.client);
  const first = reader.client.watchQuery("items:get", { id: idA }); first.onUpdate(() => {});
  const second = reader.client.watchQuery("items:getAgain", { id: idA }); second.onUpdate(() => {});
  const third = reader.client.watchQuery("items:get", { id: idB }); third.onUpdate(() => {});
  await waitFor(() => first.localQueryResult() === 0 && second.localQueryResult() === 0 && third.localQueryResult() === 0);
  const engine = await readerServer.getEngine();
  let paused = false, earlyFinished = false, armed = true;
  /** @type {()=>void} */ let release = () => {};
  const barrier = new Promise(resolve => { release = () => resolve(undefined); });
  const pauseRead = (/** @type {string} */ kind, /** @type {any} */ ctx, /** @type {any} */ meta) => {
    if (kind !== "query") return;
    const get = ctx.db.get;
    ctx.db.get = async (/** @type {string} */ id) => {
      if (armed && meta.path === "items:getAgain") { armed = false; paused = true; await barrier; }
      const result = await get(id);
      if (meta.path === "items:get" && id === idA) earlyFinished = true;
      return result;
    };
  };
  engine.extendCtx.push(pauseRead);
  const before = reader.frames.length;
  try {
    await writer.client.mutation("items:set", { id: idA, value: 1 });
    await waitFor(() => paused && earlyFinished);
    await writer.client.mutation("items:setBoth", { a: idA, b: idB, value: 2 });
    release();
    await waitFor(() => first.localQueryResult() === 2 && second.localQueryResult() === 2 && third.localQueryResult() === 2);
    const transitions = reader.frames.slice(before).filter(f => f.type === "transition");
    expect(transitions).toHaveLength(2);
    expect(transitions[0].modifications.map((/** @type {any} */ m) => m.value)).toEqual([1, 1]);
    expect(transitions[1].modifications.map((/** @type {any} */ m) => m.value)).toEqual([2, 2, 2]);
    expect(BigInt(transitions[1].ts)).toBeGreaterThan(BigInt(transitions[0].ts));
  } finally { release(); engine.extendCtx.splice(engine.extendCtx.indexOf(pauseRead), 1); }
});

test("invalid JSON sends fatal then closes, without affecting other clients", async () => {
  const server = app();
  const socket = new WebSocket(`ws://localhost:${server.server.port}/sync`);
  /** @type {any[]} */ const frames = [];
  let closed = false;
  socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
  socket.addEventListener("close", () => { closed = true; });
  await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
  socket.send("{");
  await waitFor(() => closed);
  expect(frames[0]).toEqual({ type: "hello", server: "rebendei", version: "0.1.0" });
  expect(frames[1].type).toBe("fatal");
  expect(await client(server).client.query("items:constant")).toEqual({ z: 1, a: { b: 2 } });
});
