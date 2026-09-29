import { defineSchema, defineTable, v } from "../../../src/api.js";
export default defineSchema({ sync_items: defineTable({ group: v.string(), score: v.number(), value: v.number() }).index("by_group_score", ["group", "score"]) });
