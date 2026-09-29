export const REBENDEI_COMMIT_LOCK = 726232341;
/** @param {import('bun').SQL} sql @param {(tx:import('bun').TransactionSQL)=>Promise<any>} execute */
export async function mutationTransaction(sql, execute) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await sql.begin("ISOLATION LEVEL SERIALIZABLE", async (tx) => {
        const { value, writes } = await execute(tx);
        await tx`SELECT pg_advisory_xact_lock(${REBENDEI_COMMIT_LOCK})`;
        const [row] = await tx`SELECT nextval('commit_ts')::text AS ts`;
        const ts = String(row.ts);
        await tx`INSERT INTO commits (ts, writes) VALUES (${ts}::bigint, ${writes}::jsonb)`;
        await tx`SELECT pg_notify('rebendei_commit', ${ts})`;
        return { value, writes, ts };
      });
    } catch (error) {
      const code = /** @type {any} */ (error).errno ?? /** @type {any} */ (error).code;
      if (!["40001", "40P01"].includes(code) || attempt >= 8) throw error;
      await Bun.sleep(Math.min(50, 2 ** attempt) * (0.5 + Math.random()));
    }
  }
}
/** @param {import('bun').SQL} sql @param {(tx:import('bun').TransactionSQL)=>Promise<any>} execute */
export async function queryTransaction(sql, execute) {
  return sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (tx) => {
    const [row] = await tx`SELECT COALESCE(max(ts), 0)::text AS ts FROM commits`;
    const result = await execute(tx);
    return { ...result, ts: String(row.ts) };
  });
}
