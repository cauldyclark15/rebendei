import { isDeepStrictEqual } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import { loadFunctions } from "../engine/loader.js";
import { assertValue } from "../values/index.js";
import { nextRun } from "./crons.js";

const CRON_LOCK = 726232343;
class SupersededClaim extends Error {}
/** @typedef {import('bun').SQL|import('bun').TransactionSQL} Connection */
/** @typedef {{id:string,path:string,args:any,kind:'mutation'|'action',claim_token:string}} Job */
/** Install once. Poll/lease settings may also be supplied through REBENDEI_SCHEDULER_* env vars.
 * @param {any} engine @param {{pollMs?:number,leaseMs?:number,onError?:(error:unknown)=>void}} [options] */
export async function install(engine, options = {}) {
  if (engine.scheduler) return engine.scheduler;
  /** @type {import('bun').SQL} */ const sql = engine.sql;
  const pollMs = options.pollMs ?? Number(process.env.REBENDEI_SCHEDULER_POLL_MS ?? 100);
  const leaseMs = options.leaseMs ?? Number(process.env.REBENDEI_SCHEDULER_LEASE_MS ?? 30000);
  if (!Number.isFinite(pollMs) || pollMs < 1 || !Number.isFinite(leaseMs) || leaseMs < 1) throw new Error("Invalid scheduler poll/lease duration");
  const onError = options.onError ?? ((error) => console.error("rebendei scheduler failed", error));
  /** @type {Map<string,import('../api.js').FunctionDef>} */ let functions = new Map();
  let stopped = true;
  /** @type {ReturnType<typeof setTimeout>|null} */ let timer = null;
  /** @type {Promise<void>|null} */ let active = null;
  // The engine owns mutation context creation, retries, hooks, and notifications.
  // Fence its transaction boundary only for this async invocation, instead of
  // duplicating the engine or committing a completion marker in a second txn.
  /** @type {AsyncLocalStorage<{job:Job,completed:boolean}|null>} */ const invocation = new AsyncLocalStorage();
  const pool = /** @type {any} */ (sql);
  const originalBegin = pool.begin;
  /** @param {...any} args */
  async function jobBegin(...args) {
    const scheduled = invocation.getStore();
    if (!scheduled || scheduled.completed) return originalBegin.apply(pool, args);
    const execute = args.pop();
    if (typeof execute !== "function") throw new Error("Scheduled mutation requires a transaction callback");
    const job = scheduled.job;
    const result = await originalBegin.call(pool, ...args, (/** @type {import('bun').TransactionSQL} */ tx) => invocation.run(null, async () => {
      const [row] = await tx`SELECT state,claim_token FROM scheduled_jobs WHERE id=${job.id} FOR UPDATE`;
      if (!row || row.state !== "inProgress" || row.claim_token !== job.claim_token) throw new SupersededClaim();
      const value = await execute(tx);
      await tx`UPDATE scheduled_jobs SET state='success',completed_at=now(),lease_until=NULL,error=NULL WHERE id=${job.id}`;
      return value;
    }));
    // A failed commit leaves this false so the engine's serialization retry is
    // fenced again. After commit, onCommit callbacks may open unrelated txns.
    scheduled.completed = true;
    return result;
  }
  pool.begin = jobBegin;
  /** @param {string} path @param {any} args */
  function target(path, args) {
    const definition = functions.get(path);
    if (!definition || definition.kind === "query") throw new Error(`Scheduled function not found (mutation/action required): ${path}`);
    assertValue(args, "args"); definition.args?.validate(args, "args");
    return definition;
  }
  /** @param {Connection} connection @param {number} at @param {string} path @param {any} args @param {string|null} [cronName] @param {string|null} [cronGeneration] */
  async function enqueue(connection, at, path, args, cronName = null, cronGeneration = null) {
    if (!Number.isFinite(at) || !Number.isFinite(new Date(at).getTime())) throw new Error("Invalid scheduled timestamp");
    const definition = target(path, args), id = Bun.randomUUIDv7();
    const rows = await connection`INSERT INTO scheduled_jobs (id,path,args,run_at,kind,cron_name,cron_generation,cron_run_at)
      VALUES (${id},${path},${args}::jsonb,${at},${definition.kind},${cronName},${cronGeneration},${cronName === null ? null : at})
      ON CONFLICT (cron_name,cron_generation,cron_run_at) DO NOTHING RETURNING id`;
    return rows.length ? String(rows[0].id) : null;
  }
  /** @param {Connection} connection */
  function contextScheduler(connection) {
    return {
      /** @param {number} delayMs @param {string} path @param {any} [args] */
      async runAfter(delayMs, path, args = {}) {
        if (typeof delayMs !== "number" || !Number.isFinite(delayMs) || delayMs < 0) throw new Error("Delay must be a nonnegative finite number");
        return /** @type {string} */ (await enqueue(connection, Date.now() + delayMs, path, args));
      },
      /** @param {number|Date} timestamp @param {string} path @param {any} [args] */
      async runAt(timestamp, path, args = {}) {
        if (!(timestamp instanceof Date) && typeof timestamp !== "number") throw new Error("Timestamp must be milliseconds or a Date");
        return /** @type {string} */ (await enqueue(connection, timestamp instanceof Date ? timestamp.getTime() : timestamp, path, args));
      },
      /** Only pending jobs can be canceled; executing jobs cannot be undone.
       * @param {string} id */
      async cancel(id) {
        if (typeof id !== "string") throw new Error("Job id must be a string");
        await connection`UPDATE scheduled_jobs SET state='canceled',completed_at=now() WHERE id=${id} AND state='pending'`;
      },
    };
  }
  engine.extendCtx.push((/** @type {string} */ kind, /** @type {any} */ ctx, /** @type {any} */ meta) => {
    if (kind !== "query") ctx.scheduler = contextScheduler(meta.sql ?? sql);
  });
  /** Synchronize a whole application's cron definitions under a DB lock.
   * Unchanged definitions retain their clock across reloads/process starts. */
  async function syncCrons() {
    /** @type {import('./crons.js').CronDefinition[]} */ const definitions = engine.crons?.definitions ?? [];
    const names = definitions.map((definition) => definition.name);
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${CRON_LOCK})`;
      for (const old of await tx`SELECT name FROM crons`) {
        if (!names.includes(old.name)) {
          await tx`DELETE FROM crons WHERE name=${old.name}`;
          await tx`UPDATE scheduled_jobs SET state='canceled',completed_at=now() WHERE cron_name=${old.name} AND state='pending'`;
        }
      }
      for (const definition of definitions) {
        const { name, spec, path, args } = definition;
        target(path, args);
        const [old] = await tx`SELECT * FROM crons WHERE name=${name}`;
        const unchanged = old && old.path === path && isDeepStrictEqual(old.spec, spec) && isDeepStrictEqual(old.args, args);
        if (unchanged) continue;
        await tx`UPDATE scheduled_jobs SET state='canceled',completed_at=now() WHERE cron_name=${name} AND state='pending'`;
        const at = nextRun(spec, Date.now()), generation = Bun.randomUUIDv7();
        await tx`INSERT INTO crons (name,generation,spec,path,args,next_run) VALUES (${name},${generation},${spec}::jsonb,${path},${args}::jsonb,${at})
          ON CONFLICT (name) DO UPDATE SET generation=EXCLUDED.generation,spec=EXCLUDED.spec,path=EXCLUDED.path,args=EXCLUDED.args,next_run=EXCLUDED.next_run`;
        await enqueue(tx, at, path, args, name, generation);
      }
    });
  }
  async function tickCrons() {
    await sql.begin(async (tx) => {
      const rows = await tx`SELECT * FROM crons WHERE next_run<=${Date.now()} ORDER BY next_run FOR UPDATE SKIP LOCKED LIMIT 16`;
      for (const row of rows) {
        const at = Number(row.next_run);
        await enqueue(tx, at, row.path, row.args, row.name, row.generation);
        const next = nextRun(row.spec, at);
        await tx`UPDATE crons SET next_run=${next} WHERE name=${row.name}`;
        await enqueue(tx, next, row.path, row.args, row.name, row.generation);
      }
    });
  }
  /** Claim in a short transaction. Only mutations have recoverable leases; actions
   * are never re-claimed, even after process death (at-most-once invocation). */
  async function claim() {
    return sql.begin(async (tx) => {
      const now = Date.now();
      const [job] = await tx`SELECT * FROM scheduled_jobs
        WHERE (state='pending' AND run_at<=${now}) OR (state='inProgress' AND kind='mutation' AND lease_until<=${now})
        ORDER BY run_at,id FOR UPDATE SKIP LOCKED LIMIT 1`;
      if (!job) return null;
      const token = Bun.randomUUIDv7();
      await tx`UPDATE scheduled_jobs SET state='inProgress',attempts=attempts+1,claim_token=${token},lease_until=${now + leaseMs} WHERE id=${job.id}`;
      return /** @type {Job} */ ({ ...job, claim_token: token });
    });
  }
  /** Mutation effects and completion marker commit together. Holding the job row
   * lock fences stale claims and makes lease expiry safe even for slow handlers.
   * A dead worker rolls back both effects and marker; its lease is re-claimed.
   * @param {Job} job */
  async function executeMutation(job) {
    await invocation.run({ job, completed: false }, () => engine.runMutation(job.path, job.args, { internal: true }));
  }
  /** @param {Job} job */
  async function execute(job) {
    try {
      if (job.kind === "mutation") await executeMutation(job);
      else {
        await engine.runAction(job.path, job.args, { internal: true });
        await sql`UPDATE scheduled_jobs SET state='success',completed_at=now(),lease_until=NULL WHERE id=${job.id} AND state='inProgress' AND claim_token=${job.claim_token}`;
      }
    } catch (error) {
      if (error instanceof SupersededClaim) return;
      const message = error instanceof Error ? error.message : String(error);
      await sql`UPDATE scheduled_jobs SET state='failed',error=${message},completed_at=now(),lease_until=NULL
        WHERE id=${job.id} AND state='inProgress' AND claim_token=${job.claim_token}`;
    }
  }
  async function tick() {
    await tickCrons();
    for (let n = 0; n < 16 && !stopped; n++) {
      const job = await claim();
      if (!job) break;
      await execute(job);
    }
  }
  function queue() {
    if (stopped || timer || active) return;
    timer = setTimeout(() => {
      timer = null;
      active = tick().catch(onError).finally(() => { active = null; queue(); });
    }, pollMs);
    timer.unref();
  }
  const scheduler = {
    pollMs, leaseMs,
    start() { stopped = false; queue(); },
    async stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; await active; },
    get running() { return !stopped; },
  };
  engine.scheduler = scheduler;
  const originalClose = engine.close.bind(engine);
  engine.close = async () => {
    await scheduler.stop();
    if (pool.begin === jobBegin) pool.begin = originalBegin;
    await originalClose();
  };
  engine.hooks.onLoad.push(async () => {
    await scheduler.stop();
    functions = (await loadFunctions(engine.functionsDir)).functions;
    await syncCrons();
    scheduler.start();
  });
  return scheduler;
}
