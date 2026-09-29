# Getting started

## 1. Create and run a backend

Install [Bun](https://bun.sh/docs/installation) and
[Docker Desktop](https://www.docker.com/products/docker-desktop/). Start Docker, then:

```sh
npx create-rebendei my-app   # or bunx create-rebendei my-app
cd my-app
bun run db:up
bun run dev
```

The generator installs dependencies and creates `.env` from `.env.example`.
`dev` applies migrations and starts HTTP + WebSocket on port 3210. You can instead
set `DATABASE_URL` to your own Postgres 17 database with pgvector installed.
Messages work without any AI provider. In another terminal inside the app:

```sh
bun run demo
```

The demo sends three messages, prints reactive query updates, and exits.

## 2. Write a query and mutation

Functions live in `rebendei/`. The starter's `schema.js` defines the `messages`
table with string fields `author`, `body`, and `channel`, indexed by channel.
Append these exports to `rebendei/messages.js`, which already imports `query`,
`mutation`, and `v` from `rebendei/server`:

```js
export const recent = query({
  args: { channel: v.string() },
  handler: (ctx, { channel }) => ctx.db.query("messages")
    .withIndex("by_channel", (q) => q.eq("channel", channel))
    .order("desc").take(50),
});

export const post = mutation({
  args: { author: v.string(), body: v.string(), channel: v.string() },
  handler: (ctx, args) => ctx.db.insert("messages", args),
});
```

Queries read data. Mutations write atomically in a serializable transaction.
Actions call external services and reach data through queries and mutations.
Restart `bun run dev` after editing functions; it does not hot-reload them.

```sh
curl http://localhost:3210/api/mutation -H 'Content-Type: application/json' \
  -d '{"path":"messages:post","args":{"author":"Ada","body":"Hello","channel":"general"}}'
curl http://localhost:3210/api/query -H 'Content-Type: application/json' \
  -d '{"path":"messages:recent","args":{"channel":"general"}}'
```

HTTP uses `POST /api/query`, `/api/mutation`, or `/api/action` with `{ path, args }`.
Function paths are `file:export`. Internal functions are server-only.

## 3. Subscribe from JavaScript

Put this in `scripts/live.js` and run `bun scripts/live.js`:

```js
import { RebendeiClient } from "rebendei/client";
const client = new RebendeiClient("http://localhost:3210");
const stop = client.onUpdate("messages:list", { channel: "general" }, console.log);
await client.mutation("messages:send", {
  author: "Ada", body: "Hello subscribers", channel: "general",
});
// This client's subscriptions already show its write when mutation resolves.
stop();
await client.close();
```

The same client works in browsers and Node with WebSocket support. Keep the
subscription open for a live screen; close it when the screen goes away.
The starter also schedules a follow-up when `messages:send` receives a body
starting with `/remind`, and has a harmless daily internal cron at 09:00 UTC.

## 4. Add knowledge with free local models

The starter already includes `rag.js` and `knowledge.js`. Install and start
[Ollama](https://ollama.com/download):

```sh
ollama pull nomic-embed-text
ollama pull llama3.2
```

The default embedding configuration is Ollama's `/v1` endpoint with
`nomic-embed-text` at 768 dimensions. Enable answers by setting these in `.env`:

```dotenv
CHAT_BASE_URL=http://localhost:11434/v1
CHAT_MODEL=llama3.2
```

Restart Rebendei. Ingest a document and ask a question:

```sh
curl http://localhost:3210/api/action -H 'Content-Type: application/json' \
  -d '{"path":"knowledge:ingest","args":{"key":"backups","title":"Backups","text":"Back up Postgres every night.","source":"manual"}}'
curl http://localhost:3210/api/action -H 'Content-Type: application/json' \
  -d '{"path":"knowledge:ask","args":{"question":"When should I back up Postgres?"}}'
```

`ask` returns text plus sources in `context.entries`. `knowledge:search` accepts
`{ query, source? }` without a chat model. Subscribe to `knowledge:entries` with
`{}` to observe ingestion and deletion live; it returns `{ page, isDone,
continueCursor }`. `knowledge:remove` takes `{ key }`. RAG owns its tables,
chunks documents, and combines vectors with Postgres full-text search.

## 5. Switch to OpenAI

Replace the corresponding `.env` values, keeping API keys server-side:

```dotenv
EMBEDDING_BASE_URL=https://api.openai.com/v1
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536
EMBEDDING_API_KEY=your-server-side-key
CHAT_BASE_URL=https://api.openai.com/v1
CHAT_MODEL=gpt-4o-mini
CHAT_API_KEY=your-server-side-key
```

Before switching an already populated embedding model or dimensions, change
`namespace` in `rebendei/knowledge.js` to a new name and re-ingest. Restart after
configuration changes. `.env.example` also has OpenRouter examples. Read the
[RAG guide](./RAG.md) for filtering, pagination, tuning, and provider behavior.

This starter has no authentication. Add access controls before exposing it
publicly. Filters alone do not enforce authorization.
