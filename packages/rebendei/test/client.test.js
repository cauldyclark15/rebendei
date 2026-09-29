import { afterEach, describe, expect, test } from 'bun:test';
import { RebendeiClient, RebendeiError, RebendeiHttpClient } from '../src/client/index.js';

/** @typedef {import('bun').ServerWebSocket<undefined>} Socket */
/** @typedef {{ type: string, path?: string, args?: import('../src/client/index.js').Args, queryId?: number, requestId?: number }} ClientFrame */
/** @type {RebendeiClient[]} */
const clients = [];
/** @type {import('bun').Server<undefined>[]} */
const servers = [];
/** @type {Set<Socket>} */
const activeSockets = new Set();
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  for (const socket of activeSockets) socket.terminate();
  await waitFor(() => activeSockets.size === 0);
  // Bun 1.3.14 leaks pendingWebSockets accounting after a server-initiated drop.
  // All sockets are proven closed above; stop listening without awaiting that counter.
  for (const server of servers.splice(0)) void server.stop(true);
});

/** @param {() => unknown} condition */
async function waitFor(condition) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > 2500) throw new Error('Timed out waiting for test condition');
    await Bun.sleep(5);
  }
}
/** @param {Socket} socket @param {object} frame */
function send(socket, frame) { socket.send(JSON.stringify(frame)); }
/** @param {Socket} socket @param {string} ts @param {object[]} modifications */
function transition(socket, ts, modifications) { send(socket, { type: 'transition', ts, modifications }); }
/** @param {(socket: Socket, frame: ClientFrame) => void} [handler] */
function syncServer(handler = () => {}) {
  /** @type {{ socket: Socket, frame: ClientFrame }[]} */
  const frames = [];
  /** @type {Socket[]} */
  const sockets = [];
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname === '/sync' && server.upgrade(request)) return;
      return new Response('Not found', { status: 404 });
    },
    websocket: {
      /** @param {Socket} socket */
      close(socket) { activeSockets.delete(socket); },
      /** @param {Socket} socket */
      open(socket) {
        activeSockets.add(socket);
        sockets.push(socket);
        send(socket, { type: 'hello', server: 'rebendei', version: '1' });
      },
      /** @param {Socket} socket @param {string | Buffer} message */
      message(socket, message) {
        const frame = /** @type {ClientFrame} */ (JSON.parse(String(message)));
        frames.push({ socket, frame });
        handler(socket, frame);
      },
    },
  });
  servers.push(server);
  return { url: server.url.href, frames, sockets };
}
/** @param {string} url */
function clientFor(url) {
  const client = new RebendeiClient(url);
  clients.push(client);
  return client;
}
/** @param {{ frames: { socket: Socket, frame: ClientFrame }[] }} server @param {string} type */
function framesOf(server, type) { return server.frames.filter(item => item.frame.type === type); }

// All WebSocket tests exercise actual text frames over Bun.serve, not mocked transports.
describe('RebendeiClient subscriptions', () => {
  test('canonical arguments deduplicate subscriptions, cached one-shot queries, and refcounts', async () => {
    const server = syncServer((socket, frame) => {
      if (frame.type === 'subscribe') transition(socket, '1', [{ type: 'updated', queryId: frame.queryId, value: { count: 1 } }]);
    });
    const client = clientFor(server.url);
    /** @type {unknown[]} */
    const first = [], second = [];
    const args = { z: [1, { b: 2, a: 1 }], a: 'x' };
    const off1 = client.onUpdate('counter:get', args, value => first.push(value));
    const off2 = client.onUpdate('counter:get', { a: 'x', z: [1, { a: 1, b: 2 }] }, value => second.push(value));
    // The client's argument snapshot is not affected by subsequent caller mutation.
    args.a = 'changed';
    await waitFor(() => first.length === 1 && second.length === 1);
    expect(framesOf(server, 'subscribe')).toHaveLength(1);
    expect(first).toEqual([{ count: 1 }]);
    expect(framesOf(server, 'subscribe')[0].frame.args?.a).toBe('x');
    expect(await client.query('counter:get', { a: 'x', z: [1, { a: 1, b: 2 }] })).toEqual({ count: 1 });
    await Bun.sleep(20);
    expect(framesOf(server, 'unsubscribe')).toHaveLength(0);
    off1(); off1();
    await Bun.sleep(20);
    expect(framesOf(server, 'unsubscribe')).toHaveLength(0);
    off2();
    await waitFor(() => framesOf(server, 'unsubscribe').length === 1);
    expect(framesOf(server, 'unsubscribe')[0].frame.queryId).toBe(framesOf(server, 'subscribe')[0].frame.queryId);
  });

  test('reusing a watch callback still creates independent ref-counted listeners', async () => {
    const server = syncServer();
    const client = clientFor(server.url);
    const watch = client.watchQuery('counter:get');
    let calls = 0;
    const callback = () => { calls++; };
    const first = watch.onUpdate(callback);
    const second = watch.onUpdate(callback);
    await waitFor(() => framesOf(server, 'subscribe').length === 1);
    const { socket, frame } = framesOf(server, 'subscribe')[0];
    transition(socket, '1', [{ type: 'updated', queryId: frame.queryId, value: 1 }]);
    await waitFor(() => calls === 2);
    first();
    transition(socket, '2', [{ type: 'updated', queryId: frame.queryId, value: 2 }]);
    await waitFor(() => calls === 3);
    expect(framesOf(server, 'unsubscribe')).toHaveLength(0);
    second();
    await waitFor(() => framesOf(server, 'unsubscribe').length === 1);
  });

  test('watch is lazy, sees atomic value/error/removal changes, and releases subscriptions', async () => {
    const server = syncServer();
    const client = clientFor(server.url);
    const watch = client.watchQuery('counter:get', {});
    expect(watch.localQueryResult()).toBeUndefined();
    await waitFor(() => client.connectionState().isWebSocketConnected);
    expect(framesOf(server, 'subscribe')).toHaveLength(0);
    let notifications = 0;
    const off = watch.onUpdate(() => { notifications++; });
    await waitFor(() => framesOf(server, 'subscribe').length === 1);
    const { socket, frame } = framesOf(server, 'subscribe')[0];
    transition(socket, '1', [{ type: 'updated', queryId: frame.queryId, value: { value: 3 } }]);
    await waitFor(() => notifications === 1);
    expect(watch.localQueryResult()).toEqual({ value: 3 });
    const cached = /** @type {{ value: number }} */ (watch.localQueryResult());
    cached.value = 99;
    expect(watch.localQueryResult()).toEqual({ value: 3 });
    transition(socket, '2', [{ type: 'updated', queryId: frame.queryId, value: { value: 3 } }]);
    await Bun.sleep(20);
    expect(notifications).toBe(1);
    transition(socket, '3', [{ type: 'error', queryId: frame.queryId, errorMessage: 'denied', errorData: { code: 'AUTH' } }]);
    await waitFor(() => notifications === 2);
    expect(() => watch.localQueryResult()).toThrow(RebendeiError);
    try { watch.localQueryResult(); } catch (error) {
      expect(/** @type {RebendeiError} */ (error).data).toEqual({ code: 'AUTH' });
      expect(/** @type {Error} */ (error).message).toBe('denied');
    }
    transition(socket, '4', [{ type: 'removed', queryId: frame.queryId }]);
    await waitFor(() => notifications === 3);
    expect(watch.localQueryResult()).toBeUndefined();
    transition(socket, '5', [{ type: 'updated', queryId: frame.queryId, value: null }]);
    await waitFor(() => notifications === 4);
    expect(watch.localQueryResult()).toBeNull();
    off();
    await waitFor(() => framesOf(server, 'unsubscribe').length === 1);
  });

  test('separate arguments and paths do not deduplicate; transitions publish atomically', async () => {
    const server = syncServer();
    const client = clientFor(server.url);
    const a = client.watchQuery('counter:get', { id: 1 });
    const b = client.watchQuery('counter:get', { id: 2 });
    const c = client.watchQuery('other:get', { id: 1 });
    let atomic = false;
    a.onUpdate(() => { atomic = b.localQueryResult() === 2 && c.localQueryResult() === 3; });
    b.onUpdate(() => {}); c.onUpdate(() => {});
    await waitFor(() => framesOf(server, 'subscribe').length === 3);
    transition(server.sockets[0], '1', framesOf(server, 'subscribe').map(({ frame }, i) => ({ type: 'updated', queryId: frame.queryId, value: i + 1 })));
    await waitFor(() => atomic);
  });

  test('one-shot queries release subscriptions after success and structured/plain errors', async () => {
    const server = syncServer((socket, frame) => {
      if (frame.type !== 'subscribe') return;
      transition(socket, '1', [frame.path === 'ok:get'
        ? { type: 'updated', queryId: frame.queryId, value: ['ok'] }
        : { type: 'error', queryId: frame.queryId, errorMessage: 'bad query', ...(frame.path === 'data:get' ? { errorData: null } : {}) }]);
    });
    const client = clientFor(server.url);
    expect(await client.query('ok:get')).toEqual(['ok']);
    await expect(client.query('data:get')).rejects.toBeInstanceOf(RebendeiError);
    await expect(client.query('plain:get')).rejects.toThrow('bad query');
    await waitFor(() => framesOf(server, 'unsubscribe').length === 3);
  });

  test('onUpdate receives error modifications and user callback failures do not break peers', async () => {
    const server = syncServer();
    const client = clientFor(server.url);
    /** @type {Error[]} */
    const errors = [];
    /** @type {unknown[]} */
    const values = [];
    client.onUpdate('counter:get', {}, () => { throw new Error('listener bug'); });
    client.onUpdate('counter:get', {}, value => values.push(value), error => errors.push(error));
    await waitFor(() => framesOf(server, 'subscribe').length === 1);
    const { socket, frame } = framesOf(server, 'subscribe')[0];
    transition(socket, '1', [{ type: 'error', queryId: frame.queryId, errorMessage: 'oops' }]);
    await waitFor(() => errors.length === 1);
    expect(errors[0]).not.toBeInstanceOf(RebendeiError);
    transition(socket, '2', [{ type: 'updated', queryId: frame.queryId, value: 9 }]);
    await waitFor(() => values.length === 1);
    expect(values).toEqual([9]);
  });
});

describe('mutations, actions, and optimistic layers', () => {
  test('buffers mutationResult until its transition, with bigint timestamp precision', async () => {
    const server = syncServer((socket, frame) => {
      if (frame.type === 'subscribe') transition(socket, '9007199254740992', [{ type: 'updated', queryId: frame.queryId, value: 0 }]);
      if (frame.type === 'mutation') send(socket, { type: 'mutationResult', requestId: frame.requestId, success: true, value: 'committed', ts: '9007199254740993' });
    });
    const client = clientFor(server.url);
    const watch = client.watchQuery('counter:get');
    watch.onUpdate(() => {});
    await waitFor(() => watch.localQueryResult() === 0);
    let resolved = false;
    const mutation = client.mutation('counter:add', {}).then(value => { resolved = true; expect(watch.localQueryResult()).toBe(1); return value; });
    await waitFor(() => framesOf(server, 'mutation').length === 1);
    await Bun.sleep(30);
    expect(resolved).toBe(false);
    expect(client.connectionState()).toEqual({ isWebSocketConnected: true, hasInflightRequests: true, inflightMutations: 1, inflightActions: 0 });
    const { socket, frame } = framesOf(server, 'subscribe')[0];
    transition(socket, '9007199254740992', []);
    await Bun.sleep(20);
    expect(resolved).toBe(false);
    transition(socket, '9007199254740993', [{ type: 'updated', queryId: frame.queryId, value: 1 }]);
    expect(await mutation).toBe('committed');
    expect(client.connectionState().hasInflightRequests).toBe(false);
  });

  test('transition before mutationResult resolves immediately, including empty transitions', async () => {
    const server = syncServer((socket, frame) => {
      if (frame.type === 'mutation') {
        transition(socket, '2', []);
        send(socket, { type: 'mutationResult', requestId: frame.requestId, success: true, value: null, ts: '1' });
      }
    });
    const client = clientFor(server.url);
    expect(await client.mutation('counter:add')).toBeNull();
  });

  test('optimistic apply, rebase, delayed success removal, and failure rollback', async () => {
    const server = syncServer((socket, frame) => {
      if (frame.type === 'subscribe') transition(socket, '1', [{ type: 'updated', queryId: frame.queryId, value: 10 }]);
    });
    const client = clientFor(server.url);
    /** @type {unknown[]} */
    const values = [];
    client.onUpdate('counter:get', {}, value => values.push(value));
    await waitFor(() => values.length === 1);
    /** @type {import('../src/client/index.js').OptimisticUpdate} */
    const increment = (store, args) => {
      const previous = store.getQuery('counter:get', {});
      if (typeof previous === 'number' && typeof args.by === 'number') store.setQuery('counter:get', {}, previous + args.by);
    };
    const first = client.mutation('counter:add', { by: 1 }, { optimisticUpdate: increment });
    const second = client.mutation('counter:add', { by: 2 }, { optimisticUpdate: increment });
    const secondOutcome = second.catch(error => error);
    expect(values).toEqual([10, 11, 13]);
    await waitFor(() => framesOf(server, 'mutation').length === 2);
    const queryId = framesOf(server, 'subscribe')[0].frame.queryId;
    const socket = server.sockets[0];
    transition(socket, '2', [{ type: 'updated', queryId, value: 20 }]);
    await waitFor(() => values.at(-1) === 23);
    const requests = framesOf(server, 'mutation');
    send(socket, { type: 'mutationResult', requestId: requests[0].frame.requestId, success: true, value: 'first', ts: '3' });
    await Bun.sleep(20);
    expect(values.at(-1)).toBe(23); // Successful result alone cannot drop the layer.
    transition(socket, '3', [{ type: 'updated', queryId, value: 21 }]);
    expect(await first).toBe('first');
    expect(values.at(-1)).toBe(23); // Remaining layer rebases on the committed value.
    send(socket, { type: 'mutationResult', requestId: requests[1].frame.requestId, success: false, errorMessage: 'rolled back', errorData: { code: 'NO' } });
    const error = await secondOutcome;
    expect(error).toBeInstanceOf(RebendeiError);
    expect(error.data).toEqual({ code: 'NO' });
    expect(values.at(-1)).toBe(21);
    expect(client.connectionState().hasInflightRequests).toBe(false);
  });

  test('throwing optimistic callbacks are rejected without sending or partially applying', async () => {
    const server = syncServer((socket, frame) => {
      if (frame.type === 'subscribe') transition(socket, '1', [{ type: 'updated', queryId: frame.queryId, value: 1 }]);
    });
    const client = clientFor(server.url);
    const watch = client.watchQuery('counter:get');
    watch.onUpdate(() => {});
    await waitFor(() => watch.localQueryResult() === 1);
    await expect(client.mutation('counter:add', {}, { optimisticUpdate(store) {
      store.setQuery('counter:get', {}, 99);
      throw new Error('optimistic failure');
    } })).rejects.toThrow('optimistic failure');
    expect(watch.localQueryResult()).toBe(1);
    expect(framesOf(server, 'mutation')).toHaveLength(0);
  });

  test('actions return values/errors without transition timestamps', async () => {
    const server = syncServer((socket, frame) => {
      if (frame.type === 'action') send(socket, frame.path === 'ok:run'
        ? { type: 'actionResult', requestId: frame.requestId, success: true, value: { done: true } }
        : { type: 'actionResult', requestId: frame.requestId, success: false, errorMessage: 'action failed', errorData: 'DETAIL' });
    });
    const client = clientFor(server.url);
    expect(await client.action('ok:run')).toEqual({ done: true });
    await expect(client.action('bad:run')).rejects.toBeInstanceOf(RebendeiError);
  });
});

describe('connections and lifecycle', () => {
  test('reconnect resubscribes, rejects pending mutations/actions, rolls back, and never replays writes', async () => {
    let subscribeCount = 0;
    const server = syncServer((socket, frame) => {
      if (frame.type === 'subscribe') transition(socket, String(++subscribeCount), [{ type: 'updated', queryId: frame.queryId, value: subscribeCount }]);
    });
    const client = clientFor(server.url.replace('http:', 'ws:'));
    const watch = client.watchQuery('counter:get');
    watch.onUpdate(() => {});
    await waitFor(() => watch.localQueryResult() === 1);
    const mutation = client.mutation('counter:add', {}, { optimisticUpdate(store) { store.setQuery('counter:get', {}, 99); } }).catch(error => error);
    const action = client.action('slow:run').catch(error => error);
    expect(watch.localQueryResult()).toBe(99);
    expect(client.connectionState().inflightActions).toBe(1);
    await waitFor(() => framesOf(server, 'mutation').length === 1 && framesOf(server, 'action').length === 1);
    server.sockets[0].terminate();
    expect((await mutation).message).toMatch(/connection lost/i);
    expect((await action).message).toMatch(/connection lost/i);
    expect(watch.localQueryResult()).toBe(1);
    await waitFor(() => server.sockets.length === 2 && watch.localQueryResult() === 2);
    expect(framesOf(server, 'subscribe')).toHaveLength(2);
    expect(framesOf(server, 'mutation')).toHaveLength(1);
    expect(framesOf(server, 'action')).toHaveLength(1);
    expect(client.connectionState().hasInflightRequests).toBe(false);
  });

  test('close rejects requests, releases listeners, is idempotent, and prevents reconnects', async () => {
    const server = syncServer();
    const client = clientFor(server.url);
    const query = client.query('slow:get').catch(error => error);
    const mutation = client.mutation('slow:add').catch(error => error);
    await waitFor(() => framesOf(server, 'mutation').length === 1);
    await client.close(); await client.close();
    expect((await mutation).message).toMatch(/closed/);
    // Watches have no result yet; closing must reject the one-shot query too.
    expect((await query).message).toMatch(/closed/);
    await expect(client.action('x:run')).rejects.toThrow('closed');
    expect(() => client.onUpdate('x:get', {}, () => {})).toThrow('closed');
    await Bun.sleep(150);
    expect(server.sockets).toHaveLength(1);
    expect(client.connectionState()).toEqual({ isWebSocketConnected: false, hasInflightRequests: false, inflightMutations: 0, inflightActions: 0 });
  });
});

const nodeExecutable = Bun.which('node');
test.skipIf(!nodeExecutable)('native Node can import and use both clients without Bun globals', async () => {
  const sync = syncServer((socket, frame) => {
    if (frame.type === 'subscribe') transition(socket, '1', [{ type: 'updated', queryId: frame.queryId, value: frame.args }]);
    if (frame.type === 'mutation') {
      transition(socket, '2', []);
      send(socket, { type: 'mutationResult', requestId: frame.requestId, success: true, value: 'committed', ts: '2' });
    }
    if (frame.type === 'action') send(socket, { type: 'actionResult', requestId: frame.requestId, success: true, value: 'done' });
  });
  const http = Bun.serve({
    port: 0,
    async fetch(request) { return Response.json({ status: 'success', value: (await request.json()).args }); },
  });
  servers.push(http);
  const fixture = new URL('./client-fixtures/node-smoke.js', import.meta.url).pathname;
  const process = Bun.spawn([/** @type {string} */ (nodeExecutable), fixture, sync.url, http.url.href], { stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  expect(stderr).toBe('');
  expect(exitCode).toBe(0);
  expect(stdout).toContain('Node WebSocket and HTTP smoke passed');
});

describe('RebendeiHttpClient', () => {
  test('HTTP success/error shapes and method/path/args against an actual server', async () => {
    /** @type {{ endpoint: string, body: unknown, method: string, contentType: string | null }[]} */
    const received = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json();
        received.push({ endpoint: new URL(request.url).pathname, body, method: request.method, contentType: request.headers.get('content-type') });
        if (body.path === 'data:fail') return Response.json({ status: 'error', errorMessage: 'validation', errorData: { field: 'name' } }, { status: 400 });
        if (body.path === 'plain:fail') return Response.json({ status: 'error', errorMessage: 'unknown function' }, { status: 404 });
        if (body.path === 'null:fail') return Response.json({ status: 'error', errorMessage: 'null data', errorData: null }, { status: 400 });
        if (body.path === 'invalid:run') return new Response('not json', { status: 502 });
        if (body.path === 'malformed:run') return Response.json({ status: 'success' });
        return Response.json({ status: 'success', value: body.args, ts: '2' });
      },
    });
    servers.push(server);
    let fetchCalls = 0;
    const http = new RebendeiHttpClient(server.url.href.replace('http:', 'ws:'), { fetch: (input, init) => { fetchCalls++; return fetch(input, init); } });
    expect(await http.query('test:get', { x: 1 })).toEqual({ x: 1 });
    expect(await http.mutation('test:add', { x: 2 })).toEqual({ x: 2 });
    expect(await http.action('test:run', { x: 3 })).toEqual({ x: 3 });
    expect(received.slice(0, 3)).toEqual([
      { endpoint: '/api/query', body: { path: 'test:get', args: { x: 1 } }, method: 'POST', contentType: 'application/json' },
      { endpoint: '/api/mutation', body: { path: 'test:add', args: { x: 2 } }, method: 'POST', contentType: 'application/json' },
      { endpoint: '/api/action', body: { path: 'test:run', args: { x: 3 } }, method: 'POST', contentType: 'application/json' },
    ]);
    const error = await http.query('data:fail').catch(error => error);
    expect(error).toBeInstanceOf(RebendeiError);
    expect(error.message).toBe('validation');
    expect(error.data).toEqual({ field: 'name' });
    await expect(http.mutation('plain:fail')).rejects.toThrow('unknown function');
    const nullError = await http.action('null:fail').catch(error => error);
    expect(nullError).toBeInstanceOf(RebendeiError);
    expect(nullError.data).toBeNull();
    await expect(http.action('invalid:run')).rejects.toThrow('expected JSON');
    await expect(http.action('malformed:run')).rejects.toThrow('Invalid Rebendei HTTP response');
    expect(fetchCalls).toBe(8);
  });

  test('fetch uses the global receiver required by browser-native implementations', async () => {
    const http = new RebendeiHttpClient('http://localhost', {
      /** @this {typeof globalThis} */
      async fetch() {
        if (this !== globalThis) throw new TypeError('Illegal invocation');
        return Response.json({ status: 'success', value: 'bound' });
      },
    });
    expect(await http.query('x:get')).toBe('bound');
  });

  test('validates JSON arguments and URL schemes before transport', async () => {
    expect(() => new RebendeiHttpClient('file:///secret')).toThrow('URL');
    expect(() => new RebendeiClient('ftp://localhost')).toThrow('URL');
    const http = new RebendeiHttpClient('http://localhost');
    await expect(http.query('x:get', { bad: NaN })).rejects.toThrow('JSON');
  });
});
