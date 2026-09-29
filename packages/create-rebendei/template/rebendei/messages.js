import { query, mutation, internalMutation, v } from "rebendei/server";

export const list = query({
  args: { channel: v.string() },
  handler: (ctx, { channel }) => ctx.db.query("messages")
    .withIndex("by_channel", (/** @type {any} */ q) => q.eq("channel", channel))
    .order("desc")
    .take(50),
});

export const send = mutation({
  args: { author: v.string(), body: v.string(), channel: v.string() },
  handler: async (ctx, args) => {
    if (!args.author.trim() || !args.body.trim() || !args.channel.trim()) {
      throw new Error("Author, body, and channel must not be blank");
    }
    const id = await ctx.db.insert("messages", args);
    // The job and the message commit together. Normal messages create no job.
    if (args.body.startsWith("/remind")) {
      await ctx.scheduler.runAfter(1000, "messages:reminder", {
        channel: args.channel,
        body: args.body.slice("/remind".length).trim() || "Check your messages",
      });
    }
    return id;
  },
});

export const reminder = internalMutation({
  args: { channel: v.string(), body: v.string() },
  handler: (ctx, { channel, body }) => ctx.db.insert("messages", {
    author: "scheduler", channel, body: `Reminder: ${body}`,
  }),
});

export const clear = internalMutation({
  args: { channel: v.string() },
  handler: async (ctx, { channel }) => {
    const messages = await ctx.db.query("messages")
      .withIndex("by_channel", (/** @type {any} */ q) => q.eq("channel", channel))
      .collect();
    for (const message of messages) await ctx.db.delete(message._id);
    return messages.length;
  },
});

// A harmless daily job. Replace this with your own maintenance work.
export const dailyTick = internalMutation({ args: {}, handler: () => null });
