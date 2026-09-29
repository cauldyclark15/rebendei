import { action } from "../../../src/api.js";
export const run = action({ handler: () => "nested action" });
export default action({ handler: (ctx) => ctx.runAction("ai/embed:run", {}) });
