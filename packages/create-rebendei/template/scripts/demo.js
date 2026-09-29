import { RebendeiClient } from "rebendei/client";

// Run with `bun run demo` while `bun run dev` is running in another terminal.
const client = new RebendeiClient(process.env.REBENDEI_URL ?? `http://localhost:${process.env.PORT ?? 3210}`);
const channel = "demo";
/** @type {import('rebendei/client').JsonValue} */
let latest = null;
let stop = () => {};
/** @type {ReturnType<typeof setTimeout> | undefined} */
let timer;

async function demo() {
  await new Promise((resolve, reject) => {
    stop = client.onUpdate("messages:list", { channel }, (messages) => {
      latest = messages;
      console.log("Live messages:", JSON.stringify(messages));
      resolve(undefined);
    }, reject);
  });
  for (const body of ["Hello Rebendei", "Queries update live", "Ready for AI"]) {
    const id = await client.mutation("messages:send", { author: "demo", body, channel });
    // Mutation promises resolve only after this client's subscriptions catch up.
    if (!Array.isArray(latest) || !latest.some((message) =>
      message && typeof message === "object" && !Array.isArray(message) && message._id === id)) {
      throw new Error("Live query did not observe its own mutation");
    }
  }
  console.log("Demo complete: sent 3 messages and observed live updates.");
}

try {
  await Promise.race([
    demo(),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Demo timed out. Is Rebendei running?")), 10000);
    }),
  ]);
} finally {
  clearTimeout(timer);
  stop();
  await client.close();
}
