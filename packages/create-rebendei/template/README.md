# Rebendei messages + knowledge base

A backend-only example with live messages, transactional mutations, scheduled
reminders, a daily cron, and a RAG knowledge base. No browser UI or build step.

## Quick start

Install [Bun](https://bun.sh) and [Docker](https://www.docker.com/products/docker-desktop/), then:

```sh
bun install       # the generator normally does this for you
bun run db:up     # local Postgres 17 + pgvector
bun run dev       # applies migrations, listens on http://localhost:3210
```

In a second terminal, run `bun run demo`. It subscribes to `messages:list`, sends
three messages, prints live updates, and exits. No AI model is needed for messages.
The generator copies `.env.example` to `.env`. Edit `.env` for your own database,
port, and models. Restart the server after changing functions or environment.

## Function layout

| File | Purpose |
| --- | --- |
| `rebendei/schema.js` | `messages` fields: author, body, channel; `by_channel` index. |
| `rebendei/messages.js` | `list` returns the newest 50 in a channel; `send` validates and writes. `/remind ...` schedules an internal reminder after one second. `clear`, `reminder`, and `dailyTick` are internal. |
| `rebendei/crons.js` | Harmless `dailyTick` at 09:00 UTC. Replace it with maintenance work. |
| `rebendei/rag.js` | Local or hosted embedding provider and optional chat provider. |
| `rebendei/knowledge.js` | `ingest`, `search`, `ask` actions; reactive `entries` query; `remove` mutation. RAG owns its storage, so no documents table is needed. |
| `scripts/demo.js` | Bun client example; optional `REBENDEI_URL` override. |

A function path is `filename:export`, such as `messages:send`. Only public
functions are reachable from clients. This example has no authentication; do not
expose it publicly without adding access controls.

## Call over HTTP

```sh
curl http://localhost:3210/health
curl http://localhost:3210/api/mutation -H 'Content-Type: application/json' \
  -d '{"path":"messages:send","args":{"author":"Ada","body":"Hello","channel":"general"}}'
curl http://localhost:3210/api/query -H 'Content-Type: application/json' \
  -d '{"path":"messages:list","args":{"channel":"general"}}'
curl http://localhost:3210/api/mutation -H 'Content-Type: application/json' \
  -d '{"path":"messages:send","args":{"author":"Ada","body":"/remind drink water","channel":"general"}}'
```

Success returns `{ "status": "success", "value": ... }`, with a commit `ts` for
queries and mutations. Invalid arguments return 400; internal functions return 404.

## Call with the client

```js
import { RebendeiClient } from "rebendei/client";
const client = new RebendeiClient("http://localhost:3210");
const stop = client.onUpdate("messages:list", { channel: "general" }, console.log);
await client.mutation("messages:send", {
  author: "Ada", body: "Hello", channel: "general",
});
// Your subscription already reflects this write when the promise resolves.
stop();
await client.close();
```

Use `client.action("knowledge:ingest", args)` for model-calling functions.
`RebendeiHttpClient` is available from the same import for one-shot HTTP calls.

## Free local RAG

Install and start [Ollama](https://ollama.com/download), then:

```sh
ollama pull nomic-embed-text
# Optional: enable answers as well as search.
ollama pull llama3.2
```

Embeddings default to `http://localhost:11434/v1`, `nomic-embed-text`, 768
dimensions, no key. Ingest and search need embeddings; `ask` also needs chat.
Uncomment `CHAT_BASE_URL` and `CHAT_MODEL=llama3.2` in `.env` and restart for answers.

```sh
curl http://localhost:3210/api/action -H 'Content-Type: application/json' \
  -d '{"path":"knowledge:ingest","args":{"key":"backups","title":"Backups","text":"Back up Postgres every night.","source":"manual"}}'
curl http://localhost:3210/api/action -H 'Content-Type: application/json' \
  -d '{"path":"knowledge:search","args":{"query":"Postgres backups","source":"manual"}}'
curl http://localhost:3210/api/action -H 'Content-Type: application/json' \
  -d '{"path":"knowledge:ask","args":{"question":"When should I back up Postgres?"}}'
curl http://localhost:3210/api/query -H 'Content-Type: application/json' \
  -d '{"path":"knowledge:entries","args":{}}'
curl http://localhost:3210/api/mutation -H 'Content-Type: application/json' \
  -d '{"path":"knowledge:remove","args":{"key":"backups"}}'
```

`ask` returns `{ text, context }`; `context.entries` contains source metadata.
Subscribe to `knowledge:entries` with `{}` to see ingestion and removal live.
It returns a page of 50 entry metadata records; pass `continueCursor` as `cursor`
for further pages. Re-ingesting the same key and content returns `unchanged`.

`.env.example` documents all model variables and includes OpenAI and OpenRouter
examples. Keep keys server-side. A namespace fixes its embedding model and
dimensions on first ingestion. Before changing either, use a new namespace in
`rebendei/knowledge.js` and re-ingest. Full API and tuning:
[built-in RAG](https://github.com/cauldyclark15/rebendei/blob/main/docs/RAG.md).
