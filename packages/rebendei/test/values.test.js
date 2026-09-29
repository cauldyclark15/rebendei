import { expect, test } from "bun:test";
import { v, validate, ValidationError, assertValue } from "../src/values/index.js";
import { query, internalAction, isFunctionDef, IS_FUNCTION } from "../src/api.js";
import { defineSchema, defineTable } from "../src/schema.js";

test("validator kinds, frozen definitions, descriptions and invalid values", () => {
  const cases = [
    [v.string(), "hello", 1], [v.number(), 1.5, Infinity], [v.float64(), -1, NaN],
    [v.boolean(), false, 1], [v.null(), null, false], [v.any(), { nested: [null, true, 1] }, undefined],
    [v.literal("yes"), "yes", "no"], [v.id("messages"), "messages:0199a123-4567-7123-8123-123456789abc", "other:0199a123-4567-7123-8123-123456789abc"],
    [v.array(v.number()), [1, 2], ["bad"]], [v.object({ name: v.string() }), { name: "a" }, { name: 1 }],
    [v.record(v.number()), { key: 1 }, { key: "a" }], [v.union(v.string(), v.null()), null, false],
    [v.optional(v.string()), undefined, 1],
  ];
  for (const [spec, good, bad] of cases) {
    const validator = /** @type {import('../src/values/index.js').Validator} */ (spec);
    expect(Object.isFrozen(validator)).toBe(true);
    expect(() => validator.validate(good)).not.toThrow();
    expect(() => validator.validate(bad)).toThrow(ValidationError);
    expect(JSON.parse(JSON.stringify(validator.toJSON())).kind).toBe(validator.kind);
  }
  expect(v.optional(v.string()).isOptional).toBe(true);
  expect(v.string().isOptional).toBe(false);
});
test("optional fields, unknown rejection and exact nested error paths", () => {
  expect(validate({ name: v.string(), other: v.optional(v.boolean()) }, { name: "ok" })).toEqual({ name: "ok" });
  expect(() => validate({ toString: v.optional(v.string()) }, {})).not.toThrow();
  expect(() => validate({ name: v.string() }, { name: "ok", unknown: 1 })).toThrow("unknown: unknown field");
  try { v.object({ author: v.object({ names: v.array(v.string()) }) }).validate({ author: { names: ["ok", 1] } }, "args"); }
  catch (error) { expect(error).toBeInstanceOf(ValidationError); expect(/** @type {ValidationError} */ (error).path).toBe("args.author.names.1"); return; }
  throw new Error("Expected validation failure");
});
test("non-JSON values, cycles, reserved fields are rejected", () => {
  for (const value of [undefined, Infinity, NaN, new Date(), { _private: 1 }, { bad: undefined }, [undefined], 1n, () => 1]) expect(() => assertValue(value)).toThrow(ValidationError);
  const cyclic = /** @type {any} */ ({}); cyclic.self = cyclic;
  expect(() => assertValue(cyclic)).toThrow("cyclic");
});
test("function API tags and schema index shapes", () => {
  const fn = query({ args: { text: v.string() }, handler: () => null });
  expect(fn[IS_FUNCTION]).toBe(true); expect(Object.isFrozen(fn)).toBe(true); expect(isFunctionDef(fn)).toBe(true);
  expect(fn.kind).toBe("query"); expect(fn.visibility).toBe("public"); expect(isFunctionDef({})).toBe(false);
  expect(internalAction({ handler: () => null }).visibility).toBe("internal");
  const table = defineTable({ text: v.string() }).index("by_text", ["text"]).vectorIndex("by_vector", { vectorField: "embedding", dimensions: 3 });
  const schema = defineSchema({ messages: table });
  expect(schema.schemaValidation).toBe(true);
  expect(schema.tables.messages.indexes).toEqual([{ name: "by_id", fields: ["_id"] }, { name: "by_creation_time", fields: ["_creationTime"] }, { name: "by_text", fields: ["text", "_creationTime"] }]);
  expect(schema.tables.messages.vectorIndexes[0].filterFields).toEqual([]);
  expect(() => table.index("by_text", ["text"])).toThrow("Duplicate");
});
