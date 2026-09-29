import { createHash } from "node:crypto";

/** A deterministic test model, not a mock database or Rebendei transport.
 * @param {number} dimensions
 */
export function fakeProvider(dimensions) {
  let embeddingRequests = 0;
  let chatRequests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = await request.json();
      if (path === "/v1/embeddings") {
        embeddingRequests++;
        if (body.dimensions !== dimensions) return Response.json({ error: "Wrong dimensions" }, { status: 400 });
        const data = body.input.map((/** @type {string} */ text, /** @type {number} */ index) => {
          const embedding = new Array(dimensions).fill(0);
          for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
            embedding[createHash("sha256").update(word).digest().readUInt32LE(0) % dimensions]++;
          }
          if (!embedding.some(Boolean)) embedding[0] = 1;
          return { index, embedding };
        });
        return Response.json({ data: data.reverse() });
      }
      if (path === "/v1/chat/completions") {
        chatRequests++;
        const context = body.messages.find((/** @type {{role:string}} */ message) => message.role === "user")?.content ?? "";
        // Return the first source's text line, with its citation, without a real LLM.
        const match = context.match(/\[1\] [^\n]+\n([^\n]+)/);
        return Response.json({ choices: [{ message: { content: match ? `${match[1]} [1]` : "No source found." } }] });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  return {
    server, baseURL: `http://127.0.0.1:${server.port}/v1`,
    get embeddingRequests() { return embeddingRequests; },
    get chatRequests() { return chatRequests; },
  };
}
