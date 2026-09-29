import { tableIndexes } from "./indexes.js";
import { encodedBound } from "./read-set.js";
import { encodeKey } from "./keys.js";
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
  /** @param {string|null} [cursor] */
  async rows(cursor = null) {
    this.recordRead(structuredClone(this.range));
    const lo = encodedBound(this.range.lower, true), hi = encodedBound(this.range.upper, false);
    /** @type {any[]} */ const params = [this.table, this.range.index];
    let where = "e.table_name = $1 AND e.index_name = $2";
    if (lo) { params.push(lo); where += ` AND e.key >= $${params.length}`; }
    if (hi) { params.push(hi); where += ` AND e.key < $${params.length}`; }
    const scope = JSON.stringify([this.table, this.range.index, this.direction, lo?.toString("hex"), hi?.toString("hex")]);
    if (cursor !== null) {
      let parsed;
      try { parsed = JSON.parse(Buffer.from(cursor, "base64url").toString()); } catch { throw new Error("Invalid cursor"); }
      if (parsed.scope !== scope || typeof parsed.key !== "string" || !/^(?:[0-9a-f]{2})+$/.test(parsed.key)) throw new Error("Cursor does not match query");
      params.push(Buffer.from(parsed.key, "hex")); where += ` AND e.key ${this.direction === "asc" ? ">" : "<"} $${params.length}`;
    }
    const rows = await this.tx.unsafe(`SELECT d.id, d.value, d.creation_time, e.key FROM index_entries e JOIN documents d ON d.table_name = e.table_name AND d.id = e.doc_id WHERE ${where} ORDER BY e.key ${this.direction.toUpperCase()}, e.doc_id ${this.direction.toUpperCase()}`, params);
    return { scope, rows: rows.map((/** @type {any} */ row) => ({ key: Buffer.from(row.key).toString("hex"),
      doc: /** @type {import('./types.js').Doc} */ ({ ...row.value, _id: row.id, _creationTime: Number(row.creation_time) }) }))
      .filter((/** @type {{doc:import('./types.js').Doc}} */ row) => this.predicates.every((p) => p(row.doc))) };
  }
  async collect() { return (await this.rows()).rows.map((/** @type {any} */ row) => row.doc); }
  /** @param {number} count */
  async take(count) { checkCount(count, true); return (await this.collect()).slice(0, count); }
  async first() { return (await this.take(1))[0] ?? null; }
  async unique() { const docs = await this.take(2); if (docs.length > 1) throw new Error("unique() found more than one document"); return docs[0] ?? null; }
  /** @param {{numItems:number,cursor?:string|null}} options */
  async paginate({ numItems, cursor = null }) {
    checkCount(numItems, false);
    const { scope, rows } = await this.rows(cursor), selected = rows.slice(0, numItems), last = selected.at(-1);
    return { page: selected.map((/** @type {any} */ row) => row.doc), isDone: rows.length <= numItems,
      continueCursor: last ? Buffer.from(JSON.stringify({ scope, key: last.key })).toString("base64url") : cursor ?? "" };
  }
  async *[Symbol.asyncIterator]() { for (const doc of await this.collect()) yield doc; }
}
/** @param {number} count @param {boolean} allowZero */
function checkCount(count, allowZero) { if (!Number.isSafeInteger(count) || count < (allowZero ? 0 : 1)) throw new Error("Invalid item count"); }
