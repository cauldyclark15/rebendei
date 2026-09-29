import { query, mutation, internalQuery, action, RebendeiError, v } from "../../src/api.js";
export const insert = mutation({ args: { channel: v.string(), score: v.number(), body: v.optional(v.string()) }, handler: (ctx, args) => ctx.db.insert("messages", args) });
export const unchecked = mutation({ handler: (ctx, args) => ctx.db.insert("messages", args) });
export const get = query({ args: { id: v.id("messages") }, handler: (ctx, { id }) => ctx.db.get(id) });
export const removeBody = mutation({ args: { id: v.id("messages") }, handler: (ctx, { id }) => ctx.db.patch(id, { body: undefined }) });
export const patch = mutation({ handler: (ctx, { id, value }) => ctx.db.patch(id, value) });
export const replace = mutation({ handler: (ctx, { id, value }) => ctx.db.replace(id, value) });
export const remove = mutation({ handler: (ctx, { id }) => ctx.db.delete(id) });
export const all = query({ handler: (ctx) => ctx.db.query("messages").collect() });
export const range = query({ handler: (ctx, args) => {
  const q = ctx.db.query("messages").withIndex("by_channel_score", (/** @type {any} */ r) => {
    r.eq("channel", args.channel);
    if (args.lo !== undefined) r[args.lowerExclusive ? "gt" : "gte"]("score", args.lo);
    if (args.hi !== undefined) r[args.upperInclusive ? "lte" : "lt"]("score", args.hi);
  }).order(args.order ?? "asc");
  if (args.even) q.filter((/** @type {any} */ doc) => doc.score % 2 === 0);
  if (args.terminal === "paginate") return q.paginate({ numItems: args.numItems, cursor: args.cursor });
  if (args.terminal === "take") return q.take(args.count);
  if (args.terminal === "first") return q.first();
  if (args.terminal === "unique") return q.unique();
  if (args.terminal === "iterate") return (async () => { const docs = []; for await (const doc of q) docs.push(doc); return docs; })();
  return q.collect();
} });
export const secret = internalQuery({ handler: () => "internal value" });
export const internalFromAction = action({ handler: (ctx) => ctx.runQuery("messages:secret", {}) });
export const fail = mutation({ handler: () => { throw new RebendeiError({ code: "USER_FAILURE" }); } });
export const rollback = mutation({ handler: async (ctx) => { await ctx.db.insert("messages", { channel: "rollback", score: 1 }); throw new Error("rollback"); } });
export const noWriter = query({ handler: (ctx) => ({ writer: typeof ctx.db.insert, scheduler: "scheduler" in ctx }) });
export const nullArgs = action({ args: v.null(), handler: (_ctx, args) => args });
export const snapshot = query({ handler: async (ctx, { id }) => {
  const before = await ctx.db.get(id);
  await ctx.checkpoint();
  const after = await ctx.db.get(id);
  return { before, after };
} });
