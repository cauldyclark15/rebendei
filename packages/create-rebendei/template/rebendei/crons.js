import { cronJobs } from "rebendei/server";

const crons = cronJobs();
crons.daily("daily-example", { hourUTC: 9, minuteUTC: 0 }, "messages:dailyTick", {});
export default crons;
