import { asValidator } from "./values/index.js";
/** @typedef {{name:string,fields:string[]}} Index */
/** @typedef {{name:string,vectorField:string,dimensions:number,filterFields:string[]}} VectorIndex */
/** @typedef {{validator:import('./values/index.js').Validator,indexes:Index[],vectorIndexes:VectorIndex[]}} Table */
/** @typedef {{schemaValidation:boolean,tables:Record<string,Table>}} Schema */
/** @param {string} name */
export function assertName(name) {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid name: ${name}`);
}
/** @param {import('./values/index.js').Validator|Record<string,import('./values/index.js').Validator>} shape */
export function defineTable(shape) {
  const validator = asValidator(shape);
  if (validator.kind !== "object") throw new Error("Table validator must be an object");
  /** @type {Index[]} */
  const indexes = [{ name: "by_id", fields: ["_id"] }, { name: "by_creation_time", fields: ["_creationTime"] }];
  /** @type {VectorIndex[]} */
  const vectorIndexes = [];
  const table = {
    validator, indexes, vectorIndexes,
    /** @param {string} name @param {string[]} fields */
    index(name, fields) {
      assertName(name);
      if (indexes.some((i) => i.name === name) || vectorIndexes.some((i) => i.name === name)) throw new Error(`Duplicate index: ${name}`);
      if (!fields.length || new Set(fields).size !== fields.length) throw new Error("Index requires distinct fields");
      indexes.push({ name, fields: [...fields.filter((f) => f !== "_creationTime"), "_creationTime"] });
      return table;
    },
    /** @param {string} name @param {{vectorField:string,dimensions:number,filterFields?:string[]}} options */
    vectorIndex(name, options) {
      assertName(name);
      if (indexes.some((i) => i.name === name) || vectorIndexes.some((i) => i.name === name)) throw new Error(`Duplicate index: ${name}`);
      if (!Number.isInteger(options.dimensions) || options.dimensions <= 0) throw new Error("Invalid vector dimensions");
      vectorIndexes.push({ name, ...options, filterFields: [...(options.filterFields ?? [])] });
      return table;
    },
  };
  return table;
}
/** @param {Record<string,Table>} tables @param {{schemaValidation?:boolean}} [options] @returns {Schema} */
export function defineSchema(tables, options = {}) {
  for (const name of Object.keys(tables)) assertName(name);
  return { schemaValidation: options.schemaValidation ?? true,
    tables: Object.fromEntries(Object.entries(tables).map(([name, table]) => [name,
      { validator: table.validator, indexes: table.indexes.map((i) => ({ name: i.name, fields: [...i.fields] })),
        vectorIndexes: table.vectorIndexes.map((i) => ({ ...i, filterFields: [...i.filterFields] })) }])) };
}
