import { afterAll, beforeAll, expect, test } from "bun:test";
import { connect } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { startServer } from "../src/server.js";

/** @type {ReturnType<typeof startServer>} */
let app;

beforeAll(async () => {
  const sql = connect();
  await migrate(sql);
  app = startServer({ port: 0, sql });
});

afterAll(() => app.stop());

test("health reports database and pgvector", async () => {
  const res = await fetch(`http://localhost:${app.server.port}/health`);
  const body = await res.json();
  expect(res.status).toBe(200);
  expect(body.ok).toBe(true);
  expect(body.pgvector).toBeString();
});

test("sync websocket says hello", async () => {
  const ws = new WebSocket(`ws://localhost:${app.server.port}/sync`);
  const msg = await new Promise((resolve) => ws.addEventListener("message", (e) => resolve(JSON.parse(String(e.data)))));
  ws.close();
  expect(msg).toMatchObject({ type: "hello", server: "rebendei" });
  expect(msg.version).toBeString();
});

test("pgvector distance works", async () => {
  const [row] = await app.sql`SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS d`;
  expect(Number(row.d)).toBe(1);
});
