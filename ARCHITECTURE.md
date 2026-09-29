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

## Milestones

1. Scaffold: server boots, Postgres + pgvector migrated, health check, CI. ← *here*
2. Document store + `db.get / db.query / db.insert / db.patch / db.delete`.
3. Function loader: `query()`, `mutation()`, `action()` from a user folder; HTTP `POST /api/{query|mutation|action}`.
4. Read-set tracking and the WebSocket sync protocol (subscribe, update, unsubscribe).
5. Indexes (`withIndex`) and range-precise invalidation.
6. Vector indexes and search.
7. Schedulers and cron.
8. Vanilla-JS client library.
