import { expect, test } from "bun:test";
import { cronJobs, parseCron, matchesCron, nextRun } from "../src/scheduler/crons.js";

/** @param {string} expression @param {string} after */
const next = (expression, after) => new Date(nextRun({ type: "cron", expression }, Date.parse(after))).toISOString();
test("five-field UTC parser supports wildcards, lists, ranges, and steps", () => {
  const parsed = parseCron("*/15 9-17/2 * 1,6-8 1-5");
  expect([...parsed.minute]).toEqual([0, 15, 30, 45]);
  expect([...parsed.hour]).toEqual([9, 11, 13, 15, 17]);
  expect([...parsed.month]).toEqual([1, 6, 7, 8]);
  expect(matchesCron(parsed, new Date("2026-01-05T11:30:00Z"))).toBe(true);
  expect(matchesCron(parsed, new Date("2026-01-04T11:30:00Z"))).toBe(false);
  expect([...parseCron("5/20 * * * *").minute]).toEqual([5, 25, 45]);
});
test("Sunday 0/7 aliases, day ranges, and standard DOM/DOW OR semantics", () => {
  expect(next("0 9 * * 0", "2026-01-03T00:00:00Z")).toBe("2026-01-04T09:00:00.000Z");
  expect(next("0 9 * * 7", "2026-01-03T00:00:00Z")).toBe("2026-01-04T09:00:00.000Z");
  expect([...parseCron("* * * * 5-7").dow]).toEqual([5, 6, 0]);
  expect(next("0 0 15 * 1", "2026-01-04T00:00:00Z")).toBe("2026-01-05T00:00:00.000Z");
  expect(next("0 0 15 * 1", "2026-01-14T00:00:00Z")).toBe("2026-01-15T00:00:00.000Z");
});
test("next occurrence is strictly later, rolls months/years and handles leap dates", () => {
  expect(next("* * * * *", "2026-01-01T00:00:00Z")).toBe("2026-01-01T00:01:00.000Z");
  expect(next("0 0 1 1 *", "2026-01-01T00:00:00Z")).toBe("2027-01-01T00:00:00.000Z");
  expect(next("0 0 29 2 *", "2096-03-01T00:00:00Z")).toBe("2104-02-29T00:00:00.000Z");
  expect(() => next("0 0 31 2 *", "2026-01-01T00:00:00Z")).toThrow("no occurrence");
});
test("invalid expressions and durations reject early", () => {
  for (const expression of ["* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "*/0 * * * *", "*/-1 * * * *", "5-1 * * * *", "1,,2 * * * *", "MON * * * *", "1.5 * * * *"]) {
    expect(() => parseCron(expression)).toThrow();
  }
  const jobs = cronJobs();
  for (const duration of [{ seconds: 0 }, { seconds: -1 }, { seconds: Infinity }, {}, { seconds: 1, minutes: 1 }]) expect(() => jobs.interval("bad", duration, "jobs:record")).toThrow();
});
test("definition helpers validate schedules, duplicate names, and immutable snapshots", () => {
  const jobs = cronJobs();
  jobs.interval("interval", { minutes: 1 }, "jobs:record");
  jobs.hourly("hour", { minuteUTC: 5 }, "jobs:record");
  jobs.daily("day", { hourUTC: 9, minuteUTC: 15 }, "jobs:record");
  jobs.weekly("week", { dayOfWeek: 7, hourUTC: 3, minuteUTC: 4 }, "jobs:record");
  jobs.monthly("month", { day: 31, hourUTC: 0, minuteUTC: 0 }, "jobs:record");
  expect(jobs.definitions.map((d) => d.spec)).toEqual([
    { type: "interval", ms: 60000 }, { type: "cron", expression: "5 * * * *" },
    { type: "cron", expression: "15 9 * * *" }, { type: "cron", expression: "4 3 * * 7" }, { type: "cron", expression: "0 0 31 * *" },
  ]);
  expect(() => jobs.cron("interval", "* * * * *", "jobs:record")).toThrow("Duplicate");
  expect(() => jobs.hourly("bad", { minuteUTC: 60 }, "jobs:record")).toThrow("minuteUTC");
  jobs.definitions[0].path = "broken";
  expect(jobs.definitions[0].path).toBe("jobs:record");
});
