import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnMcpClient } from './helpers.mjs';

async function fixture() {
  let status = 200;
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, status });
    if (status === 0) return;
    res.writeHead(status, { 'content-type': 'text/html', 'cache-control': 'no-store', ...(status === 401 ? { 'www-authenticate': 'Basic realm="Fixture"' } : {}) });
    res.end('<h1>Fixture</h1>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const c = spawnMcpClient({ PROMETHEUS_BROWSER_CHANNEL: process.env.PROMETHEUS_TEST_BROWSER_CHANNEL || 'default' });
  return { c, hits, base, setStatus: value => { status = value; }, close: async () => { await c.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

for (const code of [401, 403]) test(`real browser reload classifies observed HTTP ${code} without replay`, async () => {
  const f = await fixture();
  try {
    assert.equal((await f.c.call('browser_navigate', { url: `${f.base}/doc` })).isError, undefined);
    f.setStatus(code);
    const result = await f.c.call('browser_reload', { timeout: 3 });
    assert.match(f.c.textOf(result), /access denied/i);
    assert.deepEqual(f.hits.filter(hit => hit.url === '/doc').map(hit => hit.status), [200, code]);
  } finally { await f.close(); }
});

test('reload does not reuse an earlier denial for a 200 or missing response', async () => {
  const f = await fixture();
  try {
    await f.c.call('browser_navigate', { url: `${f.base}/doc` });
    f.setStatus(403);
    assert.match(f.c.textOf(await f.c.call('browser_reload', { timeout: 3 })), /access denied/i);
    f.setStatus(200);
    const success = await f.c.call('browser_reload', { timeout: 3 });
    assert.equal(success.isError, undefined);
    assert.doesNotMatch(f.c.textOf(success), /access denied/i);
    f.setStatus(0);
    const unknown = await f.c.call('browser_reload', { timeout: 2 });
    assert.equal(unknown.isError, true);
    assert.doesNotMatch(f.c.textOf(unknown), /access denied/i);
    assert.deepEqual(f.hits.filter(hit => hit.url === '/doc').map(hit => hit.status), [200, 403, 200, 0]);
  } finally { await f.close(); }
});

for (const direction of ['back', 'forward']) test(`real browser ${direction} reports a current history-document denial`, async () => {
  const f = await fixture();
  try {
    await f.c.call('browser_navigate', { url: `${f.base}/first` });
    await f.c.call('browser_navigate', { url: `${f.base}/second` });
    if (direction === 'forward') assert.equal((await f.c.call('browser_navigate_back')).isError, undefined);
    f.setStatus(401);
    const result = await f.c.call(direction === 'back' ? 'browser_navigate_back' : 'browser_forward');
    assert.match(f.c.textOf(result), /access denied/i);
    const target = direction === 'back' ? '/first' : '/second';
    assert.deepEqual(f.hits.filter(hit => hit.url === target).map(hit => hit.status), [200, 401]);
  } finally { await f.close(); }
});
