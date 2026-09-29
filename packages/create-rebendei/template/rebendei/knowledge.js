import { action, query, mutation, v } from "rebendei/server";
import { rag } from "./rag.js";

// Change namespace when switching embedding models or dimensions, then re-ingest.
const namespace = "knowledge";

export const ingest = action({
  args: { key: v.string(), title: v.string(), text: v.string(), source: v.string() },
  handler: (ctx, { key, title, text, source }) => rag.add(ctx, {
    namespace, key, title, text,
    metadata: { source },
    filterValues: [{ name: "source", value: source }],
  }),
});

export const ask = action({
  args: { question: v.string() },
  handler: (ctx, { question }) => rag.generateText(ctx, {
    namespace, prompt: question,
    search: { searchType: "hybrid", limit: 3 },
  }),
});

export const search = action({
  args: { query: v.string(), source: v.optional(v.string()) },
  handler: (ctx, { query, source }) => rag.search(ctx, {
    namespace, query,
    filters: source === undefined ? [] : [{ name: "source", value: source }],
  }),
});

// Live entry metadata, with no external model call in the query.
export const entries = query({
  args: { cursor: v.optional(v.string()) },
  handler: (ctx, { cursor }) => rag.list(ctx, {
    namespace, paginationOpts: { numItems: 50, cursor: cursor ?? null },
  }),
});

export const remove = mutation({
  args: { key: v.string() },
  handler: (ctx, { key }) => rag.delete(ctx, { namespace, key }),
});
