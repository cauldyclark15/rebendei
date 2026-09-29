import { encodeKey, documentKey, prefixEnd } from "./keys.js";
/** @param {import('./types.js').Bound|null} bound @param {boolean} lower */
export function encodedBound(bound, lower) {
  if (!bound) return null;
  const key = encodeKey(bound.key);
  return lower === bound.inclusive ? key : prefixEnd(key);
}
/** @param {import('./types.js').ReadSet} readSet @param {import('./types.js').Write[]} writes */
export function readSetOverlaps(readSet, writes) {
  return readSet.ranges.some((range) => {
    const lo = encodedBound(range.lower, true), hi = encodedBound(range.upper, false);
    return writes.some((write) => write.table === range.table &&
      ((range.index === "by_id" && range.lower === null && range.upper === null) || [write.oldDoc, write.newDoc].some((doc) => {
      if (!doc) return false;
      const key = encodeKey(documentKey(doc, range.fields));
      return (!lo || Buffer.compare(key, lo) >= 0) && (!hi || Buffer.compare(key, hi) < 0);
    })));
  });
}
