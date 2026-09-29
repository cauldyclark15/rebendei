import { RebendeiClient } from "../../src/client/index.js";
/** @param {()=>boolean} predicate @param {number} [timeout] */
export async function waitFor(predicate, timeout = 5000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) { if (performance.now() > deadline) throw new Error("Timed out waiting for sync"); await Bun.sleep(5); }
}
/** @param {string} url */
export function clientWithFrames(url) {
  /** @type {any[]} */ const frames = [];
  class RecordingSocket extends WebSocket {
    /** @param {string|URL} address @param {string|string[]} [protocols] */
    constructor(address, protocols) {
      super(address, protocols);
      this.addEventListener("message", event => { if (typeof event.data === "string") frames.push(JSON.parse(event.data)); });
    }
  }
  return { client: new RebendeiClient(url, { WebSocket: RecordingSocket }), frames };
}
