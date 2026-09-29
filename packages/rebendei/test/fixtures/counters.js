import { mutation, query, action } from "../../src/api.js";
export const insert = mutation({ handler: (ctx) => ctx.db.insert("counters", { count: 0 }) });
export const increment = mutation({ handler: async (ctx, { id }) => {
  const doc = await ctx.db.get(id);
  await Bun.sleep(1);
  await ctx.db.patch(id, { count: doc.count + 1 });
} });
export const get = query({ handler: (ctx, { id }) => ctx.db.get(id) });
export const bumpFromAction = action({ handler: (ctx, args) => ctx.runMutation("counters:increment", args) });
