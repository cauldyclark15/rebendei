import { defineSchema, defineTable, v } from "../../src/api.js";
export default defineSchema({
  messages: defineTable({ channel: v.string(), score: v.number(), body: v.optional(v.string()) })
    .index("by_channel_score", ["channel", "score"]),
  counters: defineTable({ count: v.number() }),
});
