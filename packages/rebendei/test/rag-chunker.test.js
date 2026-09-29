import { expect, test } from "bun:test";
import { chunkText } from "../src/rag/index.js";
test("chunker defaults, normalization and empty text", () => {
  expect(chunkText("\r\n Hello world.\r\n")).toEqual(["Hello world."]);
  expect(chunkText("  ")).toEqual([]);
  expect(chunkText("abc")).toEqual(["abc"]);
});
test("chunker recurses through paragraphs, sentences and words without splitting words", () => {
  const text = "Alpha bravo. Charlie delta.\n\nEcho foxtrot golf hotel india.";
  const chunks = chunkText(text, { maxChars: 25, overlapChars: 0 });
  expect(chunks.every((c) => c.length <= 25)).toBe(true);
  expect(chunks.join(" ").split(/\s+/)).toEqual(text.split(/\s+/));
  expect(chunks[0]).toBe("Alpha bravo.");
});
test("chunker overlaps whole words and makes progress", () => {
  const chunks = chunkText("one two three four five six seven eight nine", { maxChars: 20, overlapChars: 8 });
  expect(chunks[0]).toBe("one two three four");
  expect(chunks[1].startsWith("four ")).toBe(true);
  expect(chunks.every((c) => c.length <= 20)).toBe(true);
  expect(chunks.at(-1)).toContain("nine");
});
test("chunker only splits words longer than maxChars", () => {
  expect(chunkText("abcdefghijklmnopqrst", { maxChars: 8, overlapChars: 0 })).toEqual(["abcdefgh", "ijklmnop", "qrst"]);
});
test("markdown heading stays with next paragraph rather than orphaned", () => {
  const chunks = chunkText("Opening paragraph.\n\n# Topic\n\nFollowing text.\n\n## Second\n\nMore text.", { maxChars: 30, overlapChars: 0 });
  expect(chunks).toContain("# Topic\n\nFollowing text.");
  expect(chunks.every((c) => !/^#{1,6} [^\n]+$/.test(c))).toBe(true);
});
test("punctuated markdown headings stay with text when the paragraph exceeds maxChars", () => {
  const chunks = chunkText("# Heading.\n\nHello there. More words that make this paragraph long.", { maxChars: 20, overlapChars: 0 });
  expect(chunks[0]).toBe("# Heading.\n\nHello");
  expect(chunks.every((c) => c.length <= 20)).toBe(true);
});
test("chunker validates sizing", () => {
  expect(() => chunkText("x", { maxChars: 0 })).toThrow();
  expect(() => chunkText("x", { maxChars: 10, overlapChars: 10 })).toThrow();
});
