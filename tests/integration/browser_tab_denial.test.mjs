import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnMcpClient } from './helpers.mjs';

const channel = process.env.PROMETHEUS_TEST_BROWSER_CHANNEL || 'default';
for (const kind of ['auth', 'forbidden', 'managed', 'normal', 'redirect-auth', 'redirect-forbidden', 'redirect-managed', 'redirect-normal']) {
  test(`new tab ${kind}: observed destination, active page and hydration (${channel})`, async () => {
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push(req.url);
      if (req.url.startsWith('/redirect-')) {
        res.writeHead(302, { location: '/' + req.url.slice('/redirect-'.length) });
        return res.end();
      }
      const type = req.url.slice(1);
      const status = type === 'auth' ? 401 : type === 'forbidden' ? 403 : 200;
      res.writeHead(status, { 'content-type': 'text/html', 'cache-control': 'no-store', ...(status === 401 ? { 'www-authenticate': 'Basic realm="Fixture"' } : {}) });
      res.end(type === 'managed'
        ? '<title>Just a moment...</title><h1>Checking your browser</h1><button id="account">account</button>'
        : '<title>Fixture</title><h1>Fixture</h1><button id="account">account</button>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tab-denial-'));
    await mkdir(path.join(dir, 'prometheus-sessions'), { mode: 0o700 });
    await writeFile(path.join(dir, 'prometheus-sessions', 'account.json'), JSON.stringify({
      schemaVersion: 1, name: 'account', origins: [base], capturedAt: new Date().toISOString(),
      storageState: { cookies: [], origins: [{ origin: base, localStorage: [{ name: 'synthetic', value: 'yes' }] }] },
      verification: { selector: '#account' },
    }), { mode: 0o600 });
    const c = spawnMcpClient({ PROMETHEUS_CONFIG_DIR: dir, PROMETHEUS_BROWSER_CHANNEL: channel });
    try {
      const result = await c.call('browser_tab_new', { url: `${base}/${kind}` });
      const output = c.textOf(result);
      const target = kind.replace(/^redirect-/, '');
      if (target === 'auth' || target === 'forbidden') assert.match(output, /access denied/i);
      else if (target === 'managed') assert.match(output, /challenge detected.*do not retry automatically/i);
      else { assert.equal(result.isError, undefined, output); assert.match(output, /opened tab 1 \(status 200\)/); }
      assert.equal(requests.filter(url => url === `/${kind}`).length, 1);
      if (kind.startsWith('redirect-')) assert.equal(requests.filter(url => url === `/${target}`).length, 1);
      const status = JSON.parse(c.textOf(await c.call('browser_status')));
      assert.equal(status.mode, 'headless');
      const tabs = c.textOf(await c.call('browser_tab_list'));
      assert.match(tabs, /1\*/);
      if (target !== 'auth') {
        assert.match(status.url, new RegExp(`/${target}$`));
        assert.equal(status.authenticationVerification, target === 'normal' ? 'verified' : 'pending');
        assert.equal(status.hydratedAuthentication, target === 'normal');
      }
    } finally {
      await c.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test(`new tab interrupted navigation uses only its own response (${channel})`, async () => {
  const hits = new Map();
  const server = http.createServer((req, res) => {
    hits.set(req.url, (hits.get(req.url) || 0) + 1);
    if (req.url === '/interrupt-drop') return;
    if (req.url === '/interrupt-redirect') { res.writeHead(302, { location: '/denied' }); return res.end(); }
    const status = ['/interrupt-denied', '/denied'].includes(req.url) ? 403 : 200;
    const send = () => { res.writeHead(status, { 'content-type': 'text/html' }); res.end('<h1>Fixture</h1>'); };
    if (req.url.startsWith('/interrupt-')) setTimeout(send, 50); else send();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const c = spawnMcpClient({ PROMETHEUS_BROWSER_CHANNEL: channel, NODE_OPTIONS: `--import=${new URL('./browser_denial_preload.mjs', import.meta.url).pathname}` });
  try {
    for (const [route, denial] of [['interrupt-denied', true], ['interrupt-ok', false], ['interrupt-drop', false], ['interrupt-redirect', true]]) {
      const result = await c.call('browser_tab_new', { url: `${base}/${route}` });
      const output = c.textOf(result);
      assert.equal(result.isError, true);
      assert.match(output, /tab \d+ created; navigation did not complete \(outcome unknown\)/i);
      if (denial) assert.match(output, /access denied.*HTTP 403; retryable: (true|false)/i);
      else assert.doesNotMatch(output, /access denied/i);
    }
    for (const route of ['/interrupt-denied', '/interrupt-ok', '/interrupt-drop', '/interrupt-redirect', '/denied']) assert.equal(hits.get(route), 1, route);
  } finally { await c.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
