import { assertValue, isPlainObject, ValidationError } from "../values/index.js";
import { assertName } from "../schema.js";
import { writeIndexes } from "./indexes.js";
import { Query } from "./query.js";
/** @param {string} id */
function tableFromId(id) {
  if (typeof id !== "string" || id.lastIndexOf(":") <= 0) throw new Error("Invalid document id");
  return id.slice(0, id.lastIndexOf(":"));
}
/** @param {import('./types.js').Connection} tx @param {import('../schema.js').Schema|null} schema @param {'query'|'mutation'} kind @param {(range:import('./types.js').Range)=>void} recordRead @param {(write:import('./types.js').Write)=>Promise<void>} recordWrite */
export function createDatabase(tx, schema, kind, recordRead, recordWrite) {
  /** @param {string} table */
  function checkTable(table) {
    assertName(table);
    if (schema?.schemaValidation && !Object.hasOwn(schema.tables, table)) throw new Error(`Unknown schema table: ${table}`);
  }
  /** @param {string} table @param {any} value */
  function checkDocument(table, value) {
    checkTable(table);
    if (!isPlainObject(value)) throw new ValidationError("expected document object");
    assertValue(value);
    if (schema?.schemaValidation) schema.tables[table].validator.validate(value);
  }
  /** @param {string} id @returns {Promise<import('./types.js').Doc|null>} */
  async function get(id) {
    const table = tableFromId(id); checkTable(table);
    recordRead({ table, index: "by_id", fields: ["_id"], lower: { key: [id], inclusive: true }, upper: { key: [id], inclusive: true } });
    const [row] = await tx`SELECT value, creation_time FROM documents WHERE table_name = ${table} AND id = ${id}`;
    return row ? { ...row.value, _id: id, _creationTime: Number(row.creation_time) } : null;
  }
  const reader = {
    get,
    /** @param {string} table */
    query(table) { checkTable(table); return new Query(tx, schema, table, recordRead); },
  };
  if (kind === "query") return reader;
  /** @param {string} table @param {import('./types.js').Doc|null} oldDoc @param {import('./types.js').Doc|null} newDoc @param {string} id */
  async function write(table, oldDoc, newDoc, id) {
    if (newDoc) {
      const { _id, _creationTime, ...value } = newDoc;
      await tx`INSERT INTO documents (table_name, id, value, creation_time) VALUES (${table}, ${id}, ${value}::jsonb, ${_creationTime}) ON CONFLICT (table_name, id) DO UPDATE SET value = EXCLUDED.value`;
      await writeIndexes(tx, schema, table, newDoc);
    } else {
      await tx`DELETE FROM index_entries WHERE table_name = ${table} AND doc_id = ${id}`;
      await tx`DELETE FROM documents WHERE table_name = ${table} AND id = ${id}`;
    }
    await recordWrite({ table, id, oldDoc, newDoc });
  }
  return { ...reader,
    /** @param {string} table @param {any} value */
    async insert(table, value) {
      checkDocument(table, value);
      const id = `${table}:${Bun.randomUUIDv7()}`;
      await write(table, null, { ...structuredClone(value), _id: id, _creationTime: Date.now() }, id);
      return id;
    },
    /** @param {string} id @param {Record<string,any>} partial */
    async patch(id, partial) {
      if (!isPlainObject(partial)) throw new ValidationError("expected patch object");
      const oldDoc = await get(id); if (!oldDoc) throw new Error(`Document not found: ${id}`);
      const { _id, _creationTime, ...value } = oldDoc;
      for (const [key, child] of Object.entries(partial)) {
        if (key.startsWith("_")) throw new ValidationError("reserved field name", key);
        if (child === undefined) delete value[key]; else value[key] = child;
      }
      const table = tableFromId(id); checkDocument(table, value);
      await write(table, oldDoc, { ...structuredClone(value), _id, _creationTime }, id);
    },
    /** @param {string} id @param {any} value */
    async replace(id, value) {
      const table = tableFromId(id); checkDocument(table, value);
      const oldDoc = await get(id); if (!oldDoc) throw new Error(`Document not found: ${id}`);
      await write(table, oldDoc, { ...structuredClone(value), _id: id, _creationTime: oldDoc._creationTime }, id);
    },
    /** @param {string} id */
    async delete(id) { const table = tableFromId(id), oldDoc = await get(id); if (oldDoc) await write(table, oldDoc, null, id); },
  };
}
