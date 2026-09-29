import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { SQL } from "bun";
import { join } from "node:path";
import { connect } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { startServer } from "../src/server.js";
import { mutationTransaction } from "../src/engine/transactions.js";
import { clientWithFrames, waitFor } from "./sync-fixtures/helpers.js";
const functionsDir = join(import.meta.dir, "sync-fixtures", "functions");
/** @type {ReturnType<typeof startServer>[]} */ let apps = [];
/** @type {ReturnType<typeof clientWithFrames>[]} */ let clients = [];
/** @type {WebSocket[]} */ let sockets = [];
beforeAll(async () => { const sql = connect(); try { await migrate(sql); } finally { await sql.close(); } });
beforeEach(async () => { const sql = connect(); try { await sql`TRUNCATE documents, index_entries, commits`; } finally { await sql.close(); } });
afterEach(async () => {
  for (const socket of sockets) socket.close(); sockets = [];
  await Promise.all(clients.map(({ client }) => client.close())); clients = [];
  await Promise.all(apps.map(app => app.stop())); apps = [];
});
/** @param {Parameters<typeof startServer>[0]} [options] */
function app(options = {}) { const result = startServer({ port: 0, sql: connect(), functionsDir, ...options }); apps.push(result); return result; }
/** @param {ReturnType<typeof startServer>} server */
function client(server) { const result = clientWithFrames(`http://localhost:${server.server.port}`); clients.push(result); return result; }
/** @param {ReturnType<typeof startServer>} server */
async function socket(server) {
  const ws = new WebSocket(`ws://localhost:${server.server.port}/sync`); sockets.push(ws);
  /** @type {any[]} */ const frames = [];
  let closed = false;
  ws.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
  ws.addEventListener("close", () => { closed = true; });
  await new Promise(resolve => ws.addEventListener("open", resolve, { once: true }));
  return { ws, frames, isClosed: () => closed };
}

test("H1: shared batch snapshot resolves subscribers and mutation ack during unrelated churn with pool max 1", async () => {
  const base = connect(), sql = new SQL({ ...base.options, max: 1 }); await base.close();
  const server = app({ sql }), c = client(server);
  const engine = await server.getEngine(); await /** @type {any} */ (engine).scheduler.stop();
  const id = await c.client.mutation("items:insert", { group: "a", score: 1, value: 0 });
  const watches = [0, 1].map(label => {
    const watch = c.client.watchQuery("items:slowGet", { id, label }); watch.onUpdate(() => {}); return watch;
  });
  await waitFor(() => watches.every(w => /** @type {any} */ (w.localQueryResult())?.value === 0));
  const other = connect(); let churn = true, commits = 0, resolved = false;
  const loop = (async () => { while (churn) { await mutationTransaction(other, async () => ({ value: null, writes: [] })); commits++; await Bun.sleep(5); } })();
  const request = c.client.mutation("items:set", { id, value: 1 }).then(() => { resolved = true; });
  try {
    await waitFor(() => resolved && watches.every(w => /** @type {any} */ (w.localQueryResult())?.value === 1), 2000);
    expect(churn).toBe(true); expect(commits).toBeGreaterThan(0);
    const ack = c.frames.findLastIndex(f => f.type === "mutationResult");
    const ackTs = BigInt(c.frames[ack].ts);
    expect(c.frames.slice(0, ack).some(f => f.type === "transition" && BigInt(f.ts) >= ackTs &&
      f.modifications.length === 2 && f.modifications.every((/** @type {any} */ m) => m.value.value === 1))).toBe(true);
  } finally { churn = false; await loop; await request; await other.close(); }
});

test("H2: flooded pending bytes send fatal and close only the abusive connection", async () => {
  const server = app(), healthy = client(server), bad = await socket(server);
  bad.ws.send(JSON.stringify({ type: "action", requestId: 0, path: "items:hold", args: {} }));
  for (let n = 1; n <= 64; n++) bad.ws.send(JSON.stringify({ type: "action", requestId: n, path: "items:echo", args: { text: "x".repeat(512 * 1024) } }));
  await waitFor(bad.isClosed, 2000);
  expect(bad.frames.filter(f => f.type === "fatal")).toHaveLength(1);
  expect(bad.frames.find(f => f.type === "fatal").errorMessage).toContain("pending");
  expect(await healthy.client.query("items:constant")).toEqual({ z: 1, a: { b: 2 } });
  expect((await fetch(`http://localhost:${server.server.port}/health`)).status).toBe(200);
});

test("H2: configured frame-count cap includes in-flight work, even for tiny frames", async () => {
  const server = app({ wsMaxPending: 4 }), bad = await socket(server);
  bad.ws.send(JSON.stringify({ type: "action", requestId: 0, path: "items:hold" }));
  for (let n = 1; n <= 4; n++) bad.ws.send(JSON.stringify({ type: "action", requestId: n, path: "items:echo" }));
  await waitFor(bad.isClosed, 1000);
  expect(bad.frames.filter(f => f.type === "fatal")).toHaveLength(1);
  expect(bad.frames.some(f => f.type === "actionResult")).toBe(false);
  expect(await client(server).client.action("items:echo", { ok: true })).toEqual({ ok: true });
});

test("H2: processed frames release count and UTF-8 byte budgets", async () => {
  const args = { text: "😀".repeat(64) };
  const frame = { type: "action", requestId: 0, path: "items:echo", args };
  const server = app({ wsMaxPending: 1, wsMaxPendingBytes: Buffer.byteLength(JSON.stringify(frame)) }), c = await socket(server);
  for (let n = 0; n < 5; n++) {
    c.ws.send(JSON.stringify({ ...frame, requestId: n }));
    await waitFor(() => c.frames.some(f => f.type === "actionResult" && f.requestId === n));
  }
  expect(c.isClosed()).toBe(false);
  expect(c.frames.some(f => f.type === "fatal")).toBe(false);
});

test("H2: subscription cap permits replacement and unsubscribe, then closes on excess", async () => {
  const server = app({ wsMaxSubscriptions: 1 }), c = await socket(server);
  /** @param {number} id */
  const subscribe = id => c.ws.send(JSON.stringify({ type: "subscribe", queryId: id, path: "items:constant" }));
  subscribe(1); await waitFor(() => c.frames.filter(f => f.type === "transition").length === 1);
  subscribe(1); await waitFor(() => c.frames.filter(f => f.type === "transition").length === 2);
  c.ws.send(JSON.stringify({ type: "unsubscribe", queryId: 1 }));
  subscribe(2); await waitFor(() => c.frames.filter(f => f.type === "transition").length === 3);
  expect(c.isClosed()).toBe(false);
  subscribe(3); await waitFor(c.isClosed);
  expect(c.frames.find(f => f.type === "fatal").errorMessage).toContain("subscriptions");
  expect(await client(server).client.action("items:echo", { ok: true })).toEqual({ ok: true });
});

test("H2: Bun rejects an individual frame above the configured payload size", async () => {
  const server = app({ wsMaxFrameSize: 128 }), c = await socket(server);
  c.ws.send(JSON.stringify({ type: "action", requestId: 0, path: "items:echo", args: { text: "x".repeat(256) } }));
  await waitFor(c.isClosed);
  expect(c.frames.some(f => f.type === "actionResult")).toBe(false);
  expect(await client(server).client.action("items:echo", {})).toEqual({});
});

test("H2: limits read env, options override env, invalid limits fail before starting server", async () => {
  const { syncLimits } = await import("../src/sync/limits.js");
  const names = ["REBENDEI_WS_MAX_PENDING", "REBENDEI_WS_MAX_PENDING_BYTES", "REBENDEI_WS_MAX_SUBSCRIPTIONS", "REBENDEI_WS_MAX_FRAME_SIZE"];
  const previous = names.map(name => process.env[name]);
  try {
    for (const [n, name] of names.entries()) process.env[name] = String(n + 2);
    expect(syncLimits()).toEqual({ pending: 2, pendingBytes: 3, subscriptions: 4, frameSize: 5 });
    expect(syncLimits({ wsMaxPending: 6, wsMaxPendingBytes: 7, wsMaxSubscriptions: 8, wsMaxFrameSize: 9 }))
      .toEqual({ pending: 6, pendingBytes: 7, subscriptions: 8, frameSize: 9 });
    process.env.REBENDEI_WS_MAX_PENDING = "bad";
    expect(() => startServer({ port: 0 })).toThrow("positive safe integer");
    expect(() => syncLimits({ wsMaxPending: 0 })).toThrow("positive safe integer");
  } finally { for (const [n, name] of names.entries()) { if (previous[n] === undefined) delete process.env[name]; else process.env[name] = previous[n]; } }
});
