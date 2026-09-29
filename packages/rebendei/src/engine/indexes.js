import { documentKey, encodeKey } from "./keys.js";
/** @param {import('../schema.js').Schema|null} schema @param {string} table */
export function tableIndexes(schema, table) {
  return schema?.tables[table]?.indexes ?? [{ name: "by_id", fields: ["_id"] }, { name: "by_creation_time", fields: ["_creationTime"] }];
}
/** @param {import('./types.js').Connection} tx @param {import('../schema.js').Schema|null} schema @param {string} table @param {import('./types.js').Doc} doc */
export async function writeIndexes(tx, schema, table, doc) {
  await tx`DELETE FROM index_entries WHERE table_name = ${table} AND doc_id = ${doc._id}`;
  for (const index of tableIndexes(schema, table)) {
    const key = encodeKey(documentKey(doc, index.fields));
    await tx`INSERT INTO index_entries (table_name, index_name, key, doc_id) VALUES (${table}, ${index.name}, ${key}, ${doc._id})`;
  }
}
/** @param {import('bun').SQL} sql @param {import('../schema.js').Schema|null} schema */
export async function backfillIndexes(sql, schema) {
  await sql.begin(async (tx) => {
    await tx`LOCK TABLE documents IN SHARE ROW EXCLUSIVE MODE`;
    await tx`DELETE FROM index_entries`;
    const rows = await tx`SELECT table_name, id, value, creation_time FROM documents`;
    for (const row of rows) await writeIndexes(tx, schema, row.table_name,
      { ...row.value, _id: row.id, _creationTime: Number(row.creation_time) });
  });
}
