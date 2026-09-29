import { assertValue } from "../values/index.js";

/** @typedef {{type:'interval',ms:number}|{type:'cron',expression:string}} CronSpec */
/** @typedef {{name:string,spec:CronSpec,path:string,args:any}} CronDefinition */
/** @param {string} field @param {number} min @param {number} max */
function parseField(field, min, max) {
  const values = new Set();
  for (const part of field.split(",")) {
    if (!/^(\*|\d+(?:-\d+)?)(?:\/\d+)?$/.test(part)) throw new Error(`Invalid cron field: ${field}`);
    const [base, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isSafeInteger(step) || step < 1) throw new Error("Invalid cron step");
    const range = base.split("-").map(Number);
    const start = base === "*" ? min : range[0];
    const end = base === "*" ? max : range.length === 2 ? range[1] : stepText ? max : start;
    if (start < min || end > max || start > end) throw new Error(`Cron field out of range: ${field}`);
    for (let n = start; n <= end; n += step) values.add(max === 7 && n === 7 ? 0 : n);
  }
  return values;
}
/** Parse five numeric UTC fields. DOM and DOW use standard cron OR semantics when both restricted.
 * @param {string} expression */
export function parseCron(expression) {
  if (typeof expression !== "string") throw new Error("Cron expression must be a string");
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron expression requires five fields");
  const minute = parseField(fields[0], 0, 59), hour = parseField(fields[1], 0, 23);
  const dom = parseField(fields[2], 1, 31), month = parseField(fields[3], 1, 12), dow = parseField(fields[4], 0, 7);
  return { minute, hour, dom, month, dow, domAny: fields[2].startsWith("*"), dowAny: fields[4].startsWith("*") };
}
/** @param {ReturnType<typeof parseCron>} parsed @param {Date} date */
export function matchesCron(parsed, date) {
  const day = parsed.dom.has(date.getUTCDate()), week = parsed.dow.has(date.getUTCDay());
  const dayMatches = parsed.domAny ? week : parsed.dowAny ? day : day || week;
  return parsed.minute.has(date.getUTCMinutes()) && parsed.hour.has(date.getUTCHours()) && parsed.month.has(date.getUTCMonth() + 1) && dayMatches;
}
/** Strictly after `after`, with a bounded Gregorian-calendar search (includes leap-century gaps).
 * @param {CronSpec} spec @param {number} after */
export function nextRun(spec, after) {
  if (!Number.isFinite(after)) throw new Error("Invalid cron timestamp");
  if (spec.type === "interval") return after + spec.ms;
  const parsed = parseCron(spec.expression);
  const date = new Date(Math.floor(after / 60000) * 60000 + 60000);
  const limit = date.getUTCFullYear() + 9;
  while (date.getUTCFullYear() < limit) {
    if (!parsed.month.has(date.getUTCMonth() + 1)) { date.setUTCMonth(date.getUTCMonth() + 1, 1); date.setUTCHours(0, 0, 0, 0); continue; }
    const day = parsed.dom.has(date.getUTCDate()), week = parsed.dow.has(date.getUTCDay());
    if (!(parsed.domAny ? week : parsed.dowAny ? day : day || week)) { date.setUTCDate(date.getUTCDate() + 1); date.setUTCHours(0, 0, 0, 0); continue; }
    if (!parsed.hour.has(date.getUTCHours())) { date.setUTCHours(date.getUTCHours() + 1, 0, 0, 0); continue; }
    if (matchesCron(parsed, date)) return date.getTime();
    date.setUTCMinutes(date.getUTCMinutes() + 1);
  }
  throw new Error("Cron expression has no occurrence within nine years");
}
/** @param {number} value @param {number} min @param {number} max @param {string} name */
function integer(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
export function cronJobs() {
  /** @type {Map<string,CronDefinition>} */ const definitions = new Map();
  /** @param {string} name @param {CronSpec} spec @param {string} path @param {any} args */
  function add(name, spec, path, args) {
    if (typeof name !== "string" || !name.trim()) throw new Error("Cron name required");
    if (definitions.has(name)) throw new Error(`Duplicate cron name: ${name}`);
    if (typeof path !== "string" || !path) throw new Error("Function path required");
    assertValue(args, "args"); nextRun(spec, Date.now());
    definitions.set(name, { name, spec, path, args: structuredClone(args) });
  }
  return {
    /** Snapshot, so callers cannot mutate registered definitions. */
    get definitions() { return structuredClone([...definitions.values()]); },
    /** @param {string} name @param {{seconds?:number,minutes?:number,hours?:number}} duration @param {string} path @param {any} [args] */
    interval(name, duration, path, args = {}) {
      const entries = Object.entries(duration);
      if (entries.length !== 1 || !["seconds", "minutes", "hours"].includes(entries[0][0])) throw new Error("Interval requires exactly one of seconds, minutes, hours");
      const [unit, value] = entries[0];
      const ms = value * ({ seconds: 1000, minutes: 60000, hours: 3600000 }[unit] ?? 0);
      if (typeof value !== "number" || !Number.isFinite(ms) || ms < 1) throw new Error("Interval must be at least one millisecond");
      add(name, { type: "interval", ms }, path, args);
    },
    /** @param {string} name @param {string} expression @param {string} path @param {any} [args] */
    cron(name, expression, path, args = {}) { parseCron(expression); add(name, { type: "cron", expression }, path, args); },
    /** @param {string} name @param {{minuteUTC:number}} time @param {string} path @param {any} [args] */
    hourly(name, { minuteUTC }, path, args = {}) { this.cron(name, `${integer(minuteUTC, 0, 59, "minuteUTC")} * * * *`, path, args); },
    /** @param {string} name @param {{hourUTC:number,minuteUTC:number}} time @param {string} path @param {any} [args] */
    daily(name, { hourUTC, minuteUTC }, path, args = {}) { this.cron(name, `${integer(minuteUTC, 0, 59, "minuteUTC")} ${integer(hourUTC, 0, 23, "hourUTC")} * * *`, path, args); },
    /** @param {string} name @param {{dayOfWeek:number,hourUTC:number,minuteUTC:number}} time @param {string} path @param {any} [args] */
    weekly(name, { dayOfWeek, hourUTC, minuteUTC }, path, args = {}) { this.cron(name, `${integer(minuteUTC, 0, 59, "minuteUTC")} ${integer(hourUTC, 0, 23, "hourUTC")} * * ${integer(dayOfWeek, 0, 7, "dayOfWeek")}`, path, args); },
    /** @param {string} name @param {{day:number,hourUTC:number,minuteUTC:number}} time @param {string} path @param {any} [args] */
    monthly(name, { day, hourUTC, minuteUTC }, path, args = {}) { this.cron(name, `${integer(minuteUTC, 0, 59, "minuteUTC")} ${integer(hourUTC, 0, 23, "hourUTC")} ${integer(day, 1, 31, "day")} * *`, path, args); },
  };
}
