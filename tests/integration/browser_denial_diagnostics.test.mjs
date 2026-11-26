import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnMcpClient } from './helpers.mjs';

function fixture() {
  const seen = [];
  let flipNext = false;
  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, 'http://127.0.0.1');
    seen.push({ url: req.url, pathname: parsed.pathname, ua: req.headers['user-agent'] || '' });
    if (parsed.pathname === '/ua-reject') {
      const ua = req.headers['user-agent'] || '';
      if (/HeadlessChrome|TaintedAgent/i.test(ua)) {
        res.writeHead(403, { 'content-type': 'text/html', 'cache-control': 'no-store' });
        return res.end('<h1>Blocked</h1>');
      }
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      return res.end('<h1>OK</h1>');
    }
    if (parsed.pathname === '/always-403') {
      res.writeHead(403, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      return res.end('<h1>Forbidden</h1>');
    }
    if (parsed.pathname === '/flaky-recover') {
      if (!flipNext) {
        flipNext = true;
        res.writeHead(403, { 'content-type': 'text/html', 'cache-control': 'no-store' });
        return res.end('<h1>Denied once</h1>');
      }
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      return res.end('<h1>Recovered</h1>');
    }
    if (parsed.pathname === '/cf-challenge') {
      res.writeHead(403, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      return res.end('<!doctype html><title>Just a moment...</title><body>Checking your browser before accessing the site. Cloudflare security verification.</body>');
    }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end('<h1>Fixture</h1>');
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({
      seen,
      base,
      close: async c => { await c.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); },
    });
  }));
}

async function taintedConfigDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'denial-diagnostics-'));
  await writeFile(path.join(dir, 'prometheus-browser.json'), JSON.stringify({
    channel: process.env.PROMETHEUS_TEST_BROWSER_CHANNEL || 'default',
    contextOptions: { userAgent: 'Mozilla/5.0 TaintedAgent/1.0' },
  }));
  return dir;
}

test('denial carries retryable diagnostics, sanitized URL, suggestions, and corrected re-navigation succeeds', async () => {
  const f = await fixture();
  const configDir = await taintedConfigDir();
  const c = spawnMcpClient({ PROMETHEUS_CONFIG_DIR: configDir });
  try {
    const denied = c.textOf(await c.call('browser_navigate', { url: `${f.base}/ua-reject?token=secret123#frag` }));
    assert.match(denied, /status 403, access denied; retryable: true/i);

    const status = JSON.parse(c.textOf(await c.call('browser_status', {})));
    assert.ok(status.lastDenial, 'lastDenial surfaced in browser_status');
    assert.equal(status.lastDenial.stage, 'http_response');
    assert.equal(status.lastDenial.status, 403);
    assert.equal(status.lastDenial.url, `${f.base}/ua-reject`, 'query string and hash stripped from lastDenial.url');
    assert.equal(status.lastDenial.retryable, true);
    assert.match(status.lastDenial.reason, /change settings from suggestions/i);
    assert.ok(status.lastDenial.settings.configured, 'configured setting names present');
    assert.ok(status.lastDenial.settings.effective, 'effective setting names present');
    assert.equal(status.lastDenial.settings.effective.userAgent, 'custom');
    assert.ok(Array.isArray(status.lastDenial.suggestions) && status.lastDenial.suggestions.length >= 2, 'actionable suggestions returned');
    assert.ok(status.lastDenial.suggestions.some(s => /userAgent/i.test(s)), 'suggests removing custom userAgent');
    const diagnosticText = JSON.stringify(status.lastDenial);
    assert.doesNotMatch(diagnosticText, /secret123|cookie|authorization|bearer/i, 'no signed query params or credentials in diagnostics');

    const corrected = spawnMcpClient({ PROMETHEUS_BROWSER_CHANNEL: process.env.PROMETHEUS_TEST_BROWSER_CHANNEL || 'default' });
    try {
      const retry = corrected.textOf(await corrected.call('browser_navigate', { url: `${f.base}/ua-reject?token=secret123` }));
      assert.match(retry, /status 200/);
      assert.doesNotMatch(retry, /access denied/i);

      const attempts = f.seen.filter(e => e.pathname === '/ua-reject');
      assert.equal(attempts.length, 2);
      assert.match(attempts[0].ua, /TaintedAgent/);
      assert.doesNotMatch(attempts[1].ua, /TaintedAgent|HeadlessChrome/i);
    } finally {
      await corrected.close();
    }
  } finally {
    await f.close(c);
    await rm(configDir, { recursive: true, force: true });
  }
});

test('repeated identical denial flips retryable to false while private URL and config changes remain distinct', async () => {
  const f = await fixture();
  const c = spawnMcpClient({ PROMETHEUS_BROWSER_CHANNEL: process.env.PROMETHEUS_TEST_BROWSER_CHANNEL || 'default' });
  try {
    const first = c.textOf(await c.call('browser_navigate', { url: `${f.base}/always-403?sig=alpha` }));
    assert.match(first, /status 403, access denied; retryable: true/i);

    const status1 = JSON.parse(c.textOf(await c.call('browser_status', {})));
    assert.equal(status1.lastDenial.retryable, true);
    assert.equal(status1.lastDenial.url, `${f.base}/always-403`);

    // Exact same URL + exact same settings -> cache hit -> retryable: false.
    const second = c.textOf(await c.call('browser_navigate', { url: `${f.base}/always-403?sig=alpha` }));
    assert.match(second, /status 403, access denied; retryable: false/i);

    const status2 = JSON.parse(c.textOf(await c.call('browser_status', {})));
    assert.equal(status2.lastDenial.retryable, false);
    assert.match(status2.lastDenial.reason, /same url and settings already failed/i);
    assert.match(status2.lastDenial.reason, /stop and report/i);
    assert.deepEqual(status2.lastDenial.suggestions, [], 'non-retryable denial must not invite another settings change');
    assert.doesNotMatch(second, /change settings/);

    // Different query param on same path has a distinct private fingerprint (no query leak).
    const differentQuery = c.textOf(await c.call('browser_navigate', { url: `${f.base}/always-403?sig=beta` }));
    assert.match(differentQuery, /status 403, access denied; retryable: true/i);
    const status3 = JSON.parse(c.textOf(await c.call('browser_status', {})));
    assert.equal(status3.lastDenial.url, `${f.base}/always-403`);
    assert.doesNotMatch(JSON.stringify(status3.lastDenial), /alpha|beta/);

    // Adjusting an in-session config knob (humanize) yields a new fingerprint for the original URL.
    await c.call('browser_configure', { humanize: true });
    const withHumanize = c.textOf(await c.call('browser_navigate', { url: `${f.base}/always-403?sig=alpha` }));
    assert.match(withHumanize, /status 403, access denied; retryable: true/i);
    const withHumanizeRepeat = c.textOf(await c.call('browser_navigate', { url: `${f.base}/always-403?sig=alpha` }));
    assert.match(withHumanizeRepeat, /status 403, access denied; retryable: false/i);

    // No automatic retries happened inside the server (5 explicit calls = 5 hits).
    assert.equal(f.seen.filter(e => e.pathname === '/always-403').length, 5);
  } finally {
    await f.close(c);
  }
});

test('denial cache expires after TTL, clears on healthy navigation, and clears on browser_close', async () => {
  const f = await fixture();
  const c = spawnMcpClient({
    PROMETHEUS_BROWSER_CHANNEL: process.env.PROMETHEUS_TEST_BROWSER_CHANNEL || 'default',
    PROMETHEUS_BROWSER_DENIAL_TTL_MS: '150',
  });
  try {
    const first = c.textOf(await c.call('browser_navigate', { url: `${f.base}/always-403` }));
    assert.match(first, /retryable: true/i);

    // Expiry removes diagnostics; it does not prove access or authorize another attempt.
    await new Promise(r => setTimeout(r, 220));
    const statusAfterTtl = JSON.parse(c.textOf(await c.call('browser_status', {})));
    assert.equal(statusAfterTtl.lastDenial, undefined, 'expired lastDenial omitted from browser_status');

    const freshAfterTtl = c.textOf(await c.call('browser_navigate', { url: `${f.base}/always-403` }));
    assert.match(freshAfterTtl, /retryable: true/i);

    // browser_close clears denial state immediately.
    await c.call('browser_close', {});
    const statusAfterClose = JSON.parse(c.textOf(await c.call('browser_status', {})));
    assert.equal(statusAfterClose.lastDenial, undefined, 'browser_close clears lastDenial');

    // Healthy 200 clears a prior denial for the same path.
    const deniedOnce = c.textOf(await c.call('browser_navigate', { url: `${f.base}/flaky-recover` }));
    assert.match(deniedOnce, /status 403, access denied/i);
    const recovered = c.textOf(await c.call('browser_navigate', { url: `${f.base}/flaky-recover` }));
    assert.match(recovered, /status 200/);
    const statusAfterRecover = JSON.parse(c.textOf(await c.call('browser_status', {})));
    assert.equal(statusAfterRecover.lastDenial, undefined, 'healthy navigation clears lastDenial');
  } finally {
    await f.close(c);
  }
});

test('managed challenge is immediately non-retryable with empty suggestions', async () => {
  const f = await fixture();
  const c = spawnMcpClient({ PROMETHEUS_BROWSER_CHANNEL: process.env.PROMETHEUS_TEST_BROWSER_CHANNEL || 'default' });
  try {
    const challenged = c.textOf(await c.call('browser_navigate', { url: `${f.base}/cf-challenge` }));
    assert.match(challenged, /Cloudflare challenge detected; retryable: false/i);

    const status = JSON.parse(c.textOf(await c.call('browser_status', {})));
    assert.ok(status.lastDenial);
    assert.equal(status.lastDenial.retryable, false);
    assert.deepEqual(status.lastDenial.suggestions, []);
    assert.match(status.lastDenial.reason, /managed challenge/i);
  } finally {
    await f.close(c);
  }
});
