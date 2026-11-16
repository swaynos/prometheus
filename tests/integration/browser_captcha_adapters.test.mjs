import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { inspectCaptchaCandidate, inspectCaptchaLifecycle } from '../../scripts/opencode-browser-challenge.mjs';
import { captureCaptchaCandidate } from '../../scripts/opencode-browser-captcha-page.mjs';
import { CAPTCHA_TYPES, createCaptchaTask } from '../../scripts/opencode-browser-2captcha.mjs';
import { captchaFixtures, captchaVariants } from './captcha_catalog_fixtures.mjs';

const allFixtures = [...captchaFixtures, ...captchaVariants];

test('real Chromium applies every typed solution through a pinned, operator-configured site adapter', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'captcha-adapters-'));
  const keyFile = path.join(dir, 'key'); fs.writeFileSync(keyFile, 'private-api-key', { mode: 0o600 });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'tls-key'), '-out', path.join(dir, 'cert'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const site = https.createServer({ key: fs.readFileSync(path.join(dir, 'tls-key')), cert: fs.readFileSync(path.join(dir, 'cert')) }, (req, res) => {
    const url = new URL(req.url, 'https://fixture.test');
    const mode = url.searchParams.get('mode'), index = Number(url.searchParams.get('index') || 0);
    const entry = allFixtures[index];
    const input = Object.fromEntries(Object.entries(entry.task).filter(([k]) => !k.startsWith('proxy')));
    res.writeHead(mode === 'denied' ? 403 : 200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Form</title>
      ${mode === 'enterprise' ? '<script src="/recaptcha/enterprise.js"></script>' : ''}
      <div id="captcha" class="${mode === 'recaptcha' || mode === 'enterprise' ? 'g-recaptcha' : mode === 'turnstile' ? 'cf-turnstile' : ''}"
        data-sitekey="private-sitekey" data-s="private-data-s" data-callback="acceptToken" style="width:300px;height:80px"></div>
      <div id="accepted" hidden>Accepted</div><script>
      window.taskInput=${JSON.stringify(input)};
      if('websiteURL' in taskInput) taskInput.websiteURL=location.href;
      if('redirectUri' in taskInput) taskInput.redirectUri=location.href;
      window.expected=${JSON.stringify(entry.solution)};
      window.calls=0;
      window.getTask=()=>taskInput;
      window.applySolution=solution=>{
        calls++; window.received=solution; console.log(JSON.stringify(solution));
        if(JSON.stringify(solution)===JSON.stringify(expected)) document.querySelector('#accepted').hidden=false;
      };
      window.acceptToken=token=>{ calls++; window.received=token; document.querySelector('#accepted').hidden=false; };
      </script>`);
  });
  await new Promise(r => site.listen(0, '127.0.0.1', r));
  let current, requests = [], holdPoll, releasePoll;
  const provider = http.createServer((req, res) => {
    let body = ''; req.on('data', x => body += x);
    req.on('end', () => {
      requests.push({ path: req.url, body: JSON.parse(body) });
      if (req.url === '/createTask') return res.end(JSON.stringify({ errorId: 0, taskId: 12 }));
      const send = () => res.end(JSON.stringify({ errorId: 0, status: 'ready', cost: '0.002', solution: current.solution }));
      if (holdPoll) { releasePoll = send; holdPoll(); } else send();
    });
  });
  await new Promise(r => provider.listen(0, '127.0.0.1', r));
  const request = http.request;
  t.mock.method(https, 'request', (url, options, callback) => {
    assert.equal(new URL(url).origin, 'https://api.2captcha.com');
    return request(`http://127.0.0.1:${provider.address().port}${new URL(url).pathname}`, options, callback);
  });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true }), page = await context.newPage();
  t.after(async () => {
    releasePoll?.(); await browser.close();
    for (const server of [site, provider]) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const config = { enabled: true, provider: '2captcha', keyFile, timeoutMs: 1500, pollIntervalMs: 1 };
  const proxy = { server: 'http://proxy.example.test:8080', credentials: { username: 'fixture-user', password: 'private-password' } };
  let revision = 1;
  const binding = () => String(revision);
  const open = async (index, mode = 'custom') => {
    const response = await page.goto(`https://127.0.0.1:${site.address().port}/?index=${index}&mode=${mode}`);
    const challenge = mode === 'custom' ? { type: allFixtures[index].task.type, widgetSelector: '#captcha', taskCallback: 'getTask', solutionCallback: 'applySolution' } : undefined;
    return inspectCaptchaLifecycle({ page, context, getBinding: binding, navigationStatus: response.status(), acceptSelector: '#accepted', challenge, timeoutMs: 1200 });
  };
  const hooks = {
    authorizePaid: true, maxCostUsd: 0.1, maxTasks: 1, authorize: () => true, reserve: () => true,
    createProvider: task => createCaptchaTask(config, task, { proxy: CAPTCHA_TYPES[task.type].proxy === 'required' ? proxy : undefined }),
  };
  for (let index = 0; index < allFixtures.length; index++) {
    await t.test(allFixtures[index].name || allFixtures[index].task.type, async () => {
      current = allFixtures[index]; requests = [];
      const job = await open(index), protectedValues = [];
      const result = await job.solve({ ...hooks, protectToken: v => protectedValues.push(v) });
      assert.equal(result.status, 'verified');
      assert.equal(await page.evaluate(() => window.calls), 1);
      assert.deepEqual(await page.evaluate(() => window.received), current.solution);
      assert.equal(requests.filter(r => r.path === '/createTask').length, 1);
      assert.equal(requests[0].body.task.type, CAPTCHA_TYPES[current.task.type].canonicalType || current.task.type);
      if (CAPTCHA_TYPES[current.task.type].proxy === 'required') assert.equal(requests[0].body.task.proxyPassword, 'private-password');
      assert.doesNotMatch(JSON.stringify(result), /private-/);
      if (JSON.stringify(current.solution).includes('private-token')) assert.ok(protectedValues.includes('private-token'));
    });
  }
  for (const mode of ['recaptcha', 'enterprise', 'turnstile']) {
    await t.test(`automatic standalone ${mode}`, async () => {
      current = { solution: { gRecaptchaResponse: 'private-token', token: 'private-token' } }; requests = [];
      const job = await open(0, mode);
      const result = await job.solve(hooks);
      assert.equal(result.status, 'verified');
      assert.equal(await page.evaluate(() => window.received), 'private-token');
      const input = requests[0].body.task;
      assert.equal(input.type, mode === 'turnstile' ? 'TurnstileTaskProxyless' : mode === 'enterprise' ? 'RecaptchaV2EnterpriseTaskProxyless' : 'RecaptchaV2TaskProxyless');
      if (mode === 'recaptcha') assert.equal(input.recaptchaDataSValue, 'private-data-s');
      if (mode === 'enterprise') assert.deepEqual(input.enterprisePayload, { s: 'private-data-s' });
    });
  }
  await t.test('widget, callback, task mutation, denial and binding changes suppress late application', async () => {
    const index = captchaFixtures.findIndex(f => f.task.type === 'TextCaptchaTask');
    for (const mutate of [
      () => { window.taskInput.comment = 'changed'; },
      () => { window.applySolution = () => window.calls++; },
      () => { window.getTask = () => window.taskInput; },
      () => { document.querySelector('#captcha').replaceWith(document.querySelector('#captcha').cloneNode(true)); },
      () => { document.querySelector('#captcha').hidden = true; },
      () => { document.title = 'Access denied'; document.body.append('Access denied'); },
      () => { document.querySelector('#accepted').hidden = false; },
      null,
    ]) {
      current = captchaFixtures[index]; requests = [];
      const job = await open(index);
      const waiting = new Promise(r => { holdPoll = r; });
      const run = job.solve(hooks); await waiting;
      if (mutate) await page.evaluate(mutate); else revision++;
      releasePoll(); holdPoll = null; releasePoll = null;
      const result = await run;
      assert.notEqual(result.status, 'verified');
      assert.equal(await page.evaluate(() => window.calls), 0);
      assert.equal(requests.filter(r => r.path === '/createTask').length, 1);
    }
  });
  await t.test('page may not select a proxy or another website and denial is never eligible', async () => {
    for (const change of [
      () => { window.taskInput.proxyType = 'http'; },
      () => { window.taskInput.websiteURL = 'https://evil.test'; },
      () => { document.title = 'Just a moment...'; document.body.append('Checking your browser'); },
      () => { document.body.append('Our systems have detected unusual traffic from your computer network'); },
    ]) {
      await page.goto(`https://127.0.0.1:${site.address().port}/?index=0`);
      await page.evaluate(change);
      await assert.rejects(inspectCaptchaLifecycle({
        page, context, getBinding: binding, navigationStatus: 200, acceptSelector: '#accepted',
        challenge: { type: 'RecaptchaV2TaskProxyless', widgetSelector: '#captcha', taskCallback: 'getTask', solutionCallback: 'applySolution' },
      }));
    }
    await assert.rejects(open(0, 'denied'));
  });
  await t.test('invisible/v3 requires a site adapter; mixed widgets are ambiguous', async () => {
    await page.goto(`https://127.0.0.1:${site.address().port}/?mode=recaptcha`);
    await page.evaluate(() => document.querySelector('#captcha').setAttribute('data-size', 'invisible'));
    let handle = await page.evaluateHandle(captureCaptchaCandidate);
    assert.equal((await handle.evaluate(v => v.status)), 'unsupported'); await handle.dispose();
    await page.evaluate(() => {
      document.querySelector('#captcha').removeAttribute('data-size');
      const div = document.createElement('div'); div.className = 'cf-turnstile'; document.body.append(div);
    });
    handle = await page.evaluateHandle(captureCaptchaCandidate);
    assert.equal((await handle.evaluate(v => v.reason)), 'ambiguous_widgets'); await handle.dispose();
  });
  await t.test('read-only site-adapter inspection has a bounded renderer deadline', async () => {
    const index = allFixtures.findIndex(f => f.task.type === 'TextCaptchaTask');
    await page.goto(`https://127.0.0.1:${site.address().port}/?index=${index}`);
    await page.evaluate(() => {
      window.getTask = () => {
        const until = performance.now() + 500;
        while (performance.now() < until) {}
        return window.taskInput;
      };
    });
    const start = performance.now();
    await assert.rejects(inspectCaptchaCandidate({
      page, timeoutMs: 50,
      challenge: { type: 'TextCaptchaTask', widgetSelector: '#captcha', taskCallback: 'getTask', solutionCallback: 'applySolution' },
    }));
    assert.ok(performance.now() - start < 250);
    await page.evaluate(() => true);
  });
});
