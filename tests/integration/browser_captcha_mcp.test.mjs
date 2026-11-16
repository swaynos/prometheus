import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { createSession } from '../../scripts/opencode-browser-sessions.mjs';
import { initializeBudget } from '../../scripts/opencode-browser-budget.mjs';
import { profile } from '../../scripts/browser-profile.mjs';
import { spawnMcpClient } from './helpers.mjs';

test('installed MCP forwards only the owned upstream proxy, honors disclosure policy and accounts for typed solutions', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'captcha-proxy-mcp-')));
  fs.chmodSync(root, 0o700);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(root, 'tls-key'), '-out', path.join(root, 'cert'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const site = https.createServer({ key: fs.readFileSync(path.join(root, 'tls-key')), cert: fs.readFileSync(path.join(root, 'cert')) }, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Form</title><div id="captcha" class="g-recaptcha" style="width:300px;height:80px" data-sitekey="private-sitekey" data-callback="acceptToken"></div>
      <div id="accepted" hidden>Accepted</div><script>
      window.acceptToken=token=>{ console.log(token); document.querySelector('#accepted').textContent=token; document.querySelector('#accepted').hidden=false; };
      window.getTask=()=>location.pathname==='/text'
        ? {type:'TextCaptchaTask',comment:'private-question'}
        : {type:'RecaptchaV3TaskProxyless',websiteURL:location.href,websiteKey:'private-sitekey',minScore:0.9,isEnterprise:true,pageAction:'form'};
      window.applySolution=solution=>acceptToken(solution.token || solution.text);
      </script>`);
  });
  await new Promise(r => site.listen(0, '127.0.0.1', r));
  const origin = `https://127.0.0.1:${site.address().port}`;
  const sockets = new Set(), connectRequests = [];
  const proxy = http.createServer((req, res) => { res.writeHead(502); res.end(); });
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  proxy.on('connect', (req, client, head) => {
    connectRequests.push(req.headers['proxy-authorization']);
    if (req.headers['proxy-authorization'] !== `Basic ${Buffer.from('fixture-user:private-password').toString('base64')}`) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return;
    }
    if (req.url !== `127.0.0.1:${site.address().port}`) { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
    const upstream = net.connect(site.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  const submitted = [];
  const provider = http.createServer((req, res) => {
    let body = ''; req.on('data', x => body += x);
    req.on('end', () => {
      const request = JSON.parse(body);
      if (req.url === '/createTask') {
        assert.equal(request.clientKey, 'private-api-key'); submitted.push(request.task);
        res.end(JSON.stringify({ errorId: 0, taskId: submitted.length })); return;
      }
      res.end(JSON.stringify({ errorId: 0, status: 'ready', cost: '0.002', solution: submitted[request.taskId - 1].type === 'TextCaptchaTask' ? { text: 'private-answer' } : { gRecaptchaResponse: 'private-token', token: 'private-token' } }));
    });
  });
  await new Promise(r => provider.listen(0, '127.0.0.1', r));
  const installRoot = path.join(root, 'install'); fs.mkdirSync(installRoot, { mode: 0o700 });
  profile('install', { root: installRoot, quiescent: true, prepare(stage) { fs.symlinkSync(path.resolve(import.meta.dirname, '../../node_modules'), path.join(stage, 'node_modules')); }, verify() {} });
  const server = path.join(installRoot, 'prometheus-browser', 'opencode-playwright-mcp.mjs');
  const authorization = { authorize_paid: true, max_cost_usd: 0.003, max_tasks: 1 };
  const cases = [
    { name: 'no-disclosure', proxyMode: undefined, expectedReason: 'proxy_disclosure_required' },
    { name: 'browser-proxy', proxyMode: 'browser', expectedType: 'RecaptchaV2Task' },
    { name: 'v3-no-fallback', proxyMode: 'browser', type: 'RecaptchaV3TaskProxyless', expectedReason: 'proxy_not_supported' },
    { name: 'v3-explicit-proxyless', proxyMode: 'proxyless', type: 'RecaptchaV3TaskProxyless', expectedType: 'RecaptchaV3TaskProxyless' },
    { name: 'typed-text', type: 'TextCaptchaTask', pathname: '/text', expectedType: 'TextCaptchaTask' },
  ];
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    for (const s of [site, proxy, provider]) { s.closeAllConnections(); await new Promise(r => s.close(r)); }
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const item of cases) {
    await t.test(item.name, async () => {
      const dir = path.join(root, item.name); fs.mkdirSync(dir, { mode: 0o700 });
      fs.writeFileSync(path.join(dir, '.env'), 'TWOCAPTCHA_API_KEY=private-api-key\n', { mode: 0o600 });
      fs.writeFileSync(path.join(dir, 'proxies.txt'), `127.0.0.1:${proxy.address().port}:fixture-user:private-password\n`, { mode: 0o600 });
      await initializeBudget(dir);
      const challenge = item.type ? { type: item.type, widgetSelector: '#captcha', taskCallback: 'getTask', solutionCallback: 'applySolution' } : undefined;
      const config = { channel: 'default', proxy: { session: 'main', strategy: 'round-robin' }, captcha: {
        enabled: true, provider: '2captcha', timeoutMs: 5000, pollIntervalMs: 5,
        ...(item.proxyMode ? { proxyMode: item.proxyMode } : {}),
        policy: { ledgerDir: dir, sites: [{ origin, acceptSelector: '#accepted', ...(challenge ? { challenge } : {}) }], estimateMicros: 3000, dailyTasks: 1, lifetimeTasks: 1, dailyMicros: 3000, lifetimeMicros: 3000 },
      } };
      fs.writeFileSync(path.join(dir, 'prometheus-browser.json'), JSON.stringify(config), { mode: 0o600 });
      await createSession(dir, config);
      const c = spawnMcpClient({
        PROMETHEUS_CONFIG_DIR: dir, CAPTCHA_FIXTURE_PORT: String(provider.address().port),
        NODE_OPTIONS: `--import=${path.join(import.meta.dirname, 'captcha_fixture_preload.mjs')}`,
      }, { server, cwd: dir, captureStderr: true });
      try {
        const call = async (name, args = {}) => c.textOf(await c.call(name, args));
        await call('browser_navigate', { url: origin + (item.pathname || '/') });
        const inspected = JSON.parse(await call('browser_challenge_inspect'));
        assert.equal(inspected.status, 'candidate');
        assert.equal(inspected.solve_available, !item.expectedReason);
        const before = submitted.length;
        const result = JSON.parse(await call('browser_challenge_solve', authorization));
        const ledgerText = fs.readFileSync(path.join(dir, 'captcha-budget.json'), 'utf8'), ledger = JSON.parse(ledgerText);
        if (item.expectedReason) {
          assert.equal(result.status, 'not_submitted'); assert.equal(result.reason, item.expectedReason);
          assert.equal(submitted.length, before); assert.equal(ledger.entries.length, 0);
        } else {
          assert.equal(result.status, 'verified'); assert.equal(submitted.length, before + 1);
          assert.equal(submitted.at(-1).type, item.expectedType);
          assert.equal(ledger.entries.length, 1); assert.equal(ledger.entries[0].actual, 2000);
          if (item.proxyMode === 'browser') {
            assert.equal(submitted.at(-1).proxyAddress, '127.0.0.1');
            assert.equal(submitted.at(-1).proxyPort, proxy.address().port);
            assert.equal(submitted.at(-1).proxyLogin, 'fixture-user');
            assert.equal(submitted.at(-1).proxyPassword, 'private-password');
          } else assert.equal(submitted.at(-1).proxyAddress, undefined);
        }
        for (const output of [JSON.stringify(result), ledgerText, await call('browser_console_messages'), await call('browser_snapshot'), await call('browser_evaluate', { expression: 'document.body.innerText' }), await call('browser_status')]) {
          assert.doesNotMatch(output, /private-token|private-answer|private-sitekey|private-question|private-api-key|private-password|fixture-user/);
        }
        await call('browser_close');
      } finally { await c.close(); }
    });
  }
  assert.ok(connectRequests.length > 0, 'browser traffic passed through the authenticated upstream');
  assert.ok(connectRequests.every(v => v === `Basic ${Buffer.from('fixture-user:private-password').toString('base64')}`));
});
