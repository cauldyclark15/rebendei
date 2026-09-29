import { RAG, openaiCompatible } from "rebendei/rag";

export const rag = new RAG({
  embedding: openaiCompatible.embedding({
    baseURL: process.env.EMBEDDING_BASE_URL ?? "http://localhost:11434/v1",
    model: process.env.EMBEDDING_MODEL ?? "nomic-embed-text",
    dimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 768),
    apiKey: process.env.EMBEDDING_API_KEY,
  }),
  // Retrieval works without chat. Set CHAT_MODEL to enable knowledge:ask.
  chat: process.env.CHAT_MODEL ? openaiCompatible.chat({
    baseURL: process.env.CHAT_BASE_URL ?? "http://localhost:11434/v1",
    model: process.env.CHAT_MODEL,
    apiKey: process.env.CHAT_API_KEY,
  }) : undefined,
  filterNames: ["source"],
});
