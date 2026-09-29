/**
 * Browser, Node, and Bun clients. No server/runtime-specific imports.
 * @typedef {null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }} JsonValue
 * @typedef {{ [key: string]: JsonValue }} Args
 * @typedef {{ kind: 'missing' } | { kind: 'value', value: JsonValue } | { kind: 'error', error: Error }} Result
 * @typedef {{ id: number, key: string, path: string, args: Args, server: Result, result: Result, listeners: Set<() => void> }} Subscription
 * @typedef {{ getQuery: (path: string, args?: Args) => JsonValue | undefined, setQuery: (path: string, args: Args, value: JsonValue) => void }} LocalStore
 * @typedef {(store: LocalStore, args: Args) => void} OptimisticUpdate
 * @typedef {{ kind: 'mutation' | 'action', path: string, args: Args, resolve: (value: JsonValue) => void, reject: (error: Error) => void, optimistic?: OptimisticUpdate, result?: { value: JsonValue, ts: bigint } }} Request
 * @typedef {{ errorMessage?: string, errorData?: JsonValue }} WireError
 * @typedef {WireError & { type: string, queryId?: number, value?: JsonValue }} Modification
 * @typedef {WireError & { type: string, ts?: string, modifications?: Modification[], requestId?: number, success?: boolean, value?: JsonValue }} Frame
 */

/** A user-defined server error, retaining its JSON data. */
export class RebendeiError extends Error {
  /** @param {JsonValue} data @param {string} [message] */
  constructor(data, message) {
    super(message ?? (typeof data === 'string' ? data : JSON.stringify(data)));
    this.name = 'RebendeiError';
    this.data = data;
  }
}

/** @param {WireError} payload */
function serverError(payload) {
  const message = payload.errorMessage ?? 'Rebendei request failed';
  return Object.hasOwn(payload, 'errorData')
    ? new RebendeiError(/** @type {JsonValue} */ (payload.errorData), message)
    : new Error(message);
}

/** Canonical JSON: validates JSON inputs and sorts object keys recursively.
 * @param {JsonValue} value @returns {string}
 */
function stableStringify(value) {
  const seen = new Set();
  /** @param {JsonValue} input @returns {JsonValue} */
  function normalize(input) {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (typeof input !== 'object' || input === null) throw new TypeError('Expected a JSON value');
    if (seen.has(input)) throw new TypeError('JSON values cannot contain cycles');
    seen.add(input);
    /** @type {JsonValue} */
    let output;
    if (Array.isArray(input)) {
      output = Array.from(input, normalize);
    } else {
      const proto = Object.getPrototypeOf(input);
      if (proto !== Object.prototype && proto !== null) throw new TypeError('Expected a plain JSON object');
      output = Object.fromEntries(Object.keys(input).sort().map(key => [key, normalize(input[key])]));
    }
    seen.delete(input);
    return output;
  }
  return JSON.stringify(normalize(value));
}

/** @param {JsonValue} value @returns {JsonValue} */
function clone(value) { return JSON.parse(stableStringify(value)); }
/** @param {string} path @param {Args} args */
function queryKey(path, args) { return JSON.stringify([path, stableStringify(args)]); }
/** @param {string} url @param {'http' | 'ws'} transport */
function endpoint(url, transport) {
  const result = new URL(url);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(result.protocol)) {
    throw new TypeError('Rebendei URL must use http, https, ws, or wss');
  }
  const secure = result.protocol === 'https:' || result.protocol === 'wss:';
  result.protocol = transport === 'ws' ? (secure ? 'wss:' : 'ws:') : (secure ? 'https:' : 'http:');
  result.pathname = transport === 'ws' ? '/sync' : '/';
  result.search = '';
  result.hash = '';
  return result;
}
/** @param {Result} result */
function fingerprint(result) {
  if (result.kind === 'missing') return 'missing';
  if (result.kind === 'value') return `value:${stableStringify(result.value)}`;
  const data = result.error instanceof RebendeiError ? stableStringify(result.error.data) : '';
  return `error:${JSON.stringify([result.error.name, result.error.message, data])}`;
}
/** @param {unknown} error */
function asError(error) { return error instanceof Error ? error : new Error(String(error)); }
/** @param {string | undefined} ts */
function timestamp(ts) {
  if (typeof ts !== 'string' || !/^\d+$/.test(ts)) throw new Error('Invalid sync timestamp');
  return BigInt(ts);
}

/** Reactive WebSocket client. Watches are ref-counted and survive reconnects. */
export class RebendeiClient {
  /** @param {string} url @param {{ WebSocket?: typeof globalThis.WebSocket, verbose?: boolean }} [options] */
  constructor(url, options = {}) {
    this.url = endpoint(url, 'ws').href;
    this.WebSocket = options.WebSocket ?? globalThis.WebSocket;
    if (!this.WebSocket) throw new Error('WebSocket is unavailable; pass { WebSocket } to RebendeiClient');
    this.verbose = options.verbose ?? false;
    /** @type {Map<string, Subscription>} */
    this.subscriptions = new Map();
    /** @type {Map<number, Subscription>} */
    this.queryIds = new Map();
    /** @type {Map<number, Request>} */
    this.requests = new Map();
    /** @type {Set<(error: Error) => void>} */
    this.pendingQueries = new Set();
    this.nextQueryId = 1;
    this.nextRequestId = 1;
    this.closed = false;
    this.connected = false;
    this.reconnectAttempt = 0;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    this.reconnectTimer = undefined;
    /** @type {WebSocket | undefined} */
    this.socket = undefined;
    /** @type {bigint | undefined} */
    this.appliedTs = undefined;
    /** @type {Promise<void> | undefined} */
    this.closePromise = undefined;
    this.connect();
  }

  assertOpen() {
    if (this.closed) throw new Error('Rebendei client is closed');
  }

  connect() {
    if (this.closed) return;
    /** @type {WebSocket} */
    let socket;
    try { socket = new this.WebSocket(this.url); }
    catch (error) {
      this.failRequests(new Error(`Connection lost: ${asError(error).message}`));
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.appliedTs = undefined;
    socket.addEventListener('open', () => {
      if (this.socket !== socket || this.closed) return;
      this.connected = true;
      for (const query of this.subscriptions.values()) {
        if (!this.send({ type: 'subscribe', queryId: query.id, path: query.path, args: query.args })) return;
      }
      for (const [requestId, request] of this.requests) {
        if (!this.send({ type: request.kind, requestId, path: request.path, args: request.args })) return;
      }
    });
    socket.addEventListener('message', event => {
      if (this.socket !== socket || this.closed) return;
      try {
        if (typeof event.data !== 'string') throw new Error('Expected a JSON text sync frame');
        this.receive(/** @type {Frame} */ (JSON.parse(event.data)));
      } catch (error) {
        this.disconnect(socket, new Error(`Invalid sync message: ${asError(error).message}`));
      }
    });
    socket.addEventListener('close', () => this.disconnect(socket, new Error('Connection lost; mutations and actions are not retried')));
    socket.addEventListener('error', () => this.disconnect(socket, new Error('Connection lost; WebSocket transport error')));
  }

  /** @param {WebSocket} socket @param {Error} error */
  disconnect(socket, error) {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.connected = false;
    this.appliedTs = undefined;
    this.failRequests(error);
    try { socket.close(); } catch { /* Transport already closed. */ }
    if (!this.closed) this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.closed || this.reconnectTimer !== undefined) return;
    const ceiling = Math.min(10_000, 100 * 2 ** Math.min(this.reconnectAttempt++, 7));
    const delay = ceiling * (0.5 + Math.random() * 0.5);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  /** @param {object} frame */
  send(frame) {
    if (!this.connected || !this.socket) return false;
    const socket = this.socket;
    try { socket.send(JSON.stringify(frame)); return true; }
    catch (error) {
      this.disconnect(socket, new Error(`Connection lost: ${asError(error).message}`));
      return false;
    }
  }

  /** @param {Frame} frame */
  receive(frame) {
    if (frame.type === 'hello') {
      this.reconnectAttempt = 0;
      return;
    }
    if (frame.type === 'fatal') {
      if (this.socket) this.disconnect(this.socket, serverError(frame));
      return;
    }
    if (frame.type === 'transition') {
      const ts = timestamp(frame.ts);
      if (this.appliedTs !== undefined && ts < this.appliedTs) return;
      if (!Array.isArray(frame.modifications)) throw new Error('Missing transition modifications');
      for (const modification of frame.modifications) {
        const query = this.queryIds.get(/** @type {number} */ (modification.queryId));
        if (!query) continue;
        if (modification.type === 'updated') {
          query.server = { kind: 'value', value: /** @type {JsonValue} */ (modification.value) };
        } else if (modification.type === 'error') {
          query.server = { kind: 'error', error: serverError(modification) };
        } else if (modification.type === 'removed') {
          query.server = { kind: 'missing' };
        }
      }
      this.appliedTs = ts;
      this.finishMutations();
      this.recompute();
      return;
    }
    if (frame.type !== 'mutationResult' && frame.type !== 'actionResult') return;
    const requestId = /** @type {number} */ (frame.requestId);
    const request = this.requests.get(requestId);
    if (!request || frame.type !== `${request.kind}Result` || request.result) return;
    if (!frame.success) {
      this.requests.delete(requestId);
      this.recompute();
      request.reject(serverError(frame));
    } else if (request.kind === 'action') {
      this.requests.delete(requestId);
      request.resolve(/** @type {JsonValue} */ (frame.value));
    } else {
      request.result = { value: /** @type {JsonValue} */ (frame.value), ts: timestamp(frame.ts) };
      this.finishMutations();
      this.recompute();
    }
  }

  finishMutations() {
    for (const [id, request] of this.requests) {
      if (request.result && this.appliedTs !== undefined && this.appliedTs >= request.result.ts) {
        this.requests.delete(id);
        request.resolve(request.result.value);
      }
    }
    // Promise continuations run after receive() has recomputed and notified the cache.
  }

  /** Rebase optimistic callbacks, then publish all results atomically. */
  recompute() {
    /** @type {Map<string, Result>} */
    const results = new Map([...this.subscriptions].map(([key, query]) => [key, query.server]));
    for (const [id, request] of this.requests) {
      if (!request.optimistic) continue;
      const layer = new Map(results);
      /** @type {LocalStore} */
      const localStore = {
        getQuery: (path, args = {}) => {
          const result = layer.get(queryKey(path, args));
          if (result?.kind === 'error') throw result.error;
          return result?.kind === 'value' ? clone(result.value) : undefined;
        },
        setQuery: (path, args, value) => {
          const key = queryKey(path, args);
          if (this.subscriptions.has(key)) layer.set(key, { kind: 'value', value: clone(value) });
        },
      };
      try {
        request.optimistic(localStore, /** @type {Args} */ (clone(request.args)));
        for (const [key, result] of layer) results.set(key, result);
      } catch (error) {
        // A failed layer must not poison later layers or future server transitions.
        this.requests.delete(id);
        request.reject(asError(error));
      }
    }
    /** @type {Subscription[]} */
    const changed = [];
    for (const [key, query] of this.subscriptions) {
      const result = results.get(key) ?? { kind: 'missing' };
      if (fingerprint(query.result) !== fingerprint(result)) changed.push(query);
      query.result = result;
    }
    for (const query of changed) {
      for (const listener of [...query.listeners]) {
        if (query.listeners.has(listener)) this.notify(listener);
      }
    }
  }

  /** @param {() => void} listener */
  notify(listener) {
    try { listener(); }
    catch (error) { if (this.verbose) console.error('[rebendei] listener failed', error); }
  }

  /** @param {Error} error */
  failRequests(error) {
    const pending = [...this.requests.values()];
    this.requests.clear();
    this.recompute();
    for (const request of pending) request.reject(error);
  }

  /** @param {string} path @param {Args} args @param {() => void} listener */
  subscribe(path, args, listener) {
    this.assertOpen();
    const key = queryKey(path, args);
    let query = this.subscriptions.get(key);
    const isNew = !query;
    if (!query) {
      query = { id: this.nextQueryId++, key, path, args: /** @type {Args} */ (clone(args)), server: { kind: 'missing' }, result: { kind: 'missing' }, listeners: new Set() };
      this.subscriptions.set(key, query);
      this.queryIds.set(query.id, query);
    }
    // Each attachment has its own identity, even when the same callback is reused.
    const registration = () => listener();
    query.listeners.add(registration);
    if (isNew) {
      if (this.connected) this.send({ type: 'subscribe', queryId: query.id, path, args: query.args });
      this.recompute();
    } else if (query.result.kind !== 'missing') {
      this.notify(listener);
    }
    const subscription = query;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      subscription.listeners.delete(registration);
      if (subscription.listeners.size === 0) {
        this.subscriptions.delete(key);
        this.queryIds.delete(subscription.id);
        if (this.connected) this.send({ type: 'unsubscribe', queryId: subscription.id });
      }
    };
  }

  /** @param {string} path @param {Args} args @param {(value: JsonValue) => void} onValue @param {(error: Error) => void} [onError] */
  onUpdate(path, args, onValue, onError) {
    const key = queryKey(path, args);
    return this.subscribe(path, args, () => {
      const result = this.subscriptions.get(key)?.result;
      if (result?.kind === 'value') onValue(clone(result.value));
      else if (result?.kind === 'error') onError?.(result.error);
    });
  }

  /** A lazy watch: onUpdate attaches a listener; the last unsubscribe releases it.
   * @param {string} path @param {Args} [args]
   */
  watchQuery(path, args = {}) {
    this.assertOpen();
    const snapshot = /** @type {Args} */ (clone(args));
    const key = queryKey(path, snapshot);
    return {
      localQueryResult: () => {
        const result = this.subscriptions.get(key)?.result;
        if (result?.kind === 'error') throw result.error;
        return result?.kind === 'value' ? clone(result.value) : undefined;
      },
      onUpdate: (/** @type {() => void} */ callback) => this.subscribe(path, snapshot, callback),
    };
  }

  /** Subscribe until the first value or error, then release the subscription.
   * @param {string} path @param {Args} [args] @returns {Promise<JsonValue>}
   */
  query(path, args = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let unsubscribe = () => {};
      /** @param {Error} error */
      const fail = error => {
        settled = true;
        unsubscribe();
        this.pendingQueries.delete(fail);
        reject(error);
      };
      unsubscribe = this.onUpdate(path, args, value => {
        settled = true;
        unsubscribe();
        this.pendingQueries.delete(fail);
        resolve(value);
      }, fail);
      // A deduplicated query can deliver its cached result synchronously.
      if (settled) unsubscribe();
      else this.pendingQueries.add(fail);
    });
  }

  /** @param {'mutation' | 'action'} kind @param {string} path @param {Args} args @param {OptimisticUpdate} [optimistic] @returns {Promise<JsonValue>} */
  request(kind, path, args, optimistic) {
    return new Promise((resolve, reject) => {
      this.assertOpen();
      const snapshot = /** @type {Args} */ (clone(args));
      const id = this.nextRequestId++;
      this.requests.set(id, { kind, path, args: snapshot, resolve, reject, optimistic });
      this.recompute();
      if (this.requests.has(id) && this.connected) this.send({ type: kind, requestId: id, path, args: snapshot });
    });
  }

  /** @param {string} path @param {Args} [args] @param {{ optimisticUpdate?: OptimisticUpdate }} [options] */
  mutation(path, args = {}, options = {}) { return this.request('mutation', path, args, options.optimisticUpdate); }
  /** @param {string} path @param {Args} [args] */
  action(path, args = {}) { return this.request('action', path, args); }

  connectionState() {
    const requests = [...this.requests.values()];
    return {
      isWebSocketConnected: this.connected,
      hasInflightRequests: requests.length > 0,
      inflightMutations: requests.filter(request => request.kind === 'mutation').length,
      inflightActions: requests.filter(request => request.kind === 'action').length,
    };
  }

  /** Stop reconnecting, release listeners, and reject pending work. @returns {Promise<void>} */
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.connected = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const error = new Error('Rebendei client is closed');
    for (const rejectQuery of [...this.pendingQueries]) rejectQuery(error);
    this.failRequests(error);
    this.subscriptions.clear();
    this.queryIds.clear();
    const socket = this.socket;
    this.socket = undefined;
    this.closePromise = new Promise(resolve => {
      if (!socket || socket.readyState === 3) { resolve(); return; }
      const timer = setTimeout(resolve, 1000);
      socket.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
      try { socket.close(); } catch { clearTimeout(timer); resolve(); }
    });
    return this.closePromise;
  }
}

/** Stateless HTTP client for one-shot calls. */
export class RebendeiHttpClient {
  /** @param {string} url @param {{ fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }} [options] */
  constructor(url, options = {}) {
    this.url = endpoint(url, 'http');
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) throw new Error('fetch is unavailable; pass { fetch } to RebendeiHttpClient');
    // Browser-native fetch requires the Window/Worker global as its receiver.
    this.fetch = fetchImpl.bind(globalThis);
  }
  /** @param {'query' | 'mutation' | 'action'} kind @param {string} path @param {Args} args @returns {Promise<JsonValue>} */
  async request(kind, path, args) {
    const body = stableStringify({ path, args });
    const response = await this.fetch(new URL(`/api/${kind}`, this.url).href, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    /** @type {WireError & { status?: string, value?: JsonValue }} */
    let payload;
    try { payload = await response.json(); }
    catch { throw new Error(`Invalid Rebendei HTTP response (${response.status}): expected JSON`); }
    if (payload && payload.status === 'error') throw serverError(payload);
    if (!response.ok || !payload || payload.status !== 'success' || !Object.hasOwn(payload, 'value')) {
      throw new Error(`Invalid Rebendei HTTP response (${response.status})`);
    }
    return /** @type {JsonValue} */ (payload.value);
  }
  /** @param {string} path @param {Args} [args] */
  query(path, args = {}) { return this.request('query', path, args); }
  /** @param {string} path @param {Args} [args] */
  mutation(path, args = {}) { return this.request('mutation', path, args); }
  /** @param {string} path @param {Args} [args] */
  action(path, args = {}) { return this.request('action', path, args); }
}
