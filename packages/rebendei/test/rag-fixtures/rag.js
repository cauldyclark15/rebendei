import { RAG, openaiCompatible } from "../../src/rag/index.js";
const baseURL = process.env.RAG_TEST_BASE_URL;
export const rag = new RAG({
  embedding: openaiCompatible.embedding({ baseURL, model: "hashed", dimensions: 64 }),
  chat: openaiCompatible.chat({ baseURL, model: "echo" }), filterNames: ["category", "userId"],
});
