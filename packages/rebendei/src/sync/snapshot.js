import { FunctionNotFoundError, ENGINE_INTERNAL } from "../engine/index.js";
import { loadFunctions } from "../engine/loader.js";
import { createDatabase } from "../engine/storage.js";
import { assertValue } from "../values/index.js";

/** Sync-local query executor: the engine's public runQuery always opens a txn.
 * Reuse its loader, validators, storage and context extensions without taking a
 * second pool connection. Savepoints isolate a failing SQL query from the batch.
 * @param {Awaited<ReturnType<typeof import('../engine/index.js').createEngine>>} engine
 */
export async function createSnapshotQueries(engine) {
  let loaded = await loadFunctions(engine.functionsDir);
  const reload = async () => { loaded = await loadFunctions(engine.functionsDir); };
  engine.hooks.onLoad.push(reload);
  return {
    /** @param {import('bun').TransactionSQL} tx @param {string} path @param {any} args @param {import('../engine/types.js').ReadSet} readSet */
    async run(tx, path, args, readSet) {
      const definition = loaded.functions.get(path);
      if (!definition || definition.kind !== "query" || definition.visibility !== "public") throw new FunctionNotFoundError(`Function not found: ${path}`);
      assertValue(args, "args"); definition.args?.validate(args, "args");
      return tx.savepoint(async () => {
        /** @type {import('../engine/index.js').EngineInternal} */ const internal = {
          sql: tx, rootSql: engine.sql,
          recordRead(range) { readSet.ranges.push(structuredClone(range)); },
          recordWrite() { throw new Error("Query is read-only"); },
        };
        /** @type {any} */ const ctx = { db: createDatabase(tx, engine.schema, "query", internal.recordRead, async () => { throw new Error("Query is read-only"); }) };
        Object.defineProperty(ctx, ENGINE_INTERNAL, { value: internal, enumerable: false });
        for (const extend of engine.extendCtx) extend("query", ctx, { path, args, sql: tx, engine });
        const value = await definition.handler(ctx, args);
        return value === undefined ? null : value;
      });
    },
    close() { const index = engine.hooks.onLoad.indexOf(reload); if (index >= 0) engine.hooks.onLoad.splice(index, 1); },
  };
}
