/** Normalize line endings and outer whitespace without changing words.
 * @param {string} text */
export const normalizeText = (text) => text.replace(/\r\n?/g, "\n").trim();

/** Recursive paragraph → sentence → word splitter. Overlap contains whole words.
 * Markdown heading-only paragraphs stay attached to their following paragraph.
 * @param {string} text
 * @param {{maxChars?:number,overlapChars?:number,overlap?:number}} [opts]
 * @returns {string[]} */
export function chunkText(text, opts = {}) {
  const max = opts.maxChars ?? 2000, overlap = opts.overlapChars ?? opts.overlap ?? 200;
  if (!Number.isInteger(max) || max < 1 || !Number.isInteger(overlap) || overlap < 0 || overlap >= max) throw new Error("Invalid chunk size or overlap");
  if (typeof text !== "string") throw new Error("Chunk text must be a string");
  text = normalizeText(text);
  if (!text) return [];
  const paragraphs = text.split(/\n\s*\n/);
  for (let i = paragraphs.length - 2; i >= 0; i--) {
    if (/^#{1,6}\s+[^\n]+$/.test(paragraphs[i])) paragraphs.splice(i, 2, paragraphs[i] + "\n\n" + paragraphs[i + 1]);
  }
  /** @param {string} part @param {number} depth @returns {string[]} */
  function split(part, depth) {
    if (part.length <= max) return [part];
    const heading = depth === 0 ? part.match(/^((?:#{1,6}[^\n]*\n+)+)([\s\S]+)$/) : null;
    if (heading) {
      const prefix = heading[1].trimEnd(), body = split(heading[2], 0);
      if (prefix.length + 2 + body[0].length <= max) return [prefix + "\n\n" + body[0], ...body.slice(1)];
      const firstWord = body[0].match(/^(\S+)([\s\S]*)$/);
      if (firstWord && prefix.length + 2 + firstWord[1].length <= max) {
        const remaining = firstWord[2].trim();
        return [prefix + "\n\n" + firstWord[1], ...(remaining ? split(remaining, 0) : []), ...body.slice(1)];
      }
      // A heading that cannot fit even one following word must itself be split.
    }
    const pieces = depth === 0 ? part.split(/(?<=[.!?])\s+(?=\S)/) : part.split(/\s+/);
    if (depth === 0) return pieces.flatMap((p) => split(p, 1));
    return pieces.flatMap((word) => word.length <= max ? [word] : Array.from({ length: Math.ceil(word.length / max) }, (_, i) => word.slice(i * max, (i + 1) * max)));
  }
  /** @type {string[]} */ const out = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const parts = split(paragraph, 0);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i], separator = i === 0 ? "\n\n" : " ";
      if (current && current.length + separator.length + part.length > max) {
        out.push(current);
        const words = current.split(/\s+/);
        let suffix = "";
        for (let j = words.length - 1; j >= 0; j--) {
          const candidate = words[j] + (suffix ? " " + suffix : "");
          if (candidate.length > overlap || candidate.length + separator.length + part.length > max) break;
          suffix = candidate;
        }
        current = suffix;
      }
      current += (current ? separator : "") + part;
    }
  }
  if (current) out.push(current);
  return out;
}
