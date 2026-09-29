import { connect } from "./db.js";
import { config } from "./config.js";
import { createEngine, FunctionNotFoundError } from "./engine/index.js";
import { RebendeiError } from "./api.js";
import { isPlainObject } from "./values/index.js";

/** @param {{ port?: number, sql?: import("bun").SQL, functionsDir?:string, engine?:Awaited<ReturnType<typeof createEngine>> }} [opts] */
export function startServer(opts = {}) {
  const sql = opts.sql ?? opts.engine?.sql ?? connect();
  /** @type {Promise<Awaited<ReturnType<typeof createEngine>>>|undefined} */
  let engineReady = opts.engine ? Promise.resolve(opts.engine) : undefined;
  function getEngine() { return engineReady ??= createEngine({ sql, functionsDir: opts.functionsDir }); }
  const server = Bun.serve({
    port: opts.port ?? config.port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        try {
          const [row] = await sql`SELECT extversion FROM pg_extension WHERE extname = 'vector'`;
          return Response.json({ ok: true, database: "up", pgvector: row?.extversion ?? null });
        } catch (err) {
          return Response.json({ ok: false, database: "down", error: String(err) }, { status: 503 });
        }
      }
      if (req.method === "POST" && ["/api/query", "/api/mutation", "/api/action"].includes(url.pathname)) {
        try {
          const body = await req.json();
          if (!isPlainObject(body) || typeof body.path !== "string" || !body.path) throw new Error("Expected { path, args }");
          const engine = await getEngine();
          const kind = url.pathname.slice(5), args = Object.hasOwn(body, "args") ? body.args : {};
          const result = kind === "query" ? await engine.runQuery(body.path, args) :
            kind === "mutation" ? await engine.runMutation(body.path, args) : await engine.runAction(body.path, args);
          return Response.json({ status: "success", value: result.value, ...("ts" in result ? { ts: result.ts } : {}) });
        } catch (error) {
          return Response.json({ status: "error", errorMessage: error instanceof Error ? error.message : String(error),
            ...(error instanceof RebendeiError ? { errorData: error.data } : {}) },
            { status: error instanceof FunctionNotFoundError ? 404 : 400 });
        }
      }
      if (url.pathname === "/sync" && srv.upgrade(req)) return;
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      // Sync protocol lands in milestone 4; for now echo a hello.
      open(ws) {
        ws.send(JSON.stringify({ type: "hello", server: "rebendei" }));
      },
      message() {},
    },
  });
  return { server, sql, getEngine, stop: async () => {
    server.stop(true);
    try { if (engineReady) await (await engineReady).close(); } finally { await sql.close(); }
  } };
}
