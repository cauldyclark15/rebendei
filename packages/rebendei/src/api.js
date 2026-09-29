import { asValidator } from "./values/index.js";
export { v } from "./values/index.js";
export { defineSchema, defineTable } from "./schema.js";
export const IS_FUNCTION = Symbol.for("rebendei.function");
/** @typedef {'query'|'mutation'|'action'} FunctionKind */
/** @typedef {{[IS_FUNCTION]:true,kind:FunctionKind,visibility:'public'|'internal',args:import('./values/index.js').Validator|undefined,handler:(ctx:any,args:any)=>any}} FunctionDef */
/** @typedef {{args?:import('./values/index.js').Validator|Record<string,import('./values/index.js').Validator>,handler:(ctx:any,args:any)=>any}} Definition */
/** @param {FunctionKind} kind @param {'public'|'internal'} visibility @param {Definition} definition @returns {FunctionDef} */
function define(kind, visibility, definition) {
  if (typeof definition.handler !== "function") throw new Error("Function handler required");
  return Object.freeze({ [IS_FUNCTION]: /** @type {const} */ (true), kind, visibility,
    args: definition.args === undefined ? undefined : asValidator(definition.args), handler: definition.handler });
}
/** @param {unknown} value @returns {value is FunctionDef} */
export function isFunctionDef(value) { return !!value && typeof value === "object" && /** @type {any} */ (value)[IS_FUNCTION] === true; }
/** @param {Definition} definition */
export const query = (definition) => define("query", "public", definition);
/** @param {Definition} definition */
export const mutation = (definition) => define("mutation", "public", definition);
/** @param {Definition} definition */
export const action = (definition) => define("action", "public", definition);
/** @param {Definition} definition */
export const internalQuery = (definition) => define("query", "internal", definition);
/** @param {Definition} definition */
export const internalMutation = (definition) => define("mutation", "internal", definition);
/** @param {Definition} definition */
export const internalAction = (definition) => define("action", "internal", definition);
export class RebendeiError extends Error {
  /** @param {any} data */
  constructor(data) { super(typeof data === "string" ? data : JSON.stringify(data)); this.name = "RebendeiError"; this.data = data; }
}
