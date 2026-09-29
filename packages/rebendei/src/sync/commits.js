import { SQL } from "bun";

/** Ordered, timestamp-deduplicated commit feed shared by all sockets of a server.
 * Bun 1.3.14 has SQL.reserve(), but no SQL.listen()/notification callback API.
 * Use the documented fallback: one dedicated connection polling every 50ms.
 * @param {import('bun').SQL} root
 * @param {(rows:Commit[])=>void} receive
 * @typedef {{ts:string,writes:import('../engine/types.js').Write[]}} Commit
 */
export function createCommitFeed(root, receive) {
  const sql = new SQL({ ...root.options, max: 1 });
  let stopped = false, again = false, lastTs = "0";
  /** @type {Promise<void>|undefined} */ let running;
  function wake() {
    if (stopped) return;
    again = true;
    if (running) return;
    running = (async () => {
      // Bound eager passes under continuous local commits; the timer picks up
      // anything left over, so wake() never requires database-wide quiescence.
      let passes = 0;
      do {
        again = false;
        const rows = await sql`SELECT ts::text AS ts, writes FROM commits WHERE ts > ${lastTs}::bigint ORDER BY ts`;
        if (stopped) return;
        if (rows.length) {
          lastTs = String(rows[rows.length - 1].ts);
          receive(rows);
        }
      } while (again && !stopped && ++passes < 8);
    })().catch(error => {
      if (!stopped) console.error("rebendei sync commit feed failed; retrying", error);
    }).finally(() => { running = undefined; });
  }
  const timer = setInterval(wake, 50);
  timer.unref();
  wake();
  return {
    wake,
    async close() {
      stopped = true;
      clearInterval(timer);
      await running;
      await sql.close();
    },
  };
}
