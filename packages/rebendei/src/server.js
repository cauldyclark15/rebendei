import { connect } from "./db.js";
import { config } from "./config.js";

/** @param {{ port?: number, sql?: import("bun").SQL }} [opts] */
export function startServer(opts = {}) {
  const sql = opts.sql ?? connect();

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

  return { server, sql, stop: async () => { server.stop(true); await sql.close(); } };
}
