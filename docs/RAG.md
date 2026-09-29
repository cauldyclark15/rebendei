# Built-in RAG

`rebendei/rag` combines local or hosted embeddings, pgvector cosine retrieval,
Postgres full-text search, and optional cited chat responses. No extra runtime
packages are needed. Run Rebendei's migrations before using it.

## Free local setup with Ollama

1. Install [Ollama](https://ollama.com/download) and start it.
2. Install an embedding model: `ollama pull nomic-embed-text`.
3. For answers as well as retrieval, install a chat model: `ollama pull llama3.2`.
4. Add the module below in your app's `rebendei/rag.js`.

Ollama's OpenAI-compatible endpoint is `http://localhost:11434/v1`. Local requests
need no API key. The embedding model must produce the configured dimensions.
`nomic-embed-text` produces 768 dimensions. Embedding and chat models are separate;
a chat-only model cannot be used as an embedding model.

```js
// rebendei/rag.js
import { RAG, openaiCompatible } from "rebendei/rag";

export const rag = new RAG({
  embedding: openaiCompatible.embedding({
    baseURL: process.env.EMBEDDING_BASE_URL ?? "http://localhost:11434/v1",
    apiKey: process.env.EMBEDDING_API_KEY,
    model: process.env.EMBEDDING_MODEL ?? "nomic-embed-text",
    dimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 768),
  }),
  chat: openaiCompatible.chat({
    baseURL: process.env.CHAT_BASE_URL ?? "http://localhost:11434/v1",
    apiKey: process.env.CHAT_API_KEY,
    model: process.env.CHAT_MODEL ?? "llama3.2",
  }),
  filterNames: ["category", "userId"],
  chunker: { maxChars: 2000, overlapChars: 200 },
  efSearch: 100,
});
```

The function loader ignores non-function exports, so `rag.js` can export a RAG
instance without registering a callable function. `new RAG()` also defaults to
Ollama with `nomic-embed-text` at 768 dimensions, without a chat provider.

## Ingest and ask in actions

Embedding and chat calls belong in actions, not transactions. `add` computes
embeddings first, then replaces the entry and all of its chunks atomically in a
normal committed mutation transaction.

```js
// rebendei/knowledge.js
import { action, query, mutation, v } from "rebendei/server";
import { rag } from "./rag.js";

export const ingest = action({
  args: { key: v.string(), title: v.string(), text: v.string() },
  handler: (ctx, args) => rag.add(ctx, {
    namespace: "manuals", ...args,
    metadata: { source: "manual-upload" },
    filterValues: [{ name: "category", value: "manual" }],
    importance: 1,
  }),
});

export const ask = action({
  args: { prompt: v.string() },
  handler: (ctx, { prompt }) => rag.generateText(ctx, {
    namespace: "manuals", prompt,
    search: {
      searchType: "hybrid", limit: 6,
      filters: [{ name: "category", value: "manual" }],
      chunkContext: { before: 1, after: 1 },
    },
    maxContextChars: 12000,
    system: "Be concise.",
  }),
});

// Reactive query: no embedding or chat request is made here.
export const list = query({
  args: { cursor: v.optional(v.string()) },
  handler: (ctx, { cursor }) => rag.list(ctx, {
    namespace: "manuals", paginationOpts: { numItems: 25, cursor: cursor ?? null },
  }),
});

export const get = query({
  args: { key: v.string() },
  handler: (ctx, { key }) => rag.getEntry(ctx, { namespace: "manuals", key }),
});

export const remove = mutation({
  args: { key: v.string() },
  handler: (ctx, { key }) => rag.delete(ctx, { namespace: "manuals", key }),
});
```

Use stable per-namespace keys for ingestion. `add` returns
`{ entryId, status, created }`. The first addition returns `ready`, replacement
returns `replaced`, and identical normalized content returns `unchanged` without
an embedding request. The hash includes normalized chunks and their metadata,
title, entry metadata, exact filter values, and importance. Object key order
does not affect it. Replacement preserves the entry id and creation time.

You may provide `chunks: ["text", { text: "text", metadata: {...} }]` instead of
`text`. These chunks are normalized but not split further. Supplying both is an
error. No key means a fresh generated key for every addition.

`getEntry` returns entry metadata or `null`. Entry objects contain `entryId`,
`key`, `title`, `metadata`, `filterValues`, `importance`, and `createdAt` (ISO date).
`list` paginates deterministically by entry id and returns
`{ page, isDone, continueCursor }`. Pass its opaque cursor unchanged to the next
page in the same namespace. `delete` returns whether an entry was removed;
`deleteNamespace` returns the number of entries removed and drops its HNSW index.
Both deletes work in actions or mutations. In a mutation, deletion rolls back
with any later failure in that same transaction.

## Subscribe to the live list

```js
import { RebendeiClient } from "rebendei/client";
const client = new RebendeiClient("http://localhost:3000");
const stop = client.onUpdate("knowledge:list", {}, (result) => {
  console.log(result.page);
});
await client.action("knowledge:ingest", {
  key: "getting-started", title: "Getting started", text: "Your manual text...",
});
// The subscription's next value contains the new entry.
// When leaving the screen:
stop();
client.close();
```

`list` and `getEntry` read inside the query's existing repeatable-read transaction
and register reads on `_rag:<namespace>`. Ingestion and deletes record writes on
the same synthetic table and use normal commit timestamps and notifications.
That makes existing subscribed query results re-run, including a query that
previously returned an empty list or a missing key. Invalidation is deliberately
namespace-wide, not per key. Retrieval and generation are actions, not reactive
queries. Subscribe to entry metadata rather than running external models in a
query.

## Retrieval without chat

```js
const context = await rag.search(ctx, {
  namespace: "manuals", query: "How do I configure backups?",
  searchType: "hybrid", limit: 10,
  filters: [{ name: "category", value: "manual" }],
  vectorScoreThreshold: 0.2,
  chunkContext: { before: 0, after: 1 },
});
// context.results: ranked chunk hits with entryId, key, order, score and content
// context.entries: unique entry metadata in first-hit order
// context.text: entry-title headers and deduplicated text in chunk order
```

- `vector`: cosine similarity, weighted by entry importance. String queries are
  embedded once; supply a numeric vector to avoid that request.
- `text`: `ts_rank_cd` over `websearch_to_tsquery('simple', query)`. No model call.
  Requires a string query; quoted phrases and web-search syntax work.
- `hybrid` (default): reciprocal rank fusion with `k=60`. Vector candidates are
  importance-weighted; their RRF contributions are also multiplied by importance.
  Text contributions are unweighted. A numeric query uses only the vector branch.
- Filter keys must be declared in `filterNames`; duplicate or unknown keys are
  rejected. Filters combine with AND and compare the complete JSON value, not a
  substring or a nested subset. Filters are not an authorization system. Choose
  namespaces and user filters from authenticated server-side identity, not from
  an untrusted client's tenant id.
- `vectorScoreThreshold` applies to raw cosine similarity before vector ranking.
  In hybrid mode text matches can still appear below this vector threshold.
- A missing namespace returns empty results without calling the embedding API.

`generateText` returns `{ text, context }`. It numbers entry sources `[1]`, `[2]`,
adds the question, and tells the chat model to answer only from context, cite
`[n]`, and acknowledge missing evidence. `maxContextChars` limits the supplied
source text; the returned `context` remains the full retrieval result. Prompt
instructions are not a guarantee against model hallucinations or injection.

## Switch providers with environment variables

For [OpenAI](https://platform.openai.com/), set server-only variables:

```dotenv
EMBEDDING_BASE_URL=https://api.openai.com/v1
EMBEDDING_API_KEY=your-server-side-key
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536
CHAT_BASE_URL=https://api.openai.com/v1
CHAT_API_KEY=your-server-side-key
CHAT_MODEL=gpt-4o-mini
```

For [OpenRouter](https://openrouter.ai/models), select an embedding-capable model
and its supported dimensions, plus a chat model:

```dotenv
EMBEDDING_BASE_URL=https://openrouter.ai/api/v1
EMBEDDING_API_KEY=your-server-side-key
EMBEDDING_MODEL=your-embedding-model-id
EMBEDDING_DIMENSIONS=1536
CHAT_BASE_URL=https://openrouter.ai/api/v1
CHAT_API_KEY=your-server-side-key
CHAT_MODEL=your-chat-model-id
```

Embedding supports optional `headers` (for example provider-specific attribution)
and both adapters support an injectable `fetch` for testing or custom transport.
Keys remain server-side. A namespace's first addition fixes its model and
vector dimensions. Changing either requires a new namespace, or deleting the
old namespace and re-ingesting. Existing embeddings cannot be reused across
models. The current `vector` HNSW index supports 1 through 2000 dimensions;
configure dimension reduction where your provider supports it for larger models.

## Tuning and operational behavior

| Knob | Default | Effect |
| --- | --- | --- |
| `chunker.maxChars` | 2000 | Smaller chunks yield more focused retrieval and more embeddings. |
| `chunker.overlapChars` | 200 | Whole-word suffix overlap, bounded by available space; must be less than maxChars. |
| `importance` on add | 1 | Range 0..1, weighting vector retrieval without changing stored embeddings. |
| `search.limit` | 10 | Number of ranked chunk hits, not entries. |
| `chunkContext.before/after` | 0/0 | Include neighboring chunks from the same entry. |
| `efSearch` on RAG or search | 100 | Transaction-local HNSW search breadth; higher values cost more but improve recall. |
| `maxContextChars` on generateText | 12000 | Maximum source text sent to the chat model. |

The pure exported `chunkText(text, opts)` splits paragraphs, then sentences,
then words. Headings stay with following text when the size limit permits it.
Only a word longer than `maxChars` is split internally. Whole-word overlap may be
shorter than requested, or empty when a boundary has no room for it.

Embedding requests batch at most 64 inputs, validate every returned dimension,
and reorder results by their response indices. Providers retry HTTP 429 and 5xx
with exponential backoff (four total attempts), with a 60-second abort timeout
per request. Authentication failures are not retried. Provider errors are
`RebendeiError` with `{ provider, status }` (status 0 for transport or timeout);
malformed embedding responses also include a dimension-mismatch reason. Provider
response bodies and API keys are never included in those errors.

Each namespace has its own safely named partial HNSW index, created with its
first addition, and shares a GIN full-text index. Search uses repeatable-read
transactions and pgvector's iterative scan for filtered ANN retrieval. Candidate
pools are bounded at `max(64, limit * 10)` per retrieval branch, so hybrid search
is approximate rather than an exhaustive all-chunks ranking.
