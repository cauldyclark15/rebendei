import { mutation, action, internalMutation, internalAction, query } from "../../src/api.js";

export const schedule = mutation({ handler: async (ctx, args) => {
  const id = args.at === undefined
    ? await ctx.scheduler.runAfter(args.delay ?? 0, args.path ?? "jobs:record", args.payload ?? {})
    : await ctx.scheduler.runAt(args.date ? new Date(args.at) : args.at, args.path ?? "jobs:record", args.payload ?? {});
  if (args.rollback) throw new Error("scheduling rollback");
  return id;
} });
export const cancel = mutation({ handler: async (ctx, args) => {
  await ctx.scheduler.cancel(args.id);
  if (args.rollback) throw new Error("cancel rollback");
} });
export const scheduleAction = action({ handler: (ctx, args) => ctx.scheduler.runAfter(args.delay ?? 0, args.path ?? "jobs:record", args.payload ?? {}) });
export const record = internalMutation({ handler: async (ctx, args) => {
  await ctx.db.insert("scheduler_events", args);
  if (args.crash && process.env.REBENDEI_SCHEDULER_TEST_CRASH === "1") {
    console.log("mutation-entered");
    await Bun.sleep(60000);
  }
  if (args.fail) throw new Error("mutation failure");
  return "recorded";
} });
export const perform = internalAction({ handler: async (ctx, args) => {
  if (args.fail) throw new Error("action failure");
  if (args.crash && process.env.REBENDEI_SCHEDULER_TEST_CRASH === "1") {
    console.log("action-entered");
    await Bun.sleep(60000);
  }
  await ctx.runMutation("jobs:record", args);
} });
export const list = query({ handler: (ctx) => ctx.db.query("scheduler_events").collect() });
export const createCounter = mutation({ handler: (ctx) => ctx.db.insert("scheduler_counters", { count: 0 }) });
export const getCounter = query({ handler: (ctx, args) => ctx.db.get(args.id) });
export const bump = internalMutation({ handler: async (ctx, args) => {
  const doc = await ctx.db.get(args.id);
  await ctx.checkpoint();
  await ctx.db.patch(args.id, { count: doc.count + 1 });
} });
