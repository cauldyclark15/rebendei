import { resolve } from "node:path";
import { assertValue } from "../values/index.js";
import { loadFunctions } from "./loader.js";
import { backfillIndexes } from "./indexes.js";
import { createDatabase } from "./storage.js";
import { mutationTransaction, queryTransaction } from "./transactions.js";
import { installFeatures } from "../features.js";
export { readSetOverlaps } from "./read-set.js";
export { encodeKey, compareKeys } from "./keys.js";
export const ENGINE_INTERNAL = Symbol.for("rebendei.engineInternal");
export class FunctionNotFoundError extends Error {}
/** @typedef {{sql:import('bun').TransactionSQL|null,rootSql:import('bun').SQL,recordRead:(range:import('./types.js').Range)=>void,recordWrite:(write:import('./types.js').Write)=>void,runInMutation?:(fn:(internal:EngineInternal)=>Promise<any>)=>Promise<any>}} EngineInternal */
/** @param {{sql:import('bun').SQL,functionsDir?:string}} options */
export async function createEngine({ sql, functionsDir = resolve("rebendei") }) {
  functionsDir = resolve(functionsDir);
  /** @type {Awaited<ReturnType<typeof loadFunctions>>} */
  let loaded = { functions: new Map(), schema: null, crons: null };
  let closed = false;
  /** @type {Set<(ts:string,writes:import('./types.js').Write[])=>any>} */ const listeners = new Set();
  const hooks = {
    /** @type {((tx:import('bun').TransactionSQL,write:import('./types.js').Write)=>Promise<void>|void)[]} */ onWrite: [],
    /** @type {((sql:import('bun').SQL,schema:import('../schema.js').Schema|null)=>Promise<void>|void)[]} */ onSchema: [],
    /** @type {((engine:any)=>Promise<void>|void)[]} */ onLoad: [],
  };
  /** @type {((kind:import('../api.js').FunctionKind,ctx:any,meta:any)=>void)[]} */ const extendCtx = [];
  /** @param {string} path @param {import('../api.js').FunctionKind} kind @param {any} args @param {boolean} internal */
  function lookup(path, kind, args, internal) {
    if (closed) throw new Error("Engine is closed");
    const definition = loaded.functions.get(path);
    if (!definition || definition.kind !== kind || (definition.visibility === "internal" && !internal)) throw new FunctionNotFoundError(`Function not found: ${path}`);
    assertValue(args, "args"); definition.args?.validate(args, "args");
    return definition;
  }
  /** @param {import('../api.js').FunctionKind} kind @param {import('bun').TransactionSQL|null} tx @param {import('./types.js').ReadSet} readSet @param {import('./types.js').Write[]} writes @param {any} meta */
  function context(kind, tx, readSet, writes, meta) {
    /** @type {EngineInternal} */ const internal = {
      sql: tx, rootSql: sql, recordRead(range) { readSet.ranges.push(structuredClone(range)); },
      recordWrite(write) { writes.push(structuredClone(write)); },
    };
    /** @type {any} */ const ctx = {};
    if (tx && kind !== "action") ctx.db = createDatabase(tx, loaded.schema, kind, internal.recordRead, async (write) => {
      internal.recordWrite(write);
      for (const hook of hooks.onWrite) await hook(tx, write);
    });
    if (kind === "action") {
      ctx.runQuery = async (/** @type {string} */ path, /** @type {any} */ args = {}) => (await engine.runQuery(path, args, { internal: true })).value;
      ctx.runMutation = async (/** @type {string} */ path, /** @type {any} */ args = {}) => (await engine.runMutation(path, args, { internal: true })).value;
      ctx.runAction = async (/** @type {string} */ path, /** @type {any} */ args = {}) => (await engine.runAction(path, args, { internal: true })).value;
      internal.runInMutation = async (fn) => (await commit(async (transaction, reads, changes) => {
        const mutationCtx = context("mutation", transaction, reads, changes, { ...meta, synthetic: true });
        return fn(mutationCtx[ENGINE_INTERNAL]);
      })).value;
    }
    Object.defineProperty(ctx, ENGINE_INTERNAL, { value: internal, enumerable: false });
    for (const extend of extendCtx) extend(kind, ctx, { ...meta, sql: tx, engine });
    return ctx;
  }
  /** @param {(tx:import('bun').TransactionSQL,readSet:import('./types.js').ReadSet,writes:import('./types.js').Write[])=>Promise<any>} execute */
  async function commit(execute) {
    if (closed) throw new Error("Engine is closed");
    const result = await mutationTransaction(sql, async (tx) => {
      /** @type {import('./types.js').Write[]} */ const writes = [];
      const value = await execute(tx, { ranges: [] }, writes);
      return { value: value === undefined ? null : value, writes };
    });
    for (const listener of listeners) { try { await listener(result.ts, result.writes); } catch (error) { console.error("rebendei onCommit callback failed", error); } }
    return result;
  }
  const engine = {
    sql, functionsDir, hooks, extendCtx,
    get schema() { return loaded.schema; },
    get crons() { return loaded.crons; },
    async load() {
      if (closed) throw new Error("Engine is closed");
      const next = await loadFunctions(functionsDir);
      await backfillIndexes(sql, next.schema); loaded = next;
      for (const hook of hooks.onSchema) await hook(sql, next.schema);
      for (const hook of hooks.onLoad) await hook(engine);
    },
    /** @param {string} path @param {any} [args] @param {{internal?:boolean}} [options] */
    async runQuery(path, args = {}, { internal = false } = {}) {
      const definition = lookup(path, "query", args, internal);
      return queryTransaction(sql, async (tx) => {
        /** @type {import('./types.js').ReadSet} */ const readSet = { ranges: [] };
        const ctx = context("query", tx, readSet, [], { path, args });
        const value = await definition.handler(ctx, args);
        return { value: value === undefined ? null : value, readSet };
      });
    },
    /** Runs a query inside a caller-owned read transaction (one shared snapshot for a sync batch).
     * Pass `readSet` to keep the ranges read so far even when the handler throws (so a failing
     * subscription is re-run when the data it read changes).
     * @param {import('bun').TransactionSQL} tx @param {string} path @param {any} [args] @param {{internal?:boolean, readSet?:import('./types.js').ReadSet}} [options] */
    async runQueryInTransaction(tx, path, args = {}, { internal = false, readSet = { ranges: [] } } = {}) {
      const definition = lookup(path, "query", args, internal);
      const ctx = context("query", tx, readSet, [], { path, args });
      const value = await definition.handler(ctx, args);
      return { value: value === undefined ? null : value, readSet };
    },
    /** @param {string} path @param {any} [args] @param {{internal?:boolean}} [options] */
    async runMutation(path, args = {}, { internal = false } = {}) {
      const definition = lookup(path, "mutation", args, internal);
      return commit(async (tx, readSet, writes) => definition.handler(context("mutation", tx, readSet, writes, { path, args }), args));
    },
    /** @param {string} path @param {any} [args] @param {{internal?:boolean}} [options] */
    async runAction(path, args = {}, { internal = false } = {}) {
      const definition = lookup(path, "action", args, internal);
      const value = await definition.handler(context("action", null, { ranges: [] }, [], { path, args }), args);
      return { value: value === undefined ? null : value };
    },
    /** @param {(ts:string,writes:import('./types.js').Write[])=>any} listener */
    onCommit(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async close() { closed = true; listeners.clear(); },
  };
  await installFeatures(engine);
  await engine.load();
  return engine;
}
