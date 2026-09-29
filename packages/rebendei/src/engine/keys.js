// Each value is self-delimiting. Zero ends a container; UTF-8 zero is escaped.
/** @param {Buffer} bytes */
function escaped(bytes) {
  const out = [];
  for (const byte of bytes) out.push(...(byte === 0 ? [0, 255] : [byte]));
  out.push(0, 0);
  return Buffer.from(out);
}
/** @param {any} value @returns {Buffer} */
function encodeValue(value) {
  if (value === undefined) return Buffer.from([16]);
  if (value === null) return Buffer.from([32]);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Index numbers must be finite");
    const b = Buffer.alloc(9); b[0] = 48; b.writeDoubleBE(value === 0 ? 0 : value, 1);
    if (b[1] & 128) for (let i = 1; i < 9; i++) b[i] ^= 255;
    else b[1] ^= 128;
    return b;
  }
  if (typeof value === "boolean") return Buffer.from([64, value ? 1 : 0]);
  if (typeof value === "string") return Buffer.concat([Buffer.from([80]), escaped(Buffer.from(value, "utf8"))]);
  if (Array.isArray(value)) return Buffer.concat([Buffer.from([96]), ...value.map(encodeValue), Buffer.from([0])]);
  if (typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const keys = Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    return Buffer.concat([Buffer.from([112]), ...keys.flatMap((k) => [encodeValue(k), encodeValue(value[k])]), Buffer.from([0])]);
  }
  throw new Error("Unsupported index value");
}
/** @param {any[]} values @returns {Buffer} */
export function encodeKey(values) { return Buffer.concat(values.map(encodeValue)); }
/** @param {any[]} a @param {any[]} b @returns {number} */
export function compareKeys(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const comparison = compareValue(a[i], b[i]);
    if (comparison !== 0) return comparison;
  }
  return Math.sign(a.length - b.length);
}
/** @param {any} value */
function typeRank(value) {
  if (value === undefined) return 0;
  if (value === null) return 1;
  if (typeof value === "number" && Number.isFinite(value)) return 2;
  if (typeof value === "boolean") return 3;
  if (typeof value === "string") return 4;
  if (Array.isArray(value)) return 5;
  if (value && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) return 6;
  throw new Error("Unsupported index value");
}
/** Independent reference total order, including UTF-8 string and object-key order.
 * @param {any} a @param {any} b @returns {number} */
function compareValue(a, b) {
  const ar = typeRank(a), br = typeRank(b);
  if (ar !== br) return Math.sign(ar - br);
  if (ar < 2) return 0;
  if (ar < 4) return a === b ? 0 : a < b ? -1 : 1;
  if (ar === 4) return Buffer.compare(Buffer.from(a), Buffer.from(b));
  if (ar === 5) return compareKeys(a, b);
  const entries = (/** @type {Record<string,any>} */ value) => Object.keys(value)
    .sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y))).flatMap((k) => [k, value[k]]);
  return compareKeys(entries(a), entries(b));
}
/** First key strictly after every extension of this prefix.
 * @param {Buffer} prefix @returns {Buffer|null} */
export function prefixEnd(prefix) {
  const out = Buffer.from(prefix);
  for (let i = out.length - 1; i >= 0; i--) if (out[i] < 255) { out[i]++; return out.subarray(0, i + 1); }
  return null;
}
/** @param {Record<string,any>} doc @param {string} field */
export function fieldValue(doc, field) { return field.split(".").reduce((value, key) => value?.[key], doc); }
/** @param {Record<string,any>} doc @param {string[]} fields */
export function documentKey(doc, fields) {
  return [...fields.map((f) => fieldValue(doc, f)), ...(fields.includes("_creationTime") ? [] : [doc._creationTime]), doc._id];
}
