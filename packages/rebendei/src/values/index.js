/** JSON-compatible application values (portable to browsers and Node). */
export class ValidationError extends Error {
  /** @param {string} message @param {string} [path] */
  constructor(message, path = "") {
    super(`${path || "value"}: ${message}`);
    this.name = "ValidationError";
    this.path = path;
  }
}
/** @typedef {{kind:string, isOptional:boolean, validate:(value:any,path?:string)=>void, toJSON:()=>any}} Validator */
/** @param {unknown} value */
export function isPlainObject(value) {
  return value !== null && typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
/** @param {string} path @param {string | number} field */
const at = (path, field) => path ? `${path}.${field}` : String(field);
/** @param {any} value @param {string} [path] @param {Set<object>} [seen] */
export function assertValue(value, path = "", seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || (!Array.isArray(value) && !isPlainObject(value)))
    throw new ValidationError("expected a JSON value", path);
  if (seen.has(value)) throw new ValidationError("cyclic value", path);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertValue(value[i], at(path, i), seen);
  } else {
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith("_")) throw new ValidationError("reserved field name", at(path, key));
      assertValue(child, at(path, key), seen);
    }
  }
  seen.delete(value);
}
/** @param {string} kind @param {(value:any,path:string)=>void} check @param {any} [description] @param {boolean} [isOptional] @returns {Validator} */
function validator(kind, check, description = {}, isOptional = false) {
  return Object.freeze({ kind, isOptional, validate(value, path = "") { check(value, path); },
    toJSON() { return { kind, isOptional, ...description }; } });
}
/** @param {boolean} ok @param {string} expected @param {string} path */
function requireType(ok, expected, path) {
  if (!ok) throw new ValidationError(`expected ${expected}`, path);
}
/** @param {Validator|Record<string,Validator>} spec @returns {Validator} */
export function asValidator(spec) {
  if (spec && typeof spec.validate === "function") return /** @type {Validator} */ (spec);
  return v.object(/** @type {Record<string,Validator>} */ (spec));
}
/** @param {Validator|Record<string,Validator>} spec @param {any} value */
export function validate(spec, value) { asValidator(spec).validate(value); return value; }
const number = () => validator("number", (x, p) => requireType(typeof x === "number" && Number.isFinite(x), "finite number", p));
export const v = Object.freeze({
  string: () => validator("string", (x, p) => requireType(typeof x === "string", "string", p)),
  number, float64: number,
  boolean: () => validator("boolean", (x, p) => requireType(typeof x === "boolean", "boolean", p)),
  null: () => validator("null", (x, p) => requireType(x === null, "null", p)),
  any: () => validator("any", (x, p) => assertValue(x, p)),
  /** @param {any} value */
  literal(value) {
    assertValue(value);
    const frozenValue = JSON.stringify(value);
    return validator("literal", (x, p) => requireType(JSON.stringify(x) === frozenValue, frozenValue, p), { value: JSON.parse(frozenValue) });
  },
  /** @param {string} table */
  id: (table) => validator("id", (x, p) => requireType(typeof x === "string" && x.startsWith(`${table}:`) && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x.slice(table.length + 1)), `id of ${table}`, p), { table }),
  /** @param {Validator} item */
  array: (item) => validator("array", (x, p) => {
    requireType(Array.isArray(x), "array", p);
    for (let i = 0; i < x.length; i++) item.validate(x[i], at(p, i));
  }, { item: item.toJSON() }),
  /** @param {Record<string,Validator>} shape */
  object(shape) {
    const fields = Object.freeze({ ...shape });
    return validator("object", (x, p) => {
      requireType(isPlainObject(x), "plain object", p);
      for (const key of Object.keys(x)) if (!Object.hasOwn(fields, key)) throw new ValidationError("unknown field", at(p, key));
      for (const [key, spec] of Object.entries(fields)) spec.validate(Object.hasOwn(x, key) ? x[key] : undefined, at(p, key));
    }, { fields: Object.fromEntries(Object.entries(fields).map(([k, s]) => [k, s.toJSON()])) });
  },
  /** @param {Validator} item */
  record: (item) => validator("record", (x, p) => {
    requireType(isPlainObject(x), "plain object", p);
    for (const [k, value] of Object.entries(x)) {
      if (k.startsWith("_")) throw new ValidationError("reserved field name", at(p, k));
      item.validate(value, at(p, k));
    }
  }, { value: item.toJSON() }),
  /** @param {Validator[]} members */
  union: (...members) => validator("union", (x, p) => {
    for (const member of members) { try { member.validate(x, p); return; } catch (e) { if (!(e instanceof ValidationError)) throw e; } }
    throw new ValidationError("no union member matched", p);
  }, { members: members.map((s) => s.toJSON()) }),
  /** @param {Validator} inner */
  optional: (inner) => validator("optional", (x, p) => { if (x !== undefined) inner.validate(x, p); }, { inner: inner.toJSON() }, true),
});
