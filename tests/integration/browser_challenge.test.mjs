import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { inspectTurnstileLifecycle } from '../../scripts/opencode-browser-challenge.mjs';
import { createTurnstileTask } from '../../scripts/opencode-browser-2captcha.mjs';

test('internal lifecycle uses real Chromium and guarded loopback 2captcha transport', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenge-lifecycle-'));
  const keyFile = path.join(dir, 'key');
  fs.writeFileSync(keyFile, 'synthetic-private-key', { mode: 0o600 });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'tls-key'), '-out', path.join(dir, 'cert'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const site = https.createServer({ key: fs.readFileSync(path.join(dir, 'tls-key')), cert: fs.readFileSync(path.join(dir, 'cert')) }, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Form</title><div class="cf-turnstile" style="width:300px;height:65px" data-sitekey="synthetic-site-key" data-callback="fixtureCallback"></div><div id="accepted" hidden>Site accepted</div><script>
      window.calls=0; window.fixtureCallback = token => { calls++; if (token === 'synthetic-private-token' && !location.search.includes('noaccept')) document.querySelector('#accepted').hidden=false; if (location.search.includes('managed-after')) { document.title='Just a moment...'; document.body.append('Checking your browser'); } if (location.search.includes('throw')) throw Error('synthetic-private-token'); };
    </script>`);
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  let held, polled, calls = [];
  const provider = http.createServer((req, res) => {
    let body = ''; req.on('data', x => body += x); req.on('end', () => {
      calls.push(req.url);
      assert.equal(JSON.parse(body).clientKey, 'synthetic-private-key');
      if (req.url === '/createTask') return res.end(JSON.stringify({ errorId: 0, taskId: 1 }));
      if (polled) { held = res; polled(); return; }
      res.end(JSON.stringify({ errorId: 0, status: 'ready', solution: { token: 'synthetic-private-token' } }));
    });
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const original = http.request;
  t.mock.method(https, 'request', (url, options, callback) => {
    const target = new URL(url);
    assert.equal(target.origin, 'https://api.2captcha.com');
    return original(`http://127.0.0.1:${provider.address().port}${target.pathname}`, options, callback);
  });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const base = `https://127.0.0.1:${site.address().port}/`;
  let revision = 1;
  const config = { enabled: true, provider: '2captcha', keyFile, timeoutMs: 1200, pollIntervalMs: 5 };
  const hooks = { authorizePaid: true, maxCostUsd: 0.1, maxTasks: 1, authorize: async () => true, reserve: async () => true, createProvider: task => createTurnstileTask(config, task) };
  const open = async (suffix = '') => { const response = await page.goto(base + suffix); return inspectTurnstileLifecycle({ page, context, getBinding: () => String(revision), navigationStatus: response.status(), acceptSelector: '#accepted', timeoutMs: 300 }); };
  const hold = () => new Promise(resolve => { polled = resolve; });
  const release = () => { polled = null; held?.end(JSON.stringify({ errorId: 0, status: 'ready', solution: { token: 'synthetic-private-token' } })); held = null; };
  t.after(async () => { release(); await browser.close(); provider.closeAllConnections(); site.closeAllConnections(); await Promise.all([new Promise(r => provider.close(r)), new Promise(r => site.close(r))]); fs.rmSync(dir, { recursive: true, force: true }); });

  await t.test('provider token is applied privately and fresh site evidence verifies acceptance', async () => {
    calls = []; const job = await open(); const status = await job.solve(hooks);
    assert.deepEqual(status, { status: 'verified', reason: 'fresh_site_evidence', outcome: 'submitted' });
    assert.deepEqual(calls, ['/createTask', '/getTaskResult']);
    assert.equal(await page.evaluate(() => window.calls), 1);
    assert.doesNotMatch(JSON.stringify(status), /synthetic|fixtureCallback/);
    assert.equal((await job.solve(hooks)).reason, 'already_used');
    assert.equal(calls.length, 2);
  });
  await t.test('token without site acceptance is not success', async () => {
    const job = await open('?noaccept'); const status = await job.solve(hooks);
    assert.notEqual(status.status, 'verified'); assert.equal(status.outcome, 'submitted');
    assert.equal(await page.evaluate(() => window.calls), 1);
  });
  await t.test('navigation away and back rejects delayed token without retry', async () => {
    calls = []; const job = await open(); const waiting = hold(); const run = job.solve(hooks); await waiting;
    await page.goto(base + '?other'); await page.goto(base); release(); const status = await run;
    assert.equal(status.status, 'unverified'); assert.equal(await page.evaluate(() => window.calls), 0);
    assert.equal(calls.filter(x => x === '/createTask').length, 1);
  });
  await t.test('main-frame navigation cancels an outstanding provider poll', async () => {
    calls = []; const job = await open(); const waiting = hold(); const run = job.solve(hooks); await waiting;
    await page.goto(base + '?other');
    const status = await Promise.race([run, new Promise((_, reject) => setTimeout(() => reject(new Error('navigation did not cancel poll')), 200))]);
    assert.equal(status.status, 'unverified'); assert.ok(['unknown', 'submitted'].includes(status.outcome));
    assert.equal(await page.evaluate(() => window.calls), 0);
    assert.equal(calls.filter(x => x === '/createTask').length, 1);
    release();
  });
  await t.test('binding generation change invalidates delayed result', async () => {
    const job = await open(); const waiting = hold(); const run = job.solve(hooks); await waiting;
    revision++; release(); const status = await run;
    assert.equal(status.status, 'unverified'); assert.equal(await page.evaluate(() => window.calls), 0);
  });
  await t.test('abort suppresses late token', async () => {
    const job = await open(); const controller = new AbortController(); const waiting = hold(); const run = job.solve({ ...hooks, signal: controller.signal }); await waiting;
    controller.abort(); const status = await run; release();
    assert.equal(status.status, 'unverified'); assert.equal(await page.evaluate(() => window.calls), 0);
  });
  await t.test('deadline suppresses late provider response and no second submission occurs', async () => {
    calls = []; const job = await open(); const waiting = hold(); const run = job.solve(hooks); await waiting;
    const status = await run; release();
    assert.equal(status.status, 'unverified'); assert.equal(status.reason, 'interrupted');
    assert.equal(await page.evaluate(() => window.calls), 0);
    assert.equal(calls.filter(x => x === '/createTask').length, 1);
  });
  await t.test('authorization and reservation reject before provider submission', async () => {
    calls = []; let job = await open();
    assert.equal((await job.solve({ ...hooks, authorize: async () => false })).status, 'not_submitted');
    job = await open(); assert.equal((await job.solve({ ...hooks, reserve: async () => false })).status, 'not_submitted');
    assert.equal(calls.length, 0);
  });
  await t.test('tab revision change-and-back rejects a delayed result', async () => {
    const job = await open(); const waiting = hold(); const run = job.solve(hooks); await waiting;
    const other = await context.newPage(); revision++; await other.goto(base); revision++; await other.close();
    release(); const status = await run;
    assert.equal(status.reason, 'stale'); assert.equal(await page.evaluate(() => window.calls), 0);
  });
  await t.test('fresh acceptance must not predate callback application', async () => {
    const job = await open(); const waiting = hold(); const run = job.solve(hooks); await waiting;
    await page.locator('#accepted').evaluate(el => { el.hidden = false; }); release();
    const status = await run; assert.notEqual(status.status, 'verified');
    assert.equal(await page.evaluate(() => window.calls), 0);
  });
  await t.test('managed denial and hidden-widget transitions suppress delayed token', async () => {
    for (const change of [
      () => { document.title = 'Just a moment...'; document.body.append('Checking your browser'); },
      () => { const iframe = document.createElement('iframe'); iframe.src = '/cdn-cgi/challenge-platform/fixture'; document.body.append(iframe); },
      () => { document.querySelector('.cf-turnstile').style.display = 'none'; },
    ]) {
      calls = []; const job = await open(); const waiting = hold(); const run = job.solve(hooks); await waiting;
      await page.evaluate(change); release(); const status = await run;
      assert.equal(status.status, 'unverified'); assert.equal(status.outcome, 'submitted');
      assert.equal(await page.evaluate(() => window.calls), 0);
      assert.equal(calls.filter(x => x === '/createTask').length, 1);
      assert.doesNotMatch(JSON.stringify(status), /synthetic|fixtureCallback/);
    }
  });
  await t.test('documentation phrases do not block an otherwise eligible application', async () => {
    const job = await open(); const waiting = hold(); const run = job.solve(hooks); await waiting;
    await page.evaluate(() => { document.title = 'Integration guide'; document.body.append('Documentation: verify you are human. Do not retry an access denied result.'); });
    release(); assert.equal((await run).status, 'verified'); assert.equal(await page.evaluate(() => window.calls), 1);
  });
  await t.test('managed denial after application prevents verified acceptance', async () => {
    const job = await open('?managed-after'); const status = await job.solve(hooks);
    assert.equal(await page.evaluate(() => window.calls), 1);
    assert.equal(status.status, 'unverified'); assert.equal(status.outcome, 'submitted');
  });
  await t.test('inspection deadline and caller cancellation are bounded from the start', async () => {
    for (const abort of [false, true]) {
      const response = await page.goto(base);
      await page.evaluate(() => { Object.defineProperty(document, 'title', { configurable: true, get() { const end = performance.now() + 500; while (performance.now() < end) {} return 'Form'; } }); });
      const originalEvaluateHandle = page.evaluateHandle;
      let notifyDisposed;
      const disposed = new Promise(resolve => { notifyDisposed = resolve; });
      page.evaluateHandle = async function (...args) {
        const handle = await originalEvaluateHandle.apply(this, args);
        const dispose = handle.dispose.bind(handle);
        handle.dispose = () => { notifyDisposed(); return dispose(); };
        return handle;
      };
      const controller = new AbortController();
      const start = performance.now();
      const running = inspectTurnstileLifecycle({ page, context, getBinding: () => String(revision), navigationStatus: response.status(), acceptSelector: '#accepted', timeoutMs: abort ? 2000 : 50, signal: controller.signal });
      if (abort) setTimeout(() => controller.abort(), 30);
      await assert.rejects(running, /inspection interrupted/);
      assert.ok(performance.now() - start < 250, 'stalled renderer must not extend inspection bound');
      // Let the renderer finish so the late evaluateHandle can be disposed.
      await page.evaluate(() => true);
      await Promise.race([disposed, new Promise((_, reject) => setTimeout(() => reject(new Error('late handle was not disposed')), 500))]);
      page.evaluateHandle = originalEvaluateHandle;
    }
  });
  await t.test('one deadline covers inspection and subsequent solve', async () => {
    calls = []; const response = await page.goto(base);
    const job = await inspectTurnstileLifecycle({ page, context, getBinding: () => String(revision), navigationStatus: response.status(), acceptSelector: '#accepted', timeoutMs: 80 });
    await new Promise(resolve => setTimeout(resolve, 120));
    const status = await job.solve(hooks);
    assert.equal(status.status, 'not_submitted'); assert.equal(calls.length, 0);
  });
  await t.test('denied navigation evidence and prior acceptance reject inspection', async () => {
    await page.goto(base);
    const input = { page, context, getBinding: () => String(revision), navigationStatus: 403, acceptSelector: '#accepted', timeoutMs: 300 };
    await assert.rejects(inspectTurnstileLifecycle(input));
    await page.locator('#accepted').evaluate(el => { el.hidden = false; });
    await assert.rejects(inspectTurnstileLifecycle({ ...input, navigationStatus: 200 }));
  });
  await t.test('context close invalidates pending provider result', async () => {
    const isolated = await browser.newContext({ ignoreHTTPSErrors: true });
    const isolatedPage = await isolated.newPage(); const response = await isolatedPage.goto(base);
    const job = await inspectTurnstileLifecycle({ page: isolatedPage, context: isolated, getBinding: () => 'isolated', navigationStatus: response.status(), acceptSelector: '#accepted', timeoutMs: 300 });
    const waiting = hold(); const run = job.solve(hooks); await waiting;
    await isolated.close(); release(); assert.equal((await run).status, 'unverified');
  });
  await t.test('callback replacement and exceptions are redacted', async () => {
    const job = await open(); const waiting = hold(); const run = job.solve(hooks); await waiting;
    await page.evaluate(() => { window.fixtureCallback = () => { window.calls++; }; }); release(); const status = await run;
    assert.equal(status.status, 'unverified'); assert.equal(await page.evaluate(() => window.calls), 0);
    assert.doesNotMatch(JSON.stringify(status), /synthetic|fixtureCallback/);
    const throwing = await open('?throw'); const errorStatus = await throwing.solve(hooks);
    assert.notEqual(errorStatus.status, 'verified'); assert.doesNotMatch(JSON.stringify(errorStatus), /synthetic|fixtureCallback/);
  });
});
