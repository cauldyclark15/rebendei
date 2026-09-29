import { cronJobs } from "../../src/api.js";
const crons = cronJobs();
if (process.env.REBENDEI_SCHEDULER_TEST_CRON === "1") crons.interval("heartbeat", { seconds: 1 }, "jobs:record", { cron: true });
if (process.env.REBENDEI_SCHEDULER_TEST_CRON === "calendar") crons.cron("calendar", "0 0 1 1 *", "jobs:record", { version: process.env.REBENDEI_SCHEDULER_TEST_CRON_VERSION ?? "first" });
export default crons;
