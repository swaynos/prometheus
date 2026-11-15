import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { chromium } from 'playwright';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { readFileSync, watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession, rotateSession } from '../../scripts/opencode-browser-sessions.mjs';
import { spawnMcpClient } from './helpers.mjs';

async function waitForFixtureClose(file) {
  const closed = () => { try { return readFileSync(file, 'utf8') === 'closed'; } catch { return false; } };
  if (closed()) return;
  await new Promise((resolve, reject) => {
    const watcher = watch(path.dirname(file), check);
    const timer = setTimeout(() => { watcher.close(); reject(new Error('fixture context did not close')); }, 10000);
    function check() { if (closed()) { clearTimeout(timer); watcher.close(); resolve(); } }
    check();
  });
}

test('lost context fails closed without replay and explicit navigation recovers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-close-'));
  const signal = path.join(root, 'closed');
  let submissions = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/submit') { submissions++; res.end('ok'); return; }
    res.setHeader('content-type', 'text/html');
    res.end(`<button id="submit" onclick="fetch('/submit').then(() => window.__closeFixtureContext())">Submit</button>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const c = spawnMcpClient({ RECOVERY_CLOSE_SIGNAL: signal, NODE_OPTIONS: `--import=${new URL('./browser_recovery_preload.mjs', import.meta.url).pathname}` });
  const status = async () => JSON.parse(c.textOf(await c.call('browser_status')));
  try {
    assert.equal((await c.call('browser_navigate', { url })).isError, undefined);
    await c.call('browser_click', { selector: '#submit', expect: { kind: 'text', selector: 'body', text: 'never' }, timeout: 2 });
    assert.equal(submissions, 1);
    await waitForFixtureClose(signal);
    const lost = await status();
    assert.equal(lost.contextOpen, false);
    assert.equal(lost.pageOpen, false);
    assert.equal(lost.recovery, 'explicit_navigation_required');
    assert.equal((await c.call('browser_tab_new')).isError, true);
    assert.equal((await c.call('browser_navigate', { url })).isError, undefined);
    assert.equal((await status()).contextOpen, true);
    assert.equal(submissions, 1);
  } finally {
    await c.close();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('external CDP disconnect is reported and fresh navigation reconnects without touching another tab', async () => {
  const port = await new Promise((resolve, reject) => {
    const socket = net.createServer().listen(0, '127.0.0.1', () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
    socket.on('error', reject);
  });
  const endpoint = `http://127.0.0.1:${port}`;
  const launch = () => chromium.launch({ channel: 'chromium', headless: true, args: [`--remote-debugging-port=${port}`] });
  let host = await launch();
  const c = spawnMcpClient({ PROMETHEUS_BROWSER_EXECUTION_MODE: 'external-cdp', PROMETHEUS_BROWSER_CDP_ENDPOINT: endpoint });
  try {
    const control = await chromium.connectOverCDP(endpoint);
    const other = await control.contexts()[0].newPage();
    await other.goto('data:text/html,unrelated');
    assert.equal((await c.call('browser_navigate', { url: 'data:text/html,first' })).isError, undefined);
    assert.match(await other.textContent('body'), /unrelated/);
    await host.close();
    const lost = JSON.parse(c.textOf(await c.call('browser_status')));
    assert.equal(lost.contextOpen, false);
    assert.equal(lost.recovery, 'explicit_navigation_required');
    host = await launch();
    assert.equal((await c.call('browser_navigate', { url: 'data:text/html,recovered' })).isError, undefined);
    assert.equal(JSON.parse(c.textOf(await c.call('browser_status'))).mode, 'external-cdp');
    await c.call('browser_close');
    assert.equal(host.isConnected(), true);
  } finally { await c.close(); await host.close(); }
});

test('proxied recovery releases the old owner and retains the routing generation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-proxy-'));
  const server = http.createServer((_req, res) => res.end('<button id="close" onclick="window.__closeFixtureContext()">Close</button>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { channel: 'default', proxy: { session: 'fixture', strategy: 'round-robin', pool: [{ id: 'local', server: `http://127.0.0.1:${server.address().port}` }] } };
  await writeFile(path.join(root, 'prometheus-browser.json'), JSON.stringify(config), { mode: 0o600 });
  await createSession(root, config);
  const signal = path.join(root, 'closed');
  const c = spawnMcpClient({ PROMETHEUS_CONFIG_DIR: root, RECOVERY_CLOSE_SIGNAL: signal, NODE_OPTIONS: `--import=${new URL('./browser_recovery_preload.mjs', import.meta.url).pathname}` });
  const status = async () => JSON.parse(c.textOf(await c.call('browser_status')));
  try {
    assert.equal((await c.call('browser_navigate', { url: 'http://fixture.test/' })).isError, undefined);
    const before = await status();
    await c.call('browser_click', { selector: '#close', expect: { kind: 'text', selector: 'body', text: 'never' }, timeout: 2 });
    await waitForFixtureClose(signal);
    assert.equal((await status()).contextOpen, false);
    // A recovered task reacquires its owner on the same generation, without rotation.
    assert.equal((await c.call('browser_navigate', { url: 'http://fixture.test/' })).isError, undefined);
    assert.deepEqual((await status()).proxy, before.proxy);
    await assert.rejects(() => rotateSession(root, config), /active browser task owner/);
    await c.call('browser_close');
    await rotateSession(root, config);
  } finally { await c.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});

test('loss during human takeover blocks handback and navigation until explicit close', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-human-'));
  const signal = path.join(root, 'closed');
  const c = spawnMcpClient({ PROMETHEUS_BROWSER_EXECUTION_MODE: 'headed', RECOVERY_TEST_HEADLESS: '1', RECOVERY_CLOSE_SIGNAL: signal, NODE_OPTIONS: `--import=${new URL('./browser_recovery_preload.mjs', import.meta.url).pathname}` });
  try {
    await c.call('browser_navigate', { url: 'data:text/html,<h1>Task</h1>' });
    await c.call('browser_evaluate', { expression: 'setTimeout(() => window.__closeFixtureContext(), 200); true' });
    assert.equal((await c.call('browser_takeover', { user_requested: true })).isError, undefined);
    await waitForFixtureClose(signal);
    const status = JSON.parse(c.textOf(await c.call('browser_status')));
    assert.equal(status.contextOpen, false);
    assert.equal(status.control, 'session_lost');
    assert.equal((await c.call('browser_handback', { user_confirmed: true })).isError, true);
    assert.equal((await c.call('browser_navigate', { url: 'about:blank' })).isError, true);
    await c.call('browser_close');
    assert.equal((await c.call('browser_navigate', { url: 'about:blank' })).isError, undefined);
  } finally { await c.close(); await rm(root, { recursive: true, force: true }); }
});
