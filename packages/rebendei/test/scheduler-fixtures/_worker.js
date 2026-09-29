import { createEngine } from "../../src/engine/index.js";
import { connect } from "../../src/db.js";
const sql = connect();
const engine = await createEngine({ sql, functionsDir: import.meta.dir });
console.log("worker-ready");
const hold = setInterval(() => {}, 1000);
process.on("SIGTERM", async () => { clearInterval(hold); await engine.close(); await sql.close(); process.exit(0); });
