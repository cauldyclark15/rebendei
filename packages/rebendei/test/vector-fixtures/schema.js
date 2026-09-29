import { defineSchema, defineTable, v } from "../../src/api.js";
export default defineSchema({ articles: defineTable({
  embedding: v.optional(v.array(v.number())),
  other: v.optional(v.array(v.number())),
  channel: v.optional(v.string()), tag: v.optional(v.any()),
}).vectorIndex("by_embedding", { vectorField: "embedding", dimensions: 3, filterFields: ["channel", "tag"] })
  .vectorIndex("by_other", { vectorField: "other", dimensions: 3, filterFields: ["channel"] }) });
