import { defineSchema, defineTable, v } from "rebendei/server";

export default defineSchema({
  messages: defineTable({
    author: v.string(),
    body: v.string(),
    channel: v.string(),
  }).index("by_channel", ["channel"]),
});
