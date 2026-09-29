# Rebendei

An open-source reactive backend in the spirit of [Convex](https://github.com/get-convex/convex-backend):
write server functions in plain JavaScript, and every client subscribed to a query
gets fresh results the moment the data it read changes.

- **Language:** vanilla JavaScript (ES modules, JSDoc for types — no build step)
- **Runtime:** [Bun](https://bun.sh)
- **Database:** PostgreSQL + [pgvector](https://github.com/pgvector/pgvector)
- **Dependencies:** none at runtime — Bun's built-in HTTP/WebSocket server and Postgres client

## Features

- **Real-time queries:** WebSocket subscriptions update when the data they read changes.
- **Transactions:** validated mutations commit atomically with serializable retries.
- **Scheduler and crons:** transactional scheduled jobs and recurring UTC schedules.
- **Vector search:** pgvector HNSW indexes with filtering.
- **Built-in RAG:** chunking, local or hosted embeddings, hybrid retrieval, cited answers,
  and live knowledge entry queries. [RAG guide](./docs/RAG.md).
- **JavaScript clients:** reactive WebSocket client and one-shot HTTP client for Bun,
  browsers, and Node. [Client API](./packages/rebendei/src/client/README.md).

The starter includes messages, scheduled reminders, and a RAG knowledge base.
[Getting started](./docs/GETTING-STARTED.md) · [Architecture](./ARCHITECTURE.md) ·
[API contract](./docs/DESIGN.md). Early-stage software; the example is not an
authenticated production service.

## Create a backend

```sh
npx create-rebendei my-app      # or: bunx create-rebendei my-app
cd my-app
bun run db:up                   # Postgres 17 + pgvector in Docker
bun run dev                     # http://localhost:3210
# In another terminal inside my-app:
bun run demo                    # three messages with live updates; no model needed
```

Needs [Bun](https://bun.sh) and Docker (or your own Postgres with pgvector via `DATABASE_URL`).

## CLI

```
rebendei dev       apply migrations, then start the server
rebendei start     start the server
rebendei migrate   apply pending migrations
rebendei db:up     start local Postgres + pgvector
rebendei db:down   stop it
```

## Working on Rebendei itself

```sh
cp .env.example .env
bun install --linker=hoisted     # resolves workspace imports in the starter template
bun run db:up
bun run dev
```

## Tests

```sh
bun run db:up && bun test
```

## Layout

```
packages/
  rebendei/         the backend + `rebendei` CLI (npm: rebendei)
    bin/ src/ migrations/ test/
  create-rebendei/  project generator (npm: create-rebendei)
    template/
```

## Not affiliated

Rebendei is an independent project. It is not affiliated with Convex, Inc. and
contains no Convex source code.

## License

MIT
