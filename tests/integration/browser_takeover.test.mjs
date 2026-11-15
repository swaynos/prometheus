import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnMcpClient } from './helpers.mjs';
import { browserLaunchOptions, browserRuntimeInfo, validateBrowserConfig } from '../../scripts/opencode-browser-runtime.mjs';
import { createSession, rotateSession } from '../../scripts/opencode-browser-sessions.mjs';

const preload = fileURLToPath(new URL('./browser_takeover_preload.mjs', import.meta.url));
test('headed is explicit at launch and preserves existing mode and proxy constraints', () => {
  const headed = validateBrowserConfig({ channel: 'default', executionMode: 'headed' });
  assert.equal(browserLaunchOptions(headed).headless, false);
  assert.equal(browserRuntimeInfo(headed).configuredDistribution, 'chromium');
  assert.equal(browserLaunchOptions({ channel: 'default' }).headless, true);
  assert.throws(() => validateBrowserConfig({ channel: 'default', executionMode: 'external-cdp', proxy: {} }), /proxy is not supported/);
});

test('actual MCP pauses all interactions and resumes the same proxied context only after handback and inspection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'takeover-fixture-'));
  const server = http.createServer((_req, res) => res.end('<h1>Task page</h1><button>Action</button>'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const config = { channel: 'default', executionMode: 'headed', proxy: { session: 'fixture', strategy: 'round-robin', pool: [{ id: 'local', server: `http://127.0.0.1:${server.address().port}` }] } };
  await writeFile(path.join(root, 'prometheus-browser.json'), JSON.stringify(config), { mode: 0o600 });
  await createSession(root, config);
  const c = spawnMcpClient({ PROMETHEUS_CONFIG_DIR: root, NODE_OPTIONS: `--import=${preload}` });
  const call = async (name, args = {}) => { const r = await c.call(name, args); assert.notEqual(r.isError, true, c.textOf(r)); return c.textOf(r); };
  try {
    await call('browser_navigate', { url: 'http://fixture.test/' });
    await call('browser_evaluate', { expression: "window.fixtureIdentity='same-context'" });
    const ref = /^(e\d+) <button> Action$/m.exec(await call('browser_interactive_elements'))?.[1];
    assert.ok(ref);
    const before = JSON.parse(await call('browser_status'));
    assert.equal(before.mode, 'headed'); assert.equal(before.proxy.generation, 1);
    assert.equal((await c.call('browser_takeover', {})).isError, true);
    assert.equal(JSON.parse(await call('browser_takeover', { user_requested: true })).status, 'human_control');
    const paused = JSON.parse(await call('browser_status'));
    assert.equal(paused.control, 'human'); assert.equal('url' in paused, false);
    const tools = (await c.rpc('tools/list')).result.tools.map(t => t.name);
    for (const name of tools.filter(n => !['browser_status', 'browser_close', 'browser_handback'].includes(n))) {
      const result = await c.call(name, {});
      assert.equal(result.isError, true, name);
      assert.match(c.textOf(result), /human control active/);
    }
    await assert.rejects(() => rotateSession(root, config), /active browser task owner/);
    assert.equal((await c.call('browser_handback', { user_confirmed: false })).isError, true);
    assert.equal(JSON.parse(await call('browser_handback', { user_confirmed: true })).status, 'inspection_required');
    assert.equal((await c.call('browser_evaluate', { expression: '1' })).isError, true);
    assert.match(await call('browser_snapshot'), /Task page/);
    assert.equal((await c.call('browser_click', { ref })).isError, true, 'pre-takeover references are invalidated');
    assert.equal(await call('browser_evaluate', { expression: 'window.fixtureIdentity' }), 'same-context');
    const after = JSON.parse(await call('browser_status'));
    assert.deepEqual(after.proxy, before.proxy);
    await call('browser_takeover', { user_requested: true });
    const registryPath = path.join(root, 'prometheus-proxy-sessions', 'registry.json');
    const original = await readFile(registryPath, 'utf8');
    const registry = JSON.parse(original);
    registry.sessions.fixture.generation++;
    await writeFile(registryPath, JSON.stringify(registry), { mode: 0o600 });
    assert.equal((await c.call('browser_handback', { user_confirmed: true })).isError, true, 'changed generation fails closed');
    assert.equal(JSON.parse(await call('browser_status')).control, 'human');
    await writeFile(registryPath, original, { mode: 0o600 });
    await call('browser_handback', { user_confirmed: true });
    await call('browser_snapshot');
  } finally { await c.close(); server.closeAllConnections(); server.close(); await rm(root, { recursive: true, force: true }); }
});

test('headless takeover is refused without recreating the page', async () => {
  const c = spawnMcpClient({ PROMETHEUS_CONFIG_DIR: '', PROMETHEUS_BROWSER_EXECUTION_MODE: 'headless' });
  try {
    await c.call('browser_navigate', { url: 'data:text/html,<h1>Original</h1>' });
    assert.equal((await c.call('browser_takeover', { user_requested: true })).isError, true);
    assert.match(c.textOf(await c.call('browser_snapshot')), /Original/);
  } finally { await c.close(); }
});

test('closed original task page cannot be handed back', async () => {
  const c = spawnMcpClient({ PROMETHEUS_CONFIG_DIR: '', PROMETHEUS_BROWSER_EXECUTION_MODE: 'headed', NODE_OPTIONS: `--import=${preload}` });
  try {
    await c.call('browser_navigate', { url: 'data:text/html,<h1>Original</h1>' });
    await c.call('browser_evaluate', { expression: "(window.open('about:blank'), 'opened')" });
    await c.call('browser_tab_switch', { index: 1 });
    await c.call('browser_evaluate', { expression: 'setTimeout(() => window.close(), 250); "scheduled"' });
    assert.equal((await c.call('browser_takeover', { user_requested: true })).isError, undefined);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(JSON.parse(c.textOf(await c.call('browser_status'))).pageOpen, false);
    assert.equal((await c.call('browser_handback', { user_confirmed: true })).isError, true);
    assert.equal((await c.call('browser_navigate', { url: 'about:blank' })).isError, true);
  } finally { await c.close(); }
});
