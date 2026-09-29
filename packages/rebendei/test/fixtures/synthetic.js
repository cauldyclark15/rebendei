import { action, query } from "../../src/api.js";
import { ENGINE_INTERNAL } from "../../src/engine/index.js";
export const read = query({ handler: async (ctx) => {
  const internal = ctx[ENGINE_INTERNAL];
  internal.recordRead({ table: "_rag:ns", index: "by_id", fields: [], lower: null, upper: null });
  const [row] = await internal.sql`SELECT count(*)::int AS count FROM _rag_test`;
  return { count: row.count, hidden: Object.getOwnPropertyDescriptor(ctx, ENGINE_INTERNAL)?.enumerable === false };
} });
export const forbiddenWrite = query({ handler: (ctx) => ctx[ENGINE_INTERNAL].sql`INSERT INTO _rag_test (value) VALUES ('forbidden')` });
export const write = action({ handler: async (ctx) => {
  if (ctx[ENGINE_INTERNAL].sql !== null) throw new Error("Action unexpectedly has txn");
  return ctx[ENGINE_INTERNAL].runInMutation(async (/** @type {any} */ internal) => {
    await internal.sql`INSERT INTO _rag_test (value) VALUES ('hello')`;
    internal.recordWrite({ table: "_rag:ns", id: "synthetic", oldDoc: null, newDoc: null });
    return "committed";
  });
} });
