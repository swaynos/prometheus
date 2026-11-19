import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnMcpClient } from './helpers.mjs';

test('interrupted navigation uses only the current main-document response', async () => {
  const hits = new Map();
  const server = http.createServer((req, res) => {
    hits.set(req.url, (hits.get(req.url) || 0) + 1);
    if (req.url === '/interrupt-drop') return; // No response: classification must not invent a denial.
    if (req.url === '/interrupt-redirect') { res.writeHead(302, { location: '/denied' }); res.end(); return; }
    const status = req.url === '/auth' ? 401 : ['/interrupt-denied', '/denied'].includes(req.url) ? 403 : 200;
    const send = () => { res.writeHead(status, { 'content-type': 'text/html', ...(status === 401 ? { 'www-authenticate': 'Basic realm="Fixture"' } : {}) }); res.end('<h1>Fixture</h1>'); };
    if (req.url.startsWith('/interrupt-')) setTimeout(send, 50); else send();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const c = spawnMcpClient({ PROMETHEUS_BROWSER_CHANNEL: process.env.PROMETHEUS_TEST_BROWSER_CHANNEL || 'default', NODE_OPTIONS: `--import=${new URL('./browser_denial_preload.mjs', import.meta.url).pathname}` });
  const navigate = async path => c.call('browser_navigate', { url: base + path });
  try {
    const auth = await navigate('/auth');
    assert.match(c.textOf(auth), /access denied/i);
    const denied = await navigate('/interrupt-denied');
    assert.equal(denied.isError, true);
    assert.match(c.textOf(denied), /access denied.*HTTP 403; retryable: (true|false)/i);
    const ok = await navigate('/interrupt-ok');
    assert.equal(ok.isError, true);
    assert.doesNotMatch(c.textOf(ok), /access denied/i);
    const drop = await navigate('/interrupt-drop');
    assert.equal(drop.isError, true);
    assert.doesNotMatch(c.textOf(drop), /access denied/i);
    const redirected = await navigate('/interrupt-redirect');
    assert.equal(redirected.isError, true);
    assert.match(c.textOf(redirected), /access denied.*HTTP 403/i);
    for (const path of ['/auth', '/interrupt-denied', '/interrupt-ok', '/interrupt-drop', '/interrupt-redirect', '/denied']) assert.equal(hits.get(path), 1, path);
  } finally { await c.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
