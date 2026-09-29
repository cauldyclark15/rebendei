# Architecture

Rebendei recreates the core idea of Convex — reactive queries over a transactional
document store — on Bun and Postgres.

## Pieces

| Piece | What it does |
| --- | --- |
| **Document store** | One `documents` table (JSONB) keyed by `(table_name, id)`, plus a monotonically increasing commit timestamp per write. |
| **Functions** | Developer-written `query`, `mutation`, and `action` modules in a `rebendei/` folder of the app. |
| **Queries** | Read-only, deterministic. The runtime records the *read set* (tables, ids, index ranges) they touch. |
| **Mutations** | Run inside one Postgres transaction (serializable). Produce a *write set* and a new commit timestamp. |
| **Actions** | Free to call the outside world; they reach the database only through queries and mutations. |
| **Sync engine** | WebSocket server. Holds client subscriptions; after each commit it intersects the write set with every subscription's read set and re-runs only the queries that could have changed. |
| **Commit log** | Postgres `LISTEN/NOTIFY` fans commits out, so multiple Rebendei processes stay in sync. |
| **Vector search** | `pgvector` columns + HNSW indexes exposed as a vector-index API on tables. |
| **Scheduler** | Durable scheduled jobs and UTC crons; workers claim jobs through Postgres. |
| **RAG** | OpenAI-compatible embeddings/chat, chunk storage, hybrid retrieval, and reactive entry metadata. |

## Milestones

- [x] Scaffold: server boots, Postgres + pgvector migrated, health check, CI.
- [x] Document store: `db.get / db.query / db.insert / db.patch / db.delete`.
- [x] Function loader: queries, mutations, actions; HTTP `POST /api/{query|mutation|action}`.
- [x] Read-set tracking and WebSocket sync (subscribe, update, unsubscribe).
- [x] Indexes (`withIndex`) and range-precise invalidation.
- [x] Vector indexes and search.
- [x] Scheduler and UTC crons.
- [x] Vanilla-JS reactive and HTTP client libraries.
- [x] Built-in RAG: chunking, OpenAI-compatible providers, hybrid search, live entries.
- [x] CLI and AI-ready app generator; real-CLI end-to-end acceptance test.

See [Getting started](./docs/GETTING-STARTED.md), [RAG](./docs/RAG.md), and the
[fixed API contract](./docs/DESIGN.md).
