import { connect } from "./db.js";
import { config } from "./config.js";
import { createEngine, FunctionNotFoundError } from "./engine/index.js";
import { RebendeiError } from "./api.js";
import { isPlainObject } from "./values/index.js";
import { createSync } from "./sync/index.js";
import { syncLimits } from "./sync/limits.js";

/** @param {{ port?: number, sql?: import("bun").SQL, functionsDir?:string, engine?:Awaited<ReturnType<typeof createEngine>> } & import("./sync/limits.js").WsOptions} [opts] */
export function startServer(opts = {}) {
  const limits = syncLimits(opts);
  const sql = opts.sql ?? opts.engine?.sql ?? connect();
  /** @type {Promise<Awaited<ReturnType<typeof createEngine>>>|undefined} */
  let engineReady = opts.engine ? Promise.resolve(opts.engine) : undefined;
  function getEngine() { return engineReady ??= createEngine({ sql, functionsDir: opts.functionsDir }); }
  /** @type {Promise<Awaited<ReturnType<typeof createSync>>>|undefined} */
  let syncReady;
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
      if (url.pathname === "/sync") {
        try {
          await (syncReady ??= getEngine().then(engine => createSync(engine, limits)));
          if (srv.upgrade(req)) return;
          return new Response("Expected WebSocket upgrade", { status: 426 });
        } catch {
          return new Response("Sync unavailable", { status: 503 });
        }
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      maxPayloadLength: limits.frameSize,
      backpressureLimit: limits.pendingBytes,
      closeOnBackpressureLimit: true,
      async open(ws) { (await syncReady)?.open(ws); },
      async message(ws, message) { (await syncReady)?.message(ws, message); },
      async close(ws) { (await syncReady)?.close(ws); },
    },
  });
  return { server, sql, getEngine, stop: async () => {
    server.stop(true);
    try {
      if (syncReady) await (await syncReady).stop();
      if (engineReady) await (await engineReady).close();
    } finally { await sql.close(); }
  } };
}
