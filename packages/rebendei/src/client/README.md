# JavaScript clients

```js
import { RebendeiClient, RebendeiHttpClient, RebendeiError } from 'rebendei/client';

const client = new RebendeiClient('http://localhost:3210');
const unsubscribe = client.onUpdate('messages:list', { channel: 'general' },
  messages => console.log(messages),
  error => console.error(error),
);

await client.mutation('messages:send', { channel: 'general', body: 'Hello' });
const messages = await client.query('messages:list', { channel: 'general' });
const result = await client.action('ai/embed:run', { text: 'Hello' });

unsubscribe();
await client.close();
```

Use JSON arguments and function paths (`file:export`, for example
`messages:list` or `ai/embed:run`). Both clients accept HTTP(S) or WS(S) URLs.
The reactive client connects to `/sync`; the HTTP client posts to `/api/query`,
`/api/mutation`, or `/api/action` on the same origin.

## Reactive watches

Identical paths and arguments share one server subscription, even if object
keys are in a different order. The last listener's unsubscribe releases it.
`onUpdate` delivers an already-cached value/error immediately and subsequently
only on changes. Listener exceptions are isolated (`verbose: true` logs them).

`watchQuery(path, args)` creates a lazy watch. Attach it with
`watch.onUpdate(() => ...)` and unsubscribe when finished. Read
`watch.localQueryResult()` inside the callback: it returns `undefined` until a
result arrives (or if the server removes it), and throws the current query
error. A value can itself be `null`. All results in a transition are published
before any listener runs. Arguments and returned values are copied, so app
mutations of those objects cannot corrupt the cache.

`query` attaches a temporary listener, resolves the first value (including a
cached/optimistic value), and unsubscribes. Query failures reject it.

## Optimistic updates

```js
await client.mutation('counter:add', { by: 1 }, {
  optimisticUpdate(store, args) {
    const count = store.getQuery('counter:get', {});
    if (typeof count === 'number' && typeof args.by === 'number') {
      store.setQuery('counter:get', {}, count + args.by);
    }
  },
});
```

The callback must be synchronous, deterministic, and side-effect-free: layers
are replayed in request order over new server results, and later layers rebase
when earlier mutations finish. `getQuery` returns a copied cached value (or
`undefined`) and throws cached query errors. `setQuery` changes only actively
subscribed queries. Start a watch before optimistically modifying its result.

A successful mutation resolves, and its optimistic layer is removed, only after
a transition with `ts >= mutationResult.ts` has been applied. Failure or loss of
the connection rejects the mutation and removes its layer. A throwing optimistic
callback rejects that mutation and discards its partial layer.

## Connection lifecycle and errors

Queries transparently resubscribe after connection loss, with jittered
exponential backoff capped at 10 seconds. Previously cached query values remain
available until refreshed. **Mutations and actions are never replayed**: any
in-flight calls reject with a connection-lost error. Their server-side outcome
may be unknown; do not blindly retry non-idempotent operations.

`client.connectionState()` returns `{ isWebSocketConnected,
hasInflightRequests, inflightMutations, inflightActions }`; counts include
successful mutation results still waiting for their transition. `close()` stops
reconnects, rejects pending calls, releases watches, and closes the socket.
The closed client cannot be reused.

Server errors with `errorData` become `RebendeiError` instances, with `.data`
retaining the JSON payload (even `null`). Other failures are ordinary `Error`s.

Browsers and Bun can use their global `WebSocket`. Node runtimes without a
global implementation must pass a compatible constructor:
`new RebendeiClient(url, { WebSocket: YourWebSocket })`. The client contains no
Bun or Node-specific imports, and has no runtime dependencies.

## HTTP and a tiny framework-free example

`RebendeiHttpClient` makes independent one-shot calls, without subscriptions or
optimism. Inject `fetch` when needed: `new RebendeiHttpClient(url, { fetch })`.
Its `query`, `mutation`, and `action` methods return the server value and reject
on HTTP/protocol/server errors.

```js
// Attach to an existing <output id="count"> and <button id="add">.
const output = document.querySelector('#count');
const button = document.querySelector('#add');
const client = new RebendeiClient('http://localhost:3210');
const watch = client.watchQuery('counter:get', {});
const off = watch.onUpdate(() => {
  try { output.textContent = String(watch.localQueryResult() ?? 'Loading…'); }
  catch (error) { output.textContent = error.message; }
});
button.addEventListener('click', () => {
  client.mutation('counter:add', { by: 1 }).catch(error => {
    output.textContent = error.message;
  });
});
window.addEventListener('pagehide', () => { off(); void client.close(); }, { once: true });

// Elsewhere, without a live socket:
const http = new RebendeiHttpClient('http://localhost:3210');
console.log(await http.query('counter:get', {}));
```
