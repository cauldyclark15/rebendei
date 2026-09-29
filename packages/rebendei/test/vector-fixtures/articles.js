import { action, mutation, query } from "../../src/api.js";
export const insert = mutation({ handler: (ctx, args) => ctx.db.insert(args.table ?? "articles", args.doc) });
export const batch = mutation({ handler: async (ctx, args) => {
  const ids = [];
  for (const doc of args.docs) ids.push(await ctx.db.insert("articles", doc));
  return ids;
} });
export const patch = mutation({ handler: (ctx, args) => ctx.db.patch(args.id, args.value) });
export const removeEmbedding = mutation({ handler: (ctx, args) => ctx.db.patch(args.id, { embedding: undefined }) });
export const replace = mutation({ handler: (ctx, args) => ctx.db.replace(args.id, args.doc) });
export const remove = mutation({ handler: (ctx, args) => ctx.db.delete(args.id) });
export const get = query({ handler: (ctx, args) => ctx.db.get(args.id) });
export const queryContext = query({ handler: (ctx) => typeof ctx.vectorSearch });
export const mutationContext = mutation({ handler: (ctx) => typeof ctx.vectorSearch });
export const rollback = mutation({ handler: async (ctx, args) => {
  await ctx.db.insert("articles", args.doc); throw new Error("rollback vector write");
} });
export const search = action({ handler: (ctx, args) => ctx.vectorSearch(args.table ?? "articles", args.index ?? "by_embedding", {
  vector: args.vector,
  ...(Object.hasOwn(args, "limit") ? { limit: args.limit } : {}),
  ...(args.eq ? { filter: (/** @type {any} */ q) => q.eq(args.eq[0], args.eq[1]) } : {}),
  ...(args.or ? { filter: (/** @type {any} */ q) => q.or(...args.or.map((/** @type {any[]} */ entry) => q.eq(entry[0], entry[1]))) } : {}),
  ...(args.forged ? { filter: () => ({ kind: "eq", field: "channel", value: "a" }) } : {}),
  ...(args.emptyOr ? { filter: (/** @type {any} */ q) => q.or() } : {}),
  ...(args.rawFilter ? { filter: args.rawFilter } : {}),
}) });
