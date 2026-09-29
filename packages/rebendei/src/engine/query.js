import { tableIndexes } from "./indexes.js";
import { encodedBound } from "./read-set.js";
import { encodeKey, documentKey } from "./keys.js";
/** @typedef {import('./types.js').Range} Range */
export class RangeBuilder {
  /** @param {string[]} fields */
  constructor(fields) {
    this.fields = fields;
    /** @type {any[]} */ this.prefix = [];
    /** @type {import('./types.js').Bound|null} */ this.lower = null;
    /** @type {import('./types.js').Bound|null} */ this.upper = null;
    this.ranged = false;
  }
  /** @param {string} field @param {any} value */
  eq(field, value) {
    if (this.ranged || field !== this.fields[this.prefix.length]) throw new Error("eq must follow the index prefix");
    encodeKey([value]); this.prefix.push(value); return this;
  }
  /** @param {string} field @param {any} value @param {boolean} lower @param {boolean} inclusive */
  bound(field, value, lower, inclusive) {
    if (field !== this.fields[this.prefix.length]) throw new Error("Range must bound the next index field");
    if (lower ? this.lower : this.upper) throw new Error("Duplicate range bound");
    encodeKey([value]); this.ranged = true;
    const bound = { key: [...this.prefix, value], inclusive };
    if (lower) this.lower = bound; else this.upper = bound;
    return this;
  }
  /** @param {string} f @param {any} v */ gt(f, v) { return this.bound(f, v, true, false); }
  /** @param {string} f @param {any} v */ gte(f, v) { return this.bound(f, v, true, true); }
  /** @param {string} f @param {any} v */ lt(f, v) { return this.bound(f, v, false, false); }
  /** @param {string} f @param {any} v */ lte(f, v) { return this.bound(f, v, false, true); }
}
export class Query {
  /** @param {import('./types.js').Connection} tx @param {import('../schema.js').Schema|null} schema @param {string} table @param {(range:Range)=>void} recordRead */
  constructor(tx, schema, table, recordRead) {
    this.tx = tx; this.schema = schema; this.table = table; this.recordRead = recordRead;
    /** @type {'asc'|'desc'} */ this.direction = "asc";
    /** @type {((doc:import('./types.js').Doc)=>boolean)[]} */ this.predicates = [];
    this.range = /** @type {Range} */ ({ table, index: "by_creation_time", fields: ["_creationTime"], lower: null, upper: null });
    this.indexSelected = false;
  }
  /** @param {string} name @param {(q:RangeBuilder)=>RangeBuilder|void} [build] */
  withIndex(name, build) {
    if (this.indexSelected) throw new Error("Index already selected");
    const index = tableIndexes(this.schema, this.table).find((i) => i.name === name);
    if (!index) throw new Error(`Unknown index: ${this.table}.${name}`);
    const builder = new RangeBuilder(index.fields); build?.(builder);
    const prefix = builder.prefix.length ? { key: [...builder.prefix], inclusive: true } : null;
    this.range = { table: this.table, index: name, fields: [...index.fields], lower: builder.lower ?? prefix, upper: builder.upper ?? prefix };
    this.indexSelected = true;
    return this;
  }
  /** @param {'asc'|'desc'} direction */
  order(direction) { if (direction !== "asc" && direction !== "desc") throw new Error("Invalid order"); this.direction = direction; return this; }
  /** @param {(doc:import('./types.js').Doc)=>boolean} predicate */
  filter(predicate) { this.predicates.push(predicate); return this; }
  /** Build the SQL scope once. New cursors carry lossless key values so read
   * ranges can exclude earlier pages even if the cursor document was deleted.
   * Legacy key-only cursors still work, with a conservative starting bound.
   * @param {string|null} [cursor] */
  prepare(cursor = null) {
    const range = structuredClone(this.range);
    const lo = encodedBound(range.lower, true), hi = encodedBound(range.upper, false);
    /** @type {any[]} */ const params = [this.table, range.index];
    let where = "e.table_name = $1 AND e.index_name = $2";
    if (lo) { params.push(lo); where += ` AND e.key >= $${params.length}`; }
    if (hi) { params.push(hi); where += ` AND e.key < $${params.length}`; }
    const scope = JSON.stringify([this.table, range.index, this.direction, lo?.toString("hex"), hi?.toString("hex")]);
    /** @type {Buffer|null} */ let after = null;
    if (cursor !== null) {
      let parsed;
      try { parsed = JSON.parse(Buffer.from(cursor, "base64url").toString()); } catch { throw new Error("Invalid cursor"); }
      if (!parsed || parsed.scope !== scope || typeof parsed.key !== "string" || !/^(?:[0-9a-f]{2})+$/.test(parsed.key)) throw new Error("Cursor does not match query");
      after = Buffer.from(parsed.key, "hex");
      if (parsed.values !== undefined) {
        try {
          if (!Array.isArray(parsed.values) || !parsed.values.every((/** @type {any} */ v) => Array.isArray(v) && v.length <= 1)) throw new Error();
          const key = parsed.values.map((/** @type {any[]} */ v) => v[0]);
          const keyLength = range.fields.length + (range.fields.includes("_creationTime") ? 1 : 2);
          if (key.length !== keyLength || !encodeKey(key).equals(after)) throw new Error();
          const bound = { key, inclusive: false };
          // Do not widen the declared query range for a forged out-of-range cursor.
          if (this.direction === "asc" && (!lo || Buffer.compare(after, lo) >= 0)) range.lower = bound;
          if (this.direction === "desc" && (!hi || Buffer.compare(after, hi) < 0)) range.upper = bound;
        } catch { throw new Error("Invalid cursor key values"); }
      }
    }
    return { scope, range, params, where, after };
  }
  /** Incremental keyset scans, with SQL LIMIT even for collect/iteration. Each
   * batch records the scanned prefix including rejected predicate candidates.
   * A short batch proves exhaustion and records through the end of the range.
   * Record before yielding so early iterator termination still retains reads.
   * @param {ReturnType<Query['prepare']>} prepared @param {number} [count] */
  async *scan(prepared, count = Infinity) {
    const { range, params, where } = prepared;
    let after = prepared.after, remaining = count;
    let batchSize = this.predicates.length || !Number.isFinite(count) ? 64 : count;
    while (remaining > 0) {
      const bindings = [...params]; let clause = where;
      if (after) { bindings.push(after); clause += ` AND e.key ${this.direction === "asc" ? ">" : "<"} $${bindings.length}`; }
      bindings.push(batchSize);
      const rows = await this.tx.unsafe(`SELECT d.id, d.value, d.creation_time, e.key FROM index_entries e JOIN documents d ON d.table_name = e.table_name AND d.id = e.doc_id WHERE ${clause} ORDER BY e.key ${this.direction.toUpperCase()}, e.doc_id ${this.direction.toUpperCase()} LIMIT $${bindings.length}`, bindings);
      /** @type {{key:string, doc:import('./types.js').Doc}[]} */
      const batch = rows.map((/** @type {any} */ row) => ({ key: Buffer.from(row.key).toString("hex"),
        doc: { ...row.value, _id: row.id, _creationTime: Number(row.creation_time) } }));
      const exhausted = batch.length < batchSize, last = batch.at(-1);
      const scanned = structuredClone(range);
      if (!exhausted && last) {
        const bound = { key: documentKey(last.doc, range.fields), inclusive: true };
        if (this.direction === "asc") scanned.upper = bound; else scanned.lower = bound;
      }
      this.recordRead(scanned);
      for (const row of batch) {
        if (!this.predicates.every(p => p(row.doc))) continue;
        remaining--; yield row;
        if (remaining === 0) return;
      }
      if (exhausted) return;
      after = last ? Buffer.from(last.key, "hex") : after;
      batchSize = Math.min(batchSize * 2, 1024);
    }
  }
  async collect() {
    const docs = [];
    for await (const row of this.scan(this.prepare())) docs.push(row.doc);
    return docs;
  }
  /** @param {number} count */
  async take(count) {
    checkCount(count, true);
    const docs = [];
    if (count) for await (const row of this.scan(this.prepare(), count)) docs.push(row.doc);
    return docs;
  }
  async first() { return (await this.take(1))[0] ?? null; }
  async unique() { const docs = await this.take(2); if (docs.length > 1) throw new Error("unique() found more than one document"); return docs[0] ?? null; }
  /** @param {{numItems:number,cursor?:string|null}} options */
  async paginate({ numItems, cursor = null }) {
    checkCount(numItems, false);
    const prepared = this.prepare(cursor), rows = [];
    for await (const row of this.scan(prepared, numItems + 1)) rows.push(row);
    const selected = rows.slice(0, numItems), last = selected.at(-1);
    return { page: selected.map(row => row.doc), isDone: rows.length <= numItems,
      continueCursor: last ? Buffer.from(JSON.stringify({ scope: prepared.scope, key: last.key,
        values: documentKey(last.doc, this.range.fields).map(v => v === undefined ? [] : [v]) })).toString("base64url") : cursor ?? "" };
  }
  async *[Symbol.asyncIterator]() { for await (const row of this.scan(this.prepare())) yield row.doc; }
}
/** @param {number} count @param {boolean} allowZero */
function checkCount(count, allowZero) {
  if (!Number.isSafeInteger(count) || count < (allowZero ? 0 : 1) || count > 8192) throw new Error("Invalid item count: must be an integer " + (allowZero ? "between 0" : "between 1") + " and 8192");
}
