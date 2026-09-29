# Vector indexes

`defineTable(...).vectorIndex(name, { vectorField, dimensions, filterFields })`
materializes a registry entry and a quoted `rv_t_<hash>` table, using a
192-bit SHA-256 prefix over the JSON tuple `[table, index]`. Secondary indexes
use a disjoint `rv_i_` prefix and hash `[physicalTable, role]`; HNSW keeps a
readable `_hnsw` suffix. Tables have fixed-length names, so implicit `_pkey`
relations cannot alias tables either. Every name fits PostgreSQL's 63-byte limit.
HNSW uses cosine distance; filter columns have GIN
and per-field JSONB btree indexes. DDL, backfill, and registry changes commit
atomically. Document writes are blocked during schema reconciliation/backfill.
Changing dimensions, vectorField, or filterFields rebuilds the table; removal
drops it. Unchanged definitions retain their tables.

The first `engine.load()` after upgrading automatically rebuilds legacy `0004`
registry names and backfills from stored documents in the same locked transaction.
No landed migration edits or manual migration are required. This first reload
incurs backfill cost and blocks document writes until reconciliation commits.

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
