// Manual only: DATABASE_URL=... bun packages/rebendei/test/sync-fixtures/bench.js
import { join } from "node:path";
import { connect } from "../../src/db.js";
import { migrate } from "../../src/migrate.js";
import { startServer } from "../../src/server.js";
import { RebendeiClient } from "../../src/client/index.js";
import { waitFor } from "./helpers.js";
const functionsDir = join(import.meta.dir, "functions");
const sql = connect();
await migrate(sql);
const a = startServer({ port: 0, sql, functionsDir });
const b = startServer({ port: 0, sql: connect(), functionsDir });
const writer = new RebendeiClient(`http://localhost:${a.server.port}`);
const local = new RebendeiClient(`http://localhost:${a.server.port}`);
const remote = new RebendeiClient(`http://localhost:${b.server.port}`);
try {
  const id = await writer.mutation("items:insert", { group: `bench-${crypto.randomUUID()}`, score: 1, value: 0 });
  let expected = 0, started = 0;
  /** @type {import('../../src/client/index.js').JsonValue|undefined} */ let localValue;
  /** @type {import('../../src/client/index.js').JsonValue|undefined} */ let remoteValue;
  /** @type {number[]} */ const localSamples = [];
  /** @type {number[]} */ const remoteSamples = [];
  local.onUpdate("items:get", { id }, value => {
    localValue = value;
    if (value === expected && expected > 0) localSamples.push(performance.now() - started);
  });
  remote.onUpdate("items:get", { id }, value => {
    remoteValue = value;
    if (value === expected && expected > 0) remoteSamples.push(performance.now() - started);
  });
  await waitFor(() => localValue === 0 && remoteValue === 0);
  for (let n = 1; n <= 100; n++) {
    expected = n; started = performance.now();
    await writer.mutation("items:set", { id, value: n });
    await waitFor(() => localValue === n && remoteValue === n);
  }
  /** @param {number[]} samples */
  const summarize = samples => {
    const sorted = [...samples].sort((x, y) => x - y);
    return { samples: sorted.length, p50_ms: Number(sorted[Math.ceil(sorted.length * 0.50) - 1].toFixed(3)), p95_ms: Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(3)) };
  };
  console.log(JSON.stringify({ measurement: "WS mutation send -> real client onUpdate", same_server: summarize(localSamples), cross_server_50ms_poll: summarize(remoteSamples) }, null, 2));
} finally {
  await Promise.all([writer.close(), local.close(), remote.close()]);
  await Promise.all([a.stop(), b.stop()]);
}
