import { RebendeiError } from "../api.js";
/** @typedef {{baseURL?:string,apiKey?:string,model:string,headers?:Record<string,string>,fetch?:(input:Parameters<typeof globalThis.fetch>[0],init?:Parameters<typeof globalThis.fetch>[1])=>Promise<Response>}} ProviderOptions */
/** @param {ProviderOptions} options */
function transport(options) {
  const base = (options.baseURL ?? "http://localhost:11434/v1").replace(/\/+$/, "");
  let provider = "openai-compatible";
  try { provider = new URL(base).origin; } catch {}
  if (options.apiKey) provider = provider.split(options.apiKey).join("[redacted]");
  /** @param {string} path @param {unknown} body */
  return async (path, body) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      let status = 0;
      try {
        const response = await (options.fetch ?? globalThis.fetch)(`${base}/${path}`, {
          method: "POST", headers: { ...options.headers, "content-type": "application/json", ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) },
          body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
        });
        status = response.status;
        if ((status === 429 || status >= 500) && attempt < 3) {
          await response.body?.cancel();
          await Bun.sleep(100 * 2 ** attempt); continue;
        }
        if (!response.ok) throw new Error("Provider rejected request");
        return { data: await response.json(), provider, status };
      } catch {
        // Never expose a provider body, URL path, fetch error, or authorization header.
        throw new RebendeiError({ provider, status });
      }
    }
    throw new RebendeiError({ provider, status: 0 });
  };
}
/** @param {unknown} vector @param {number} dimensions @returns {vector is number[]} */
export function validVector(vector, dimensions) {
  return Array.isArray(vector) && vector.length === dimensions && vector.every((n) => typeof n === "number" && Number.isFinite(n));
}
export const openaiCompatible = {
  /** @param {ProviderOptions & {dimensions:number}} options */
  embedding(options) {
    if (!Number.isInteger(options.dimensions) || options.dimensions < 1) throw new Error("Invalid embedding dimensions");
    const request = transport(options);
    return { model: options.model, dimensions: options.dimensions,
      /** @param {string[]} texts @returns {Promise<number[][]>} */
      async embed(texts) {
        /** @type {number[][]} */ const vectors = [];
        for (let offset = 0; offset < texts.length; offset += 64) {
          const input = texts.slice(offset, offset + 64);
          const { data, provider, status } = await request("embeddings", { model: options.model, dimensions: options.dimensions, input });
          const rows = Array.isArray(data?.data) ? [...data.data].sort((a, b) => a.index - b.index) : [];
          if (rows.length !== input.length || rows.some((row, i) => row.index !== i || !validVector(row.embedding, options.dimensions))) throw new RebendeiError({ provider, status, reason: "Embedding dimension or response mismatch" });
          vectors.push(...rows.map((row) => row.embedding));
        }
        return vectors;
      },
    };
  },
  /** @param {ProviderOptions} options */
  chat(options) {
    const request = transport(options);
    return { model: options.model,
      /** @param {{system?:string,messages:{role:string,content:string}[]}} input */
      async generate({ system, messages }) {
        const { data, provider, status } = await request("chat/completions", { model: options.model, messages: [...(system ? [{ role: "system", content: system }] : []), ...messages] });
        const text = data?.choices?.[0]?.message?.content;
        if (typeof text !== "string") throw new RebendeiError({ provider, status });
        return text;
      },
    };
  },
};
