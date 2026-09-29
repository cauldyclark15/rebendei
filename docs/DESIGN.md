# Rebendei design contract

This is the fixed contract between Rebendei's modules. Names and shapes here are
load-bearing: change them only in a PR that updates this file and every caller.

Everything is vanilla JavaScript (ES modules, JSDoc types, `checkJs` strict). The
server runs on Bun; `src/client/**` and `src/values/**` must also run in browsers
and Node (no `Bun.*`, no `bun:*` imports there).

## Package layout (`packages/rebendei`)

| Import | File | Contents |
| --- | --- | --- |
| `rebendei` | `src/index.js` | `startServer`, `migrate`, `connect`, `createEngine` |
| `rebendei/server` | `src/api.js` | what app code imports: `query`, `mutation`, `action`, `internalQuery`, `internalMutation`, `internalAction`, `v`, `defineSchema`, `defineTable`, `cronJobs` |
| `rebendei/client` | `src/client/index.js` | `RebendeiClient` (WebSocket, reactive), `RebendeiHttpClient` |
| `rebendei/values` | `src/values/index.js` | `v`, `ValidationError`, `validate`, value helpers |

## App layout

```
my-app/
  rebendei/
    schema.js        export default defineSchema({...})   (optional)
    crons.js         export default crons                  (optional)
    messages.js      export const list = query({...})
    ai/embed.js      export const run = action({...})
```

A **function path** is `<file path without .js, "/"-separated>:<export name>`,
e.g. `messages:list`, `ai/embed:run`. `export default` is addressed as
`messages:default` and also as `messages`. `schema.js` and `crons.js` are not
function modules. Files/dirs starting with `_` or `.` are ignored.

## Values

Documents and arguments are JSON values: `null`, boolean, finite number,
string, array, plain object. Field names starting with `_` are reserved for
system fields. Every stored document has:

- `_id`: string, globally unique, format `<table>:<uuidv7>` (table recoverable
  via `id.slice(0, id.lastIndexOf(":"))`).
- `_creationTime`: number, ms since epoch (float allowed).

## Validators (`v`)

`v.string()`, `v.number()` (alias `v.float64()`), `v.boolean()`, `v.null()`,
`v.any()`, `v.literal(x)`, `v.id(table)`, `v.array(item)`, `v.object(shape)`,
`v.record(valueValidator)`, `v.union(...members)`, `v.optional(inner)`.

Every validator is a frozen object:

```js
{ kind: "string" | "number" | ..., isOptional: boolean,
  validate(value, path = "") /* throws ValidationError */,
  toJSON() /* plain serializable description */ }
```

`ValidationError extends Error` with `.path` (e.g. `"args.author"`).
`validate(spec, value)` accepts a validator OR a plain object shape (treated as
`v.object(shape)`). `v.object` rejects unknown fields; `v.optional` fields may be
absent (never `undefined` stored).

## Function definitions

```js
query({ args?, handler })     // -> FunctionDef
mutation({ args?, handler })
action({ args?, handler })
internalQuery / internalMutation / internalAction  // same, visibility "internal"
```

`FunctionDef` is a frozen object:

```js
{ [IS_FUNCTION]: true, kind: "query" | "mutation" | "action",
  visibility: "public" | "internal", args: Validator | undefined,
  handler: (ctx, args) => any }
```

`IS_FUNCTION = Symbol.for("rebendei.function")`. `isFunctionDef(x)` is exported.
Internal functions are callable only from other functions (`ctx.runQuery` etc.)
and the scheduler, never from HTTP/WebSocket clients.

## Schema

```js
defineSchema({ messages: defineTable({ body: v.string(), channel: v.id("channels"),
                                       embedding: v.optional(v.array(v.number())) })
  .index("by_channel", ["channel"])
  .vectorIndex("by_embedding", { vectorField: "embedding", dimensions: 1536, filterFields: ["channel"] }) },
  { schemaValidation: true })
```

Result shape (plain, serializable except validators):

```js
{ schemaValidation: boolean,
  tables: { [name]: { validator: ObjectValidator,
                      indexes: [{ name, fields: string[] }],
                      vectorIndexes: [{ name, vectorField, dimensions, filterFields }] } } }
```

Every table implicitly has index `by_id` (`["_id"]`) and `by_creation_time`
(`["_creationTime"]`); every user index implicitly ends with `_creationTime` as a
tiebreak. Tables not in the schema are allowed (untyped) when a schema exists
only if `schemaValidation` is false; with no schema file, all tables are untyped.

## Function context

```js
// query
ctx = { db: DatabaseReader }
// mutation
ctx = { db: DatabaseWriter, scheduler }
// action
ctx = { runQuery(path, args), runMutation(path, args), runAction(path, args),
        scheduler, vectorSearch(table, indexName, { vector, limit = 10, filter? }) }
```

`DatabaseReader`:

- `get(id)` → doc or `null`
- `query(table)` → `QueryInitializer`:
  - `.withIndex(name, (q) => q.eq(f, v)... .gt/.gte(f, v) .lt/.lte(f, v))` — eq on a
    prefix of index fields, then at most one lower and one upper bound on the next field
  - `.order("asc" | "desc")`
  - `.filter((doc) => boolean)` — JS predicate, applied after the index range
  - terminal: `.collect()`, `.take(n)`, `.first()`, `.unique()` (throws on >1),
    `.paginate({ numItems, cursor })` → `{ page, isDone, continueCursor }`,
    and `for await (const doc of q)`
  - with no `withIndex`, the range is the whole table in `by_creation_time` order

`DatabaseWriter` adds: `insert(table, value)` → id, `patch(id, partial)` (a field
set to `undefined` is removed), `replace(id, value)`, `delete(id)`.

Queries must be deterministic: `Math.random`/`Date.now` are allowed but results
are cached and re-run only on invalidation.

## Transactions and time

- A mutation runs in one Postgres `SERIALIZABLE` transaction and is retried on
  serialization failure (SQLSTATE `40001`/`40P01`) up to 8 times with jitter.
- Commit timestamp: taken as the last step of the transaction, under
  `pg_advisory_xact_lock(<REBENDEI_COMMIT_LOCK>)`, from sequence `commit_ts`, so
  timestamp order equals commit order.
- Each commit writes one row to `commits(ts bigint primary key, writes jsonb,
  created_at timestamptz default now())`, then `NOTIFY rebendei_commit, '<ts>'`.
- A query runs in a `REPEATABLE READ READ ONLY` transaction and reports the
  snapshot timestamp `ts = max(commits.ts)` visible to it (0 if none).
- Timestamps cross the wire as decimal strings.

## Read sets, write sets, invalidation

```js
ReadSet  = { ranges: [{ table, index, fields: string[], lower: Bound|null, upper: Bound|null }] }
Bound    = { key: JsonValue[], inclusive: boolean }   // key is a prefix of index fields
Write    = { table, id, oldDoc: Doc|null, newDoc: Doc|null }
```

### Index storage

Documents live in `documents(table_name, id, value jsonb, creation_time
double precision)`. Every index (implicit and user) is materialised in
`index_entries(table_name text, index_name text, key bytea, doc_id text,
primary key (table_name, index_name, key, doc_id))`. `key` is the
**order-preserving binary encoding** of the index field values followed by
`_creationTime` and `_id` (`encodeKey(values)` in `src/engine/keys.js`), so an
index range is a plain `key >= $lo AND key < $hi` scan and
`compareKeys(a, b) === Buffer.compare(encodeKey(a), encodeKey(b))` matches
Postgres `bytea` ordering exactly. Type order: missing/undefined < null <
number < boolean < string < array < object. Index entries are rewritten in the
same transaction as the document. Adding an index to the schema backfills it on
`load()`.

`db.get(id)` records a `by_id` range with equal inclusive bounds. A query with
`take`/`first`/`paginate` may narrow its recorded range to the part actually
scanned. `readSetOverlaps(readSet, writes)` is true when any write's old or new
doc has an index key inside any recorded range of its table. Key comparison
follows the total order in `src/engine/keys.js` (`compareKeys`), which must match
the SQL ordering used for index scans.

## Engine (`src/engine/index.js`)

```js
const engine = await createEngine({ sql, functionsDir })
engine.load()                       // (re)load modules, schema, crons; push indexes
engine.runQuery(path, args, { internal = false })    -> { value, readSet, ts }
engine.runMutation(path, args, { internal = false }) -> { value, ts, writes }
engine.runAction(path, args, { internal = false })   -> { value }
engine.onCommit((ts, writes) => void) -> unsubscribe  // local commits
engine.hooks.onWrite.push(async (tx, write) => {})    // inside the mutation txn
engine.hooks.onSchema.push(async (sql, schema) => {}) // after load()
engine.hooks.onLoad.push(async (engine) => {})        // after load(), crons etc.
engine.extendCtx.push((kind, ctx, meta) => {})       // add ctx fields
engine.close()
```

Errors: user errors surface as `{ message }`; a `ConvexError`-style
`RebendeiError(data)` export in `rebendei/server` carries `data` to the client.

## HTTP API

`POST /api/query`, `/api/mutation`, `/api/action`, body `{ path, args }`.

- 200 `{ status: "success", value, ts? }`
- 400 `{ status: "error", errorMessage, errorData? }` (validation, user error)
- 404 `{ status: "error", errorMessage }` unknown or internal function
- `GET /health` → `{ ok, database, pgvector }`

## Sync protocol (`GET /sync`, WebSocket, JSON text frames)

Client → server:

```js
{ type: "subscribe", queryId: number, path, args }
{ type: "unsubscribe", queryId }
{ type: "mutation", requestId: number, path, args }
{ type: "action", requestId: number, path, args }
```

Server → client:

```js
{ type: "hello", server: "rebendei", version }
{ type: "transition", ts: string,
  modifications: [ { type: "updated", queryId, value }
                 | { type: "error", queryId, errorMessage, errorData? }
                 | { type: "removed", queryId } ] }
{ type: "mutationResult", requestId, success: true, value, ts: string }
{ type: "mutationResult", requestId, success: false, errorMessage, errorData? }
{ type: "actionResult", requestId, success: true, value }
{ type: "actionResult", requestId, success: false, errorMessage, errorData? }
{ type: "fatal", errorMessage }   // server closes after sending
```

Guarantees:

- Every `subscribe` gets exactly one first `updated`/`error` for that `queryId`.
- A `transition` carries all changed query results at one `ts`; within a
  connection `ts` never decreases. Unchanged results are not re-sent.
- `mutationResult.ts` is the commit ts. The server sends a transition with
  `ts >= mutationResult.ts` covering all affected subscriptions of that
  connection *before* it sends the `mutationResult`, so a client that resolves
  the mutation promise on `mutationResult` always already shows its own write.
- Subscriptions are re-run only when `readSetOverlaps` says a commit may have
  changed them (commits from any process, via `LISTEN rebendei_commit`).

## Scheduler and crons

```js
ctx.scheduler.runAfter(delayMs, path, args) -> jobId
ctx.scheduler.runAt(timestampMsOrDate, path, args) -> jobId
ctx.scheduler.cancel(jobId)
```

In a mutation, scheduling is transactional (job row written in the same txn).
Target may be a mutation or action (public or internal). Jobs live in
`scheduled_jobs`; workers claim with `FOR UPDATE SKIP LOCKED`, so several
processes can run. Mutations run exactly once; actions at most once
(state `inProgress` → `success`/`failed`).

```js
// rebendei/crons.js
import { cronJobs } from "rebendei/server";
const crons = cronJobs();
crons.interval("cleanup", { minutes: 5 }, "messages:cleanup", {});
crons.cron("digest", "0 9 * * *", "mail:digest", {});   // UTC, 5-field
crons.hourly("x", { minuteUTC: 0 }, path, args); crons.daily("y", { hourUTC: 9, minuteUTC: 0 }, path, args);
export default crons;
```

## Vector search

Each `vectorIndex` gets its own table `rv_<table>__<index>` with
`(doc_id text primary key, embedding vector(<dimensions>), filter jsonb)` and an
HNSW index (`vector_cosine_ops`). Rows are maintained by an `onWrite` hook in the
same transaction as the document write. `ctx.vectorSearch(table, index,
{ vector, limit, filter })` (actions only) returns `[{ _id, _score }]`, score =
cosine similarity; `filter` is `(q) => q.eq(field, value)` or `q.or(...)` over
declared `filterFields`.

## Migrations

`packages/rebendei/migrations/NNNN_name.sql`, applied in order by `migrate()`.
Numbers are assigned per work item; never renumber a landed migration.
