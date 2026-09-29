import { SQL } from "bun";
import { config } from "./config.js";

/** @param {string} [url] */
export function connect(url = config.databaseUrl) {
  return new SQL(url);
}
