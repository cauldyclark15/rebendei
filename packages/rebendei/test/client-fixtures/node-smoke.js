// Executed by real Node, not by Bun's test runtime.
import assert from 'node:assert/strict';
import { RebendeiClient, RebendeiHttpClient } from '../../src/client/index.js';

const [syncUrl, httpUrl] = process.argv.slice(2);
const client = new RebendeiClient(syncUrl, { WebSocket: globalThis.WebSocket });
try {
  assert.deepEqual(await client.query('runtime:get', { runtime: 'node' }), { runtime: 'node' });
  assert.equal(await client.mutation('runtime:add'), 'committed');
  assert.equal(await client.action('runtime:run'), 'done');
  const http = new RebendeiHttpClient(httpUrl);
  assert.deepEqual(await http.query('runtime:get', { runtime: 'node' }), { runtime: 'node' });
  assert.deepEqual(await http.mutation('runtime:add', { value: 2 }), { value: 2 });
  assert.deepEqual(await http.action('runtime:run', { value: 3 }), { value: 3 });
  console.log('Node WebSocket and HTTP smoke passed');
} finally {
  await client.close();
}
