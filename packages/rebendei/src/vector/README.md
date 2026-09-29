# Vector indexes

`defineTable(...).vectorIndex(name, { vectorField, dimensions, filterFields })`
materializes a registry entry and a quoted `rv_<table>__<index>` table. Names
longer than 63 bytes, unsafe characters, and ambiguous `__` components receive
a deterministic hash suffix. HNSW uses cosine distance; filter columns have GIN
and per-field JSONB btree indexes. DDL, backfill, and registry changes commit
atomically. Document writes are blocked during schema reconciliation/backfill.
Changing dimensions, vectorField, or filterFields rebuilds the table; removal
drops it. Unchanged definitions retain their tables.

Missing vector fields remove/omit the index row. **Present invalid vectors throw
and roll back the mutation**, regardless of `schemaValidation`: an ordinary
`v.array(v.number())` checks type but cannot check dimensionality. The engine's
schema validator runs first, so errors it catches are not replaced. Backfill
skips existing invalid or missing vectors, allowing dimensions to change without
invalid historical documents blocking a reload. Components must be representable
as finite float32 numbers (pgvector storage). Dotted vector/filter paths work.

Actions receive `ctx.vectorSearch(table, index, { vector, limit = 10, filter })`.
Limits must be integers from 1 to 256. Filters are callback expressions made from
`q.eq(declaredField, JSONValue)` or `q.or(...)`, with exact JSONB equality (arrays
are not containment tests). Undeclared fields and forged expressions throw;
fields and values are bound parameters. Query/mutation contexts have no search.

Search uses a short transaction with `SET LOCAL hnsw.ef_search = max(limit*2,40)`
and `hnsw.iterative_scan = strict_order` (pgvector >= 0.8). Results are approximate
nearest neighbors ordered by cosine similarity, `_score = 1 - cosineDistance`.
HNSW's `vector` operator class limits dimensions to 2000. Cosine similarity is
undefined for zero vectors: zero-vector queries throw, and stored zero vectors
are omitted by pgvector's HNSW index. Search excludes undefined cosine distances
on sequential scans too. Avoid zero document embeddings. PostgreSQL
may choose a sequential scan for tiny tables, as it does for other indexes.
