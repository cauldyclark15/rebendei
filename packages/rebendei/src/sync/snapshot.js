/** Runs subscribed queries inside the sync batch's shared snapshot transaction.
 * Savepoints isolate a failing SQL query from the rest of the batch.
 * @param {Awaited<ReturnType<typeof import('../engine/index.js').createEngine>>} engine
 */
export async function createSnapshotQueries(engine) {
  return {
    /** @param {import('bun').TransactionSQL} tx @param {string} path @param {any} args @param {import('../engine/types.js').ReadSet} readSet */
    async run(tx, path, args, readSet) {
      return tx.savepoint(async (sp) => {
        return (await engine.runQueryInTransaction(/** @type {any} */ (sp), path, args, { readSet })).value;
      });
    },
    close() {},
  };
}
