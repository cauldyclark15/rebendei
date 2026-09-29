import { createHash } from "node:crypto";
import { compileFilter } from "./filter.js";
/** @typedef {import('../schema.js').VectorIndex & {table:string,pgTable:string}} MaterializedIndex */
/** @typedef {import('../engine/types.js').Connection} Connection */

/** Quote every dynamic identifier, including names read from the registry. @param {string} name */
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
/** @param {string} value */
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
/** @param {string} raw @param {boolean} [hashRequired] */
function identifier(raw, hashRequired = false) {
  const safe = raw.replace(/[^A-Za-z0-9_]/g, "_");
  if (!hashRequired && safe === raw && safe.length <= 63) return safe;
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return `${safe.slice(0, 46)}_${hash}`;
}
/** Stable ASCII identifiers, bounded by Postgres's 63-byte limit; disambiguate __ in components.
 * @param {string} table @param {string} index */
export function vectorTableName(table, index) {
  const raw = `rv_${table}__${index}`;
  if (table.includes("__") || index.includes("__")) {
    const hash = createHash("sha256").update(JSON.stringify([table, index])).digest("hex").slice(0, 16);
    return `${raw.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 46)}_${hash}`;
  }
  return identifier(raw);
}
/** @param {Record<string,any>} doc @param {string} path */
function field(doc, path) {
  let value = doc;
  for (const part of path.split(".")) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
}
/** pgvector stores float32, not JS float64. @param {any} vector @param {number} dimensions */
function isVector(vector, dimensions) {
  return Array.isArray(vector) && vector.length === dimensions &&
    vector.every((value) => typeof value === "number" && Number.isFinite(value) && Number.isFinite(Math.fround(value)));
}
/** @param {any} vector @param {MaterializedIndex} index */
function validateVector(vector, index) {
  if (!isVector(vector, index.dimensions)) throw new Error(
    `Vector index ${index.table}.${index.name}: ${index.vectorField} must be an array of ${index.dimensions} finite float32 numbers`);
}
/** @param {Connection} tx @param {MaterializedIndex} index @param {string} id @param {Record<string,any>|null} doc @param {boolean} [backfill] */
async function writeRow(tx, index, id, doc, backfill = false) {
  const embedding = doc ? field(doc, index.vectorField) : undefined;
  if (embedding === undefined || (backfill && !isVector(embedding, index.dimensions))) {
    await tx.unsafe(`DELETE FROM ${quote(index.pgTable)} WHERE doc_id = $1`, [id]);
    return;
  }
  // Schema validation already rejects invalid types where a validator specifies them.
  // v.array(v.number()) cannot enforce length, so present-but-invalid vectors always
  // throw here (including schemaValidation:false), rolling back the entire mutation.
  validateVector(embedding, index);
  const filter = Object.fromEntries(index.filterFields.flatMap((name) => {
    const value = field(/** @type {Record<string,any>} */ (doc), name);
    return value === undefined ? [] : [[name, value]];
  }));
  await tx.unsafe(`INSERT INTO ${quote(index.pgTable)} (doc_id, embedding, filter)
    VALUES ($1, $2::vector, $3::text::jsonb) ON CONFLICT (doc_id) DO UPDATE
    SET embedding = EXCLUDED.embedding, filter = EXCLUDED.filter`, [id, JSON.stringify(embedding), JSON.stringify(filter)]);
}
/** @param {import('bun').TransactionSQL} tx @param {MaterializedIndex} index */
async function createIndex(tx, index) {
  const table = quote(index.pgTable);
  await tx.unsafe(`CREATE TABLE ${table} (doc_id text PRIMARY KEY, embedding vector(${index.dimensions}) NOT NULL, filter jsonb NOT NULL)`);
  await tx.unsafe(`CREATE INDEX ${quote(identifier(`${index.pgTable}_hnsw`))} ON ${table} USING hnsw (embedding vector_cosine_ops)`);
  await tx.unsafe(`CREATE INDEX ${quote(identifier(`${index.pgTable}_filter`))} ON ${table} USING gin (filter)`);
  for (const [position, name] of index.filterFields.entries()) {
    await tx.unsafe(`CREATE INDEX ${quote(identifier(`${index.pgTable}_f${position}`))} ON ${table} ((filter -> ${literal(name)}))`);
  }
  const docs = await tx`SELECT id, value, creation_time FROM documents WHERE table_name = ${index.table}`;
  for (const doc of docs) await writeRow(tx, index, doc.id,
    { ...doc.value, _id: doc.id, _creationTime: Number(doc.creation_time) }, true);
  await tx`INSERT INTO vector_indexes (table_name, index_name, dimensions, vector_field, filter_fields, pg_table_name)
    VALUES (${index.table}, ${index.name}, ${index.dimensions}, ${index.vectorField}, ${JSON.stringify(index.filterFields)}::text::jsonb, ${index.pgTable})`;
}
/** @param {import('../schema.js').Schema|null} schema */
function definitions(schema) {
  /** @type {MaterializedIndex[]} */ const result = [];
  for (const [table, definition] of Object.entries(schema?.tables ?? {})) {
    for (const index of definition.vectorIndexes) {
      // pgvector's vector HNSW operator class supports at most 2000 dimensions.
      if (!Number.isInteger(index.dimensions) || index.dimensions < 1 || index.dimensions > 2000)
        throw new Error(`Vector index ${table}.${index.name}: HNSW vector dimensions must be between 1 and 2000`);
      if (typeof index.vectorField !== "string" || !index.vectorField.length ||
          index.filterFields.some((name) => typeof name !== "string" || !name.length) ||
          new Set(index.filterFields).size !== index.filterFields.length)
        throw new Error(`Vector index ${table}.${index.name}: requires a vectorField and distinct filterFields`);
      result.push({ ...index, table, pgTable: vectorTableName(table, index.name), filterFields: [...index.filterFields] });
    }
  }
  return result;
}

/** Materialize schema definitions and install transactional maintenance/action context.
 * @param {Awaited<ReturnType<typeof import('../engine/index.js').createEngine>>} engine */
export async function install(engine) {
  /** @type {MaterializedIndex[]} */ let indexes = [];
  engine.hooks.onSchema.push(async (sql, schema) => {
    const next = definitions(schema);
    await sql.begin(async (tx) => {
      // Serialize schema reconciliations; block document writes through backfill so
      // no write can slip between the snapshot and creation of the physical index.
      await tx`LOCK TABLE vector_indexes IN EXCLUSIVE MODE`;
      await tx`LOCK TABLE documents IN SHARE MODE`;
      const existing = await tx`SELECT * FROM vector_indexes`;
      const wanted = new Map(next.map((index) => [JSON.stringify([index.table, index.name]), index]));
      const retained = new Set();
      for (const row of existing) {
        const key = JSON.stringify([row.table_name, row.index_name]);
        const expected = wanted.get(key);
        if (expected && expected.dimensions === row.dimensions && expected.vectorField === row.vector_field &&
            expected.pgTable === row.pg_table_name && JSON.stringify(expected.filterFields) === JSON.stringify(row.filter_fields)) {
          retained.add(key); continue;
        }
        await tx.unsafe(`DROP TABLE ${quote(row.pg_table_name)}`);
        await tx`DELETE FROM vector_indexes WHERE table_name = ${row.table_name} AND index_name = ${row.index_name}`;
      }
      for (const index of next) if (!retained.has(JSON.stringify([index.table, index.name]))) await createIndex(tx, index);
    });
    indexes = next;
  });
  engine.hooks.onWrite.push(async (tx, write) => {
    for (const index of indexes) if (index.table === write.table) await writeRow(tx, index, write.id, write.newDoc);
  });
  engine.extendCtx.push((kind, ctx) => {
    if (kind !== "action") return;
    /** @param {string} table @param {string} indexName
     * @param {{vector:number[],limit?:number,filter?:(q:import('./filter.js').FilterBuilder)=>import('./filter.js').FilterNode}} options */
    ctx.vectorSearch = async (table, indexName, { vector, limit = 10, filter }) => {
      const index = indexes.find((candidate) => candidate.table === table && candidate.name === indexName);
      if (!index) throw new Error(`Unknown vector index: ${table}.${indexName}`);
      validateVector(vector, index);
      if (!vector.some((value) => Math.fround(value) !== 0)) throw new Error("Vector search requires a nonzero vector for cosine similarity");
      if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw new Error("Vector search limit must be an integer between 1 and 256");
      /** @type {any[]} */ const parameters = [JSON.stringify(vector)];
      const predicate = compileFilter(index.filterFields, filter, parameters);
      // Zero vectors are valid stored embeddings, but cosine is undefined for
      // them. Exclude NaN distances on seq scans as well as on HNSW scans.
      const where = ` WHERE (embedding <=> $1::vector) < 'NaN'::double precision${predicate ? ` AND ${predicate}` : ""}`;
      parameters.push(limit);
      return engine.sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL hnsw.ef_search = ${Math.max(limit * 2, 40)}`);
        // Iterative scans avoid losing matches when an HNSW candidate is filtered.
        await tx`SET LOCAL hnsw.iterative_scan = 'strict_order'`;
        const rows = await tx.unsafe(`SELECT doc_id AS "_id", 1 - (embedding <=> $1::vector) AS "_score"
          FROM ${quote(index.pgTable)}${where} ORDER BY embedding <=> $1::vector ASC LIMIT $${parameters.length}`, parameters);
        return rows.map((/** @type {{_id:string,_score:number}} */ row) => ({ _id: row._id, _score: Number(row._score) }));
      });
    };
  });
}
