import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { connect } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { createEngine } from "../src/engine/index.js";
import { install } from "../src/scheduler/index.js";

/** @type {import('bun').SQL} */ let sql;
/** @type {any} */ let engine;
/** @type {any[]} */ const extras = [];
const functionsDir = join(import.meta.dir, "scheduler-fixtures");
/** @param {()=>Promise<any>} check @param {number} [timeout] */
async function until(check, timeout = 3000) {
  const end = Date.now() + timeout;
  do { if (await check()) return; await Bun.sleep(15); } while (Date.now() < end);
  throw new Error("Scheduler condition timed out");
}
/** @param {string} id @param {string} [state] */
async function completed(id, state = "success") {
  await until(async () => { const [row] = await sql`SELECT state,error FROM scheduled_jobs WHERE id=${id}`; if (row?.state === "failed" && state !== "failed") throw new Error(row.error); return row?.state === state; });
  return (await sql`SELECT * FROM scheduled_jobs WHERE id=${id}`)[0];
}
/** @param {any} [args] */
const schedule = async (args = {}) => (await engine.runMutation("jobs:schedule", args)).value;
const events = async () => (await engine.runQuery("jobs:list")).value;
beforeAll(async () => {
  sql = connect(); await migrate(sql);
  engine = await createEngine({ sql, functionsDir });
});
beforeEach(async () => {
  await engine.scheduler.stop();
  for (const other of extras.splice(0)) { await other.close(); await other.sql.close(); }
  delete process.env.REBENDEI_SCHEDULER_TEST_CRON;
  await sql`TRUNCATE scheduled_jobs,crons`;
  await sql`DELETE FROM index_entries WHERE table_name='scheduler_events'`;
  await sql`DELETE FROM documents WHERE table_name='scheduler_events'`;
  await engine.load();
});
afterAll(async () => {
  delete process.env.REBENDEI_SCHEDULER_TEST_CRON;
  for (const other of extras) { await other.close(); await other.sql.close(); }
  await engine.close(); await sql.close();
});
test("runAfter(0) executes internal mutation with write hooks and local commit callbacks", async () => {
  let hook = false, callback = false;
  const onWrite = async (/** @type {import('bun').TransactionSQL} */ tx, /** @type {any} */ write) => {
    if (write.table === "scheduler_events") {
      const [row] = await tx`SELECT value FROM documents WHERE id=${write.id}`;
      hook = row.value.key === "immediate";
    }
  };
  engine.hooks.onWrite.push(onWrite);
  const unsubscribe = engine.onCommit((/** @type {string} */ _ts, /** @type {any[]} */ writes) => { if (writes.some((w) => w.table === "scheduler_events")) callback = true; });
  try {
    const id = await schedule({ payload: { key: "immediate" } });
    expect(id).toBeString();
    const row = await completed(id);
    expect(row.attempts).toBe(1); expect(row.completed_at).not.toBeNull();
    expect((await events()).map((/** @type {any} */ doc) => doc.key)).toEqual(["immediate"]);
    expect(hook).toBe(true); expect(callback).toBe(true);
  } finally { engine.hooks.onWrite.pop(); unsubscribe(); }
});
test("scheduling and cancellation are transactional, and numeric/Date runAt works", async () => {
  await expect(schedule({ rollback: true })).rejects.toThrow("scheduling rollback");
  expect((await sql`SELECT * FROM scheduled_jobs`).length).toBe(0);
  const id = await schedule({ at: Date.now() + 60000 });
  await expect(engine.runMutation("jobs:cancel", { id, rollback: true })).rejects.toThrow("cancel rollback");
  expect((await sql`SELECT state FROM scheduled_jobs WHERE id=${id}`)[0].state).toBe("pending");
  await engine.runMutation("jobs:cancel", { id });
  expect((await sql`SELECT state FROM scheduled_jobs WHERE id=${id}`)[0].state).toBe("canceled");
  const at = Date.now() + 130;
  const dateId = await schedule({ at, date: true, payload: { date: true } });
  await completed(dateId);
  expect((await events()).length).toBe(1);
  await expect(schedule({ delay: -1 })).rejects.toThrow("Delay");
  await expect(schedule({ path: "jobs:list" })).rejects.toThrow("mutation/action");
});
test("action context schedules directly; action jobs success/failure and failed mutations rollback", async () => {
  const id = (await engine.runAction("jobs:scheduleAction", { path: "jobs:perform", payload: { key: "action" } })).value;
  await completed(id);
  const fail = await schedule({ path: "jobs:perform", payload: { fail: true } });
  expect((await completed(fail, "failed")).error).toBe("action failure");
  const mutationFail = await schedule({ payload: { fail: true } });
  expect((await completed(mutationFail, "failed")).error).toBe("mutation failure");
  expect((await events()).length).toBe(1);
  await Bun.sleep(130);
  expect((await sql`SELECT attempts FROM scheduled_jobs WHERE id=${fail}`)[0].attempts).toBe(1);
});
test("two engines claim thirty jobs exactly once; install and reload are idempotent", async () => {
  const otherSql = connect();
  const other = /** @type {any} */ (await createEngine({ sql: otherSql, functionsDir })); extras.push(other);
  await engine.scheduler.stop(); await other.scheduler.stop();
  expect(await install(engine)).toBe(engine.scheduler);
  const extensionCount = engine.extendCtx.length;
  const ids = [];
  for (let n = 0; n < 30; n++) ids.push(await schedule({ payload: { n } }));
  await Promise.all([engine.load(), other.load()]);
  expect(engine.extendCtx.length).toBe(extensionCount);
  await until(async () => (await sql`SELECT count(*)::int AS n FROM scheduled_jobs WHERE state='success'`)[0].n === 30);
  const recorded = await events();
  expect(recorded.length).toBe(30);
  expect(new Set(recorded.map((/** @type {any} */ doc) => doc.n)).size).toBe(30);
  expect((await sql`SELECT max(attempts)::int AS n FROM scheduled_jobs`)[0].n).toBe(1);
});
/** @param {boolean} [crash] */
function spawnWorker(crash = false) {
  return Bun.spawn([process.execPath, join(functionsDir, "_worker.js")], {
    cwd: functionsDir,
    env: { ...process.env, REBENDEI_SCHEDULER_TEST_CRASH: crash ? "1" : "0", REBENDEI_SCHEDULER_POLL_MS: "15" },
    stdout: "pipe", stderr: "pipe",
  });
}
/** @param {ReturnType<typeof spawnWorker>} worker @param {string} marker */
async function outputUntil(worker, marker) {
  const reader = worker.stdout.getReader();
  let text = "";
  try {
    await Promise.race([
      (async () => { while (!text.includes(marker)) { const chunk = await reader.read(); if (chunk.done) throw new Error(`Worker exited: ${text}`); text += new TextDecoder().decode(chunk.value); } })(),
      Bun.sleep(3000).then(() => { throw new Error(`Worker did not reach ${marker}: ${text}`); }),
    ]);
  } finally { reader.releaseLock(); }
}
test("separate processes share claims without duplicate execution", async () => {
  await engine.scheduler.stop();
  for (let n = 0; n < 30; n++) await schedule({ payload: { processJob: n } });
  const workers = [spawnWorker(), spawnWorker()];
  try {
    await Promise.all(workers.map((worker) => outputUntil(worker, "worker-ready")));
    await until(async () => (await sql`SELECT count(*)::int AS n FROM scheduled_jobs WHERE state='success'`)[0].n === 30);
    expect((await events()).length).toBe(30);
    expect((await sql`SELECT max(attempts)::int AS n FROM scheduled_jobs`)[0].n).toBe(1);
  } finally { for (const worker of workers) worker.kill("SIGTERM"); await Promise.all(workers.map((worker) => worker.exited)); }
});
test("killed mutation rolls back its effects and recovers its uncommitted completion marker", async () => {
  await engine.scheduler.stop();
  const id = await schedule({ payload: { key: "crash-safe", crash: true } });
  const worker = spawnWorker(true);
  try {
    await outputUntil(worker, "mutation-entered");
    expect((await events()).length).toBe(0); // effects are still uncommitted
    expect((await sql`SELECT state FROM scheduled_jobs WHERE id=${id}`)[0].state).toBe("inProgress");
  } finally { worker.kill("SIGKILL"); await worker.exited; }
  await sql`UPDATE scheduled_jobs SET lease_until=0 WHERE id=${id}`;
  engine.scheduler.start();
  expect((await completed(id)).attempts).toBe(2);
  expect((await events()).length).toBe(1);
});
test("killed actions remain inProgress and are never automatically retried", async () => {
  await engine.scheduler.stop();
  const id = await schedule({ path: "jobs:perform", payload: { crash: true } });
  const worker = spawnWorker(true);
  try { await outputUntil(worker, "action-entered"); }
  finally { worker.kill("SIGKILL"); await worker.exited; }
  await sql`UPDATE scheduled_jobs SET lease_until=0 WHERE id=${id}`;
  engine.scheduler.start();
  const sentinel = await schedule({ payload: { sentinel: true } }); await completed(sentinel);
  const [row] = await sql`SELECT state,attempts FROM scheduled_jobs WHERE id=${id}`;
  expect(row).toMatchObject({ state: "inProgress", attempts: 1 });
  expect((await events()).length).toBe(1);
});
test("interval cron ticks repeatedly, dedupes across engines, preserves clock, and removes on load", async () => {
  process.env.REBENDEI_SCHEDULER_TEST_CRON = "1";
  // Workers paused while checking that a reload keeps the cron clock: with a 1s interval a
  // tick can otherwise legitimately advance next_run between the two reads.
  await engine.scheduler.stop();
  await engine.load();
  const [first] = await sql`SELECT next_run FROM crons WHERE name='heartbeat'`;
  const other = /** @type {any} */ (await createEngine({ sql: connect(), functionsDir })); extras.push(other);
  await other.scheduler.stop();
  await engine.load();
  // Reload must keep the cron's phase. If the 1s interval elapsed during the (slow, cold)
  // second engine start, load() legitimately rolls next_run forward by whole intervals.
  const reloaded = Number((await sql`SELECT next_run FROM crons WHERE name='heartbeat'`)[0].next_run);
  expect(reloaded).toBeGreaterThanOrEqual(Number(first.next_run));
  expect((reloaded - Number(first.next_run)) % 1000).toBe(0);
  // Two engines loading the same cron must never schedule the same tick twice.
  const [ticks] = await sql`SELECT count(*)::int AS n, count(DISTINCT cron_run_at)::int AS distinct_n FROM scheduled_jobs WHERE cron_name='heartbeat'`;
  expect(ticks.n).toBe(ticks.distinct_n);
  expect(ticks.n).toBe(1 + (reloaded - Number(first.next_run)) / 1000);
  engine.scheduler.start(); other.scheduler.start();
  await until(async () => (await events()).length >= 2);
  const [count] = await sql`SELECT count(*)::int AS n,count(DISTINCT cron_run_at)::int AS distinct_n FROM scheduled_jobs WHERE cron_name='heartbeat'`;
  expect(count.n).toBe(count.distinct_n);
  expect((await sql`SELECT max(attempts)::int AS n FROM scheduled_jobs WHERE state='success'`)[0].n).toBe(1);
  delete process.env.REBENDEI_SCHEDULER_TEST_CRON;
  await engine.load();
  expect((await sql`SELECT * FROM crons`).length).toBe(0);
  expect((await sql`SELECT * FROM scheduled_jobs WHERE cron_name='heartbeat' AND state='pending'`).length).toBe(0);
  expect((await sql`SELECT * FROM scheduled_jobs WHERE cron_name='heartbeat' AND state='canceled'`).length).toBe(1);
});
test("superseded mutation claims are fenced before executing the handler", async () => {
  await engine.scheduler.stop();
  const other = /** @type {any} */ (await createEngine({ sql: connect(), functionsDir })); extras.push(other);
  await other.scheduler.stop();
  /** @type {()=>void} */ let release = () => {};
  const gate = new Promise((resolve) => { release = () => resolve(undefined); });
  const run = other.runMutation.bind(other);
  other.runMutation = async (/** @type {string} */ path, /** @type {any} */ args, /** @type {any} */ options) => {
    if (path === "jobs:record") await gate;
    return run(path, args, options);
  };
  const id = await schedule({ payload: { fenced: true } });
  other.scheduler.start();
  try {
    await until(async () => (await sql`SELECT state FROM scheduled_jobs WHERE id=${id}`)[0].state === "inProgress");
    await sql`UPDATE scheduled_jobs SET lease_until=0 WHERE id=${id}`;
    engine.scheduler.start();
    expect((await completed(id)).attempts).toBe(2);
  } finally { release(); await other.scheduler.stop(); }
  expect((await events()).length).toBe(1);
  expect((await sql`SELECT state FROM scheduled_jobs WHERE id=${id}`)[0].state).toBe("success");
});
test("serialization retries keep mutation effects and success markers atomic", async () => {
  await engine.scheduler.stop();
  const other = /** @type {any} */ (await createEngine({ sql: connect(), functionsDir })); extras.push(other);
  await other.scheduler.stop();
  const id = (await engine.runMutation("jobs:createCounter")).value;
  let reads = 0;
  /** @type {()=>void} */ let release = () => {};
  const gate = new Promise((resolve) => { release = () => resolve(undefined); });
  const extend = (/** @type {string} */ kind, /** @type {any} */ ctx, /** @type {any} */ meta) => {
    if (kind === "mutation" && meta.path === "jobs:bump") ctx.checkpoint = async () => { if (++reads === 2) release(); await gate; };
  };
  engine.extendCtx.push(extend); other.extendCtx.push(extend);
  try {
    const jobs = [await schedule({ path: "jobs:bump", payload: { id } }), await schedule({ path: "jobs:bump", payload: { id } })];
    engine.scheduler.start(); other.scheduler.start();
    await Promise.all(jobs.map((job) => completed(job)));
    expect((await engine.runQuery("jobs:getCounter", { id })).value.count).toBe(2);
    expect(reads).toBeGreaterThan(2);
    expect((await sql`SELECT max(attempts)::int AS n FROM scheduled_jobs`)[0].n).toBe(1);
  } finally { release(); await engine.scheduler.stop(); await other.scheduler.stop(); engine.extendCtx.pop(); other.extendCtx.pop(); }
});
test("changed or re-added cron definitions can reuse the same upcoming timestamp", async () => {
  process.env.REBENDEI_SCHEDULER_TEST_CRON = "calendar";
  try {
    await engine.load();
    const [original] = await sql`SELECT * FROM scheduled_jobs WHERE state='pending'`;
    process.env.REBENDEI_SCHEDULER_TEST_CRON_VERSION = "changed";
    await engine.load();
    const [changed] = await sql`SELECT * FROM scheduled_jobs WHERE state='pending'`;
    expect(changed.run_at).toBe(original.run_at);
    expect(changed.args).toEqual({ version: "changed" });
    expect(changed.cron_generation).not.toBe(original.cron_generation);
    delete process.env.REBENDEI_SCHEDULER_TEST_CRON;
    await engine.load();
    process.env.REBENDEI_SCHEDULER_TEST_CRON = "calendar";
    await engine.load();
    const pending = await sql`SELECT * FROM scheduled_jobs WHERE state='pending'`;
    expect(pending.length).toBe(1);
    expect(pending[0].run_at).toBe(original.run_at);
  } finally { delete process.env.REBENDEI_SCHEDULER_TEST_CRON; delete process.env.REBENDEI_SCHEDULER_TEST_CRON_VERSION; }
});
test("close drains and stops the worker", async () => {
  const other = /** @type {any} */ (await createEngine({ sql: connect(), functionsDir }));
  expect(other.scheduler.running).toBe(true);
  await other.close();
  expect(other.scheduler.running).toBe(false);
  await other.sql.close();
});
