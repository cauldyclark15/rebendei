// Each feature registers engine hooks. One module per feature; each lane owns its own file.
import { install as installScheduler } from "./scheduler/index.js";
import { install as installVector } from "./vector/index.js";

/** @param {any} engine */
export async function installFeatures(engine) {
  await installScheduler(engine);
  await installVector(engine);
}
