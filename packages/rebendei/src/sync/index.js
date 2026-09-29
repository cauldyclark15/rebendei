import { RebendeiError } from "../api.js";
import { queryTransaction } from "../engine/transactions.js";
import { createSnapshotQueries } from "./snapshot.js";
import { syncLimits } from "./limits.js";
import { readSetOverlaps } from "../engine/read-set.js";
import { isPlainObject } from "../values/index.js";
import { createCommitFeed } from "./commits.js";

/** @typedef {Awaited<ReturnType<typeof import('../engine/index.js').createEngine>>} Engine
 * @typedef {import('../engine/types.js').ReadSet} ReadSet
 * @typedef {{path:string,args:any,readSet:ReadSet,lastValueJSON?:string,ts:string,initial:boolean}} Subscription
 * @typedef {{socket:import('bun').ServerWebSocket<unknown>,subscriptions:Map<number,Subscription>,ts:string,cursor:string,closed:boolean,queued:boolean,tail:Promise<void>,pending:number,pendingBytes:number}} Connection
 */

/** @param {any} value @returns {string} */
export function canonicalJSON(value) {
  return JSON.stringify(value, (_key, child) => isPlainObject(child)
    ? Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])) : child);
}
/** @param {unknown} error */
function wireError(error) {
  return { errorMessage: error instanceof Error ? error.message : String(error),
    ...(error instanceof RebendeiError ? { errorData: error.data } : {}) };
}
/** @param {string} a @param {string} b */
const maxTs = (a, b) => BigInt(a) > BigInt(b) ? a : b;

/** One service per startServer; subscriptions and queues are connection-local.
 * @param {Engine} engine
 * @param {ReturnType<typeof syncLimits>} [limits]
 */
export async function createSync(engine, limits = syncLimits()) {
  /** @type {Map<import('bun').ServerWebSocket<unknown>,Connection>} */ const connections = new Map();
  const queries = await createSnapshotQueries(engine);

  /** @param {Connection} connection @param {object} frame */
  function send(connection, frame) {
    if (!connection.closed) connection.socket.send(JSON.stringify(frame));
  }
  /** @param {Connection} connection @param {unknown} error */
  function fatal(connection, error) {
    if (connection.closed) return;
    send(connection, { type: "fatal", ...wireError(error) });
    connection.closed = true;
    connection.subscriptions.clear();
    connections.delete(connection.socket);
    connection.socket.close(1008, "Invalid sync frame");
  }
  /** @param {Connection} connection @param {()=>Promise<void>} work @param {number} [bytes] */
  function enqueue(connection, work, bytes) {
    if (bytes !== undefined) { connection.pending++; connection.pendingBytes += bytes; }
    connection.tail = connection.tail.then(async () => { if (!connection.closed) await work(); })
      .catch(error => fatal(connection, error))
      .finally(() => { if (bytes !== undefined) { connection.pending--; connection.pendingBytes -= bytes; } });
  }
  /** @param {import('bun').TransactionSQL} tx @param {Subscription} sub @param {number} queryId */
  async function evaluate(tx, sub, queryId) {
    /** @type {ReadSet} */ const readSet = { ranges: [] };
    try {
      const value = await queries.run(tx, sub.path, sub.args, readSet);
      return { sub, readSet, modification: { type: "updated", queryId, value } };
    } catch (error) {
      return { sub, readSet, modification: { type: "error", queryId, ...wireError(error) } };
    }
  }
  /** @param {Connection} connection @param {string} [minimum] */
  async function synchronize(connection, minimum = "0") {
    if (connection.closed) return;
    // Commit discovery and every affected query share ONE snapshot and connection.
    // Commits arriving during evaluation remain beyond cursor for the next pass;
    // unrelated churn cannot force this batch to restart or delay a mutation ack.
    const batch = await queryTransaction(engine.sql, async tx => {
      let cursor = connection.cursor;
      /** @type {Set<number>} */ const affected = new Set();
      for (const [id, sub] of connection.subscriptions) if (sub.initial) affected.add(id);
      const rows = await tx`SELECT ts::text AS ts, writes FROM commits WHERE ts > ${cursor}::bigint ORDER BY ts`;
      for (const row of rows) {
        cursor = String(row.ts);
        for (const [id, sub] of connection.subscriptions) {
          if (BigInt(row.ts) > BigInt(sub.ts) && readSetOverlaps(sub.readSet, row.writes)) affected.add(id);
        }
      }
      // Sequential queries also work with pool max:1 and allow isolated savepoints.
      const results = [];
      for (const id of affected) {
        if (connection.closed) break;
        const sub = connection.subscriptions.get(id);
        if (sub) results.push(await evaluate(tx, sub, id));
      }
      return { results, cursor };
    });
    const { results, cursor, ts: snapshot } = batch;
    if (BigInt(snapshot) < BigInt(maxTs(connection.ts, minimum))) throw new Error("Sync snapshot precedes committed mutation");
    if (connection.closed) return;
    /** @type {object[]} */ const modifications = [];
    for (const result of results) {
      const id = result.modification.queryId;
      if (connection.subscriptions.get(id) !== result.sub) continue;
      const json = canonicalJSON(result.modification);
      if (result.sub.initial || json !== result.sub.lastValueJSON) modifications.push(result.modification);
      Object.assign(result.sub, { initial: false, lastValueJSON: json, readSet: result.readSet, ts: snapshot });
    }
    connection.cursor = cursor;
    if (modifications.length || BigInt(connection.ts) < BigInt(minimum)) {
      connection.ts = snapshot;
      send(connection, { type: "transition", ts: snapshot, modifications });
    }
  }
  /** @param {Connection} connection */
  function schedule(connection) {
    if (connection.queued || connection.closed) return;
    connection.queued = true;
    enqueue(connection, async () => {
      // Reset before running: commits during this pass coalesce into one more pass.
      connection.queued = false;
      await synchronize(connection);
    });
  }
  const feed = createCommitFeed(engine.sql, rows => {
    for (const connection of connections.values()) {
      if (rows.some(row => BigInt(row.ts) > BigInt(connection.cursor))) schedule(connection);
    }
  });
  const unsubscribeCommit = engine.onCommit(() => { feed.wake(); });

  /** @param {Connection} connection @param {any} frame */
  async function handle(connection, frame) {
    if (frame.type === "subscribe") {
      if (!connection.subscriptions.has(frame.queryId) && connection.subscriptions.size >= limits.subscriptions) {
        fatal(connection, new Error("Maximum subscriptions exceeded")); return;
      }
      connection.subscriptions.set(frame.queryId, { path: frame.path, args: Object.hasOwn(frame, "args") ? frame.args : {}, readSet: { ranges: [] }, lastValueJSON: undefined, ts: "0", initial: true });
      await synchronize(connection);
      return;
    }
    if (frame.type === "unsubscribe") {
      connection.subscriptions.delete(frame.queryId);
      return;
    }
    try {
      if (frame.type === "mutation") {
        const result = await engine.runMutation(frame.path, Object.hasOwn(frame, "args") ? frame.args : {});
        await synchronize(connection, result.ts);
        send(connection, { type: "mutationResult", requestId: frame.requestId, success: true, value: result.value, ts: result.ts });
      } else {
        const result = await engine.runAction(frame.path, Object.hasOwn(frame, "args") ? frame.args : {});
        send(connection, { type: "actionResult", requestId: frame.requestId, success: true, value: result.value });
      }
    } catch (error) {
      send(connection, { type: `${frame.type}Result`, requestId: frame.requestId, success: false, ...wireError(error) });
    }
  }
  return {
    /** @param {import('bun').ServerWebSocket<unknown>} socket */
    open(socket) {
      const connection = { socket, subscriptions: new Map(), ts: "0", cursor: "0", closed: false, queued: false, tail: Promise.resolve(), pending: 0, pendingBytes: 0 };
      connections.set(socket, connection);
      send(connection, { type: "hello", server: "rebendei", version: "0.1.0" });
    },
    /** @param {import('bun').ServerWebSocket<unknown>} socket @param {string|Buffer} message */
    message(socket, message) {
      const connection = connections.get(socket);
      if (!connection) return;
      try {
        if (typeof message !== "string") throw new Error("Expected JSON text frame");
        const bytes = Buffer.byteLength(message);
        if (connection.pending >= limits.pending || connection.pendingBytes + bytes > limits.pendingBytes) throw new Error("Maximum pending sync frames/bytes exceeded");
        const frame = JSON.parse(message);
        if (!isPlainObject(frame) || !["subscribe", "unsubscribe", "mutation", "action"].includes(frame.type)) throw new Error("Invalid sync frame type");
        const id = frame.type === "subscribe" || frame.type === "unsubscribe" ? frame.queryId : frame.requestId;
        if (!Number.isSafeInteger(id) || id < 0) throw new Error("Expected nonnegative integer ID");
        if (frame.type !== "unsubscribe" && (typeof frame.path !== "string" || !frame.path)) throw new Error("Expected function path");
        enqueue(connection, () => handle(connection, frame), bytes);
      } catch (error) { fatal(connection, error); }
    },
    /** @param {import('bun').ServerWebSocket<unknown>} socket */
    close(socket) {
      const connection = connections.get(socket);
      if (connection) { connection.closed = true; connection.subscriptions.clear(); connections.delete(socket); }
    },
    async stop() {
      unsubscribeCommit();
      queries.close();
      for (const connection of connections.values()) { connection.closed = true; connection.subscriptions.clear(); }
      const pending = [...connections.values()].map(connection => connection.tail);
      connections.clear();
      await feed.close();
      await Promise.all(pending);
    },
  };
}
