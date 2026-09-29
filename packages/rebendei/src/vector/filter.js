import { assertValue } from "../values/index.js";
/** @typedef {{kind:'eq',field:string,value:any}|{kind:'or',children:readonly FilterNode[]}} FilterNode */
/** @typedef {{eq:(field:string,value:any)=>FilterNode,or:(...children:FilterNode[])=>FilterNode}} FilterBuilder */

/** Compile only nodes produced by this builder. Identifiers and values never become SQL.
 * JSONB equality (not containment alone) gives exact object/array/null semantics.
 * @param {string[]} fields
 * @param {((q:FilterBuilder)=>FilterNode)|undefined} filter
 * @param {any[]} parameters */
export function compileFilter(fields, filter, parameters) {
  if (filter === undefined) return "";
  if (typeof filter !== "function") throw new Error("Vector filter must be a function using q.eq or q.or");
  const allowed = new Set(fields);
  const nodes = new WeakSet();
  /** @param {FilterNode} node */
  const remember = (node) => { nodes.add(node); return Object.freeze(node); };
  /** @param {FilterNode} node */
  const check = (node) => {
    if (!node || typeof node !== "object" || !nodes.has(node)) throw new Error("Vector filter must return q.eq or q.or expressions");
  };
  /** @type {FilterBuilder} */
  const q = Object.freeze({
    eq(field, value) {
      if (!allowed.has(field)) throw new Error(`Undeclared vector filter field: ${field}`);
      assertValue(value, `filter.${field}`);
      return remember({ kind: "eq", field, value: structuredClone(value) });
    },
    or(...children) {
      if (!children.length) throw new Error("Vector q.or requires at least one expression");
      children.forEach(check);
      return remember({ kind: "or", children: Object.freeze([...children]) });
    },
  });
  const root = filter(q); check(root);
  /** @param {FilterNode} node @returns {string} */
  function compile(node) {
    if (node.kind === "or") return `(${node.children.map(compile).join(" OR ")})`;
    parameters.push(node.field, JSON.stringify(node.value));
    return `(filter -> $${parameters.length - 1}::text = $${parameters.length}::text::jsonb)`;
  }
  return compile(root);
}
