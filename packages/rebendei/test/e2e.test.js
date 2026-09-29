import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { RebendeiClient } from "../src/client/index.js";
import { fakeProvider } from "./e2e-fixtures/provider.js";

const checkout = resolve(import.meta.dir, "../../..");
/** @type {Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined} */ let cli;
/** @type {ReturnType<typeof fakeProvider> | undefined} */ let provider;
/** @type {RebendeiClient | undefined} */ let clientA;
/** @type {RebendeiClient | undefined} */ let clientB;
/** @type {Promise<void>[]} */ const readers = [];
/** @type {(() => void)[]} */ const subscriptions = [];
let directory = "", app = "", url = "", stdout = "", stderr = "";
/** @type {Record<string,string|undefined>} */ let appEnv;

/** @param {ReadableStream<Uint8Array>} stream @param {(text:string)=>void} append */
async function drain(stream, append) {
  const reader = stream.getReader(), decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      append(decoder.decode(value, { stream: true }));
    }
    append(decoder.decode());
  } finally { reader.releaseLock(); }
}

/** Poll only observable results, with a bounded timeout and useful CLI diagnostics.
 * @param {()=>unknown|Promise<unknown>} check @param {string} label @param {number} [timeout]
 */
async function until(check, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    if (cli?.exitCode !== null && cli?.exitCode !== undefined) break;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out: ${label}\nCLI stdout: ${stdout}\nCLI stderr: ${stderr}`);
}

/** @param {RebendeiClient} client @param {string} path @param {import('../src/client/index.js').Args} args */
function watch(client, path, args) {
  /** @type {any} */ let value;
  /** @type {Error | undefined} */ let error;
  let updates = 0;
  subscriptions.push(client.onUpdate(path, args, (next) => { value = next; updates++; }, (next) => { error = next; }));
  return {
    get value() { if (error) throw error; return value; },
    get updates() { return updates; },
  };
}

/** @param {'query'|'mutation'|'action'} kind @param {string} path @param {object} args */
const post = (kind, path, args) => fetch(`${url}/api/${kind}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, args }),
});

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL to an isolated Postgres + pgvector test database");
  directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "rebendei-e2e-"));
  app = join(directory, "app");
  const generated = Bun.spawnSync(["node", join(checkout, "packages/create-rebendei/index.js"), app, "--no-install", "--no-git"]);
  expect(generated.exitCode).toBe(0);
  await mkdir(join(app, "node_modules"));
  await symlink(join(checkout, "packages/rebendei"), join(app, "node_modules/rebendei"), "dir");
  provider = fakeProvider(768);
  const variables = {
    DATABASE_URL: process.env.DATABASE_URL,
    PORT: "0", // The real CLI binds a random free port and reports it on stdout.
    EMBEDDING_BASE_URL: provider.baseURL, EMBEDDING_MODEL: "e2e-bag-of-words", EMBEDDING_DIMENSIONS: "768",
    EMBEDDING_API_KEY: "", CHAT_BASE_URL: provider.baseURL, CHAT_MODEL: "e2e-source-line", CHAT_API_KEY: "",
  };
  await writeFile(join(app, ".env"), Object.entries(variables).map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
  appEnv = { ...process.env, ...variables };
  cli = Bun.spawn(["bun", join(checkout, "packages/rebendei/bin/rebendei.js"), "dev"], {
    cwd: app, env: appEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  readers.push(drain(cli.stdout, (text) => { stdout += text; }), drain(cli.stderr, (text) => { stderr += text; }));
  await until(() => {
    const port = stdout.match(/rebendei listening on http:\/\/localhost:(\d+)/)?.[1];
    if (port) { url = `http://127.0.0.1:${port}`; return true; }
    return false;
  }, "CLI listening", 15000);
  await until(async () => {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
      const health = await response.json();
      return response.ok && health.ok && health.database === "up" && typeof health.pgvector === "string";
    } catch { return false; }
  }, "healthy Postgres and pgvector");
  clientA = new RebendeiClient(url);
  clientB = new RebendeiClient(url);
  // Idempotent reruns: remove only this example's namespace entries via public API.
  while (true) {
    const existing = /** @type {any} */ (await clientB.query("knowledge:entries", {}));
    if (!existing.page.length) break;
    for (const entry of existing.page) await clientB.mutation("knowledge:remove", { key: entry.key });
  }
}, 20000);

afterAll(async () => {
  for (const stop of subscriptions) stop();
  await Promise.all([clientA?.close(), clientB?.close()]);
  if (cli) {
    cli.kill("SIGTERM");
    const killer = setTimeout(() => cli?.kill("SIGKILL"), 3000);
    await cli.exited;
    clearTimeout(killer);
    await Promise.all(readers);
  }
  provider?.server.stop(true);
  if (directory) await rm(directory, { recursive: true, force: true });
}, 10000);

test("generated app: real CLI, live clients, HTTP, scheduler, RAG and Bun demo", async () => {
  const a = /** @type {RebendeiClient} */ (clientA), b = /** @type {RebendeiClient} */ (clientB);
  const channel = `e2e-${crypto.randomUUID()}`;
  const messagesA = watch(a, "messages:list", { channel });
  const messagesB = watch(b, "messages:list", { channel });
  await until(() => messagesA.value !== undefined && messagesB.value !== undefined, "both initial subscriptions");
  expect(messagesA.value).toEqual([]);
  expect(messagesB.value).toEqual([]);
  const sent = await b.mutation("messages:send", { author: "B", body: "Hello live app", channel });
  // No polling: B's own subscription must show its write at promise resolution.
  expect(messagesB.value.map((/** @type {any} */ message) => message._id)).toContain(sent);
  await until(() => messagesA.value.some((/** @type {any} */ message) => message._id === sent), "cross-client live message");
  expect(messagesA.updates).toBeGreaterThan(1);

  const mutation = await post("mutation", "messages:send", { author: "HTTP", body: "Hello HTTP", channel });
  expect(mutation.status).toBe(200);
  const inserted = await mutation.json();
  expect(inserted.status).toBe("success");
  expect(inserted.ts).toMatch(/^\d+$/);
  const queried = await post("query", "messages:list", { channel });
  expect(queried.status).toBe(200);
  const result = await queried.json();
  expect(result.status).toBe("success");
  expect(result.value.map((/** @type {any} */ message) => message.body)).toEqual(["Hello HTTP", "Hello live app"]);
  const hidden = await post("mutation", "messages:clear", { channel });
  expect(hidden.status).toBe(404);
  expect((await hidden.json()).status).toBe("error");
  await expect(b.mutation("messages:clear", { channel })).rejects.toThrow("Function not found");
  const invalid = await post("mutation", "messages:send", { author: "HTTP", body: 123, channel });
  expect(invalid.status).toBe(400);

  await b.mutation("messages:send", { author: "B", body: "/remind drink water", channel });
  await until(() => messagesA.value.some((/** @type {any} */ message) =>
    message.author === "scheduler" && message.body === "Reminder: drink water"), "scheduled follow-up", 5000);
  expect(messagesA.value.filter((/** @type {any} */ message) => message.author === "scheduler")).toHaveLength(1);

  const entries = watch(a, "knowledge:entries", {});
  await until(() => entries.value !== undefined, "initial live knowledge entries");
  expect(entries.value.page).toEqual([]);
  const documents = [
    { key: "orchard", title: "Orchard guide", text: "Apple orchard harvest: pick ripe apples in autumn.", source: "garden" },
    { key: "space", title: "Space guide", text: "Rocket astronauts travel through planetary orbit.", source: "science" },
    { key: "bread", title: "Bread guide", text: "Bread dough needs flour yeast water and kneading.", source: "kitchen" },
  ];
  for (const [index, document] of documents.entries()) {
    const added = /** @type {any} */ (await b.action("knowledge:ingest", document));
    expect(added.status).toBe("ready");
    expect(added.created).toBe(true);
    await until(() => entries.value.page.length === index + 1, `live ingestion ${document.key}`);
    expect(entries.value.page.map((/** @type {any} */ entry) => entry.key)).toContain(document.key);
  }
  const found = /** @type {any} */ (await b.action("knowledge:search", { query: "apple orchard harvest" }));
  expect(found.results[0].key).toBe("orchard");
  expect(found.entries[0].title).toBe("Orchard guide");
  const filtered = /** @type {any} */ (await b.action("knowledge:search", { query: "apple orchard harvest", source: "garden" }));
  expect(filtered.entries.map((/** @type {any} */ entry) => entry.key)).toEqual(["orchard"]);
  const answer = /** @type {any} */ (await b.action("knowledge:ask", { question: "apple orchard harvest" }));
  expect(answer.text).toBe(`${documents[0].text} [1]`);
  expect(answer.context.entries[0].key).toBe("orchard");
  expect(answer.context.results[0].content[0].text).toBe(documents[0].text);
  expect(provider?.chatRequests).toBe(1);
  const embeddingRequests = provider?.embeddingRequests;
  const unchanged = /** @type {any} */ (await b.action("knowledge:ingest", documents[0]));
  expect(unchanged.status).toBe("unchanged");
  expect(unchanged.created).toBe(false);
  expect(provider?.embeddingRequests).toBe(embeddingRequests);
  expect(await b.mutation("knowledge:remove", { key: "orchard" })).toBe(true);
  await until(() => entries.value.page.length === 2, "live RAG deletion");
  expect(entries.value.page.map((/** @type {any} */ entry) => entry.key)).not.toContain("orchard");
  for (const document of documents.slice(1)) await b.mutation("knowledge:remove", { key: document.key });
  await until(() => entries.value.page.length === 0, "live knowledge cleanup");

  const demo = Bun.spawn(["bun", "scripts/demo.js"], {
    cwd: app, env: { ...appEnv, REBENDEI_URL: url }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const killer = setTimeout(() => demo.kill("SIGKILL"), 12000);
  try {
    const [output, errors, code] = await Promise.all([
      new Response(demo.stdout).text(), new Response(demo.stderr).text(), demo.exited,
    ]);
    expect(errors).toBe("");
    expect(code).toBe(0);
    expect(output).toContain("Demo complete: sent 3 messages and observed live updates.");
    expect(output).toContain("Hello Rebendei");
    expect(output).toContain("Queries update live");
    expect(output).toContain("Ready for AI");
  } finally { clearTimeout(killer); if (demo.exitCode === null) demo.kill("SIGKILL"); }
}, 40000);
