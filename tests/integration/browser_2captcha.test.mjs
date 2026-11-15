import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { createTurnstileTask, validateCaptchaConfig } from '../../scripts/opencode-browser-2captcha.mjs';

test('2captcha adapter uses bounded, redacted, single-submission protocol', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'captcha-fixture-'));
  const keyFile = path.join(dir, 'key');
  fs.writeFileSync(keyFile, 'fixture-secret-key', { mode: 0o600 });
  const config = { enabled: true, provider: '2captcha', keyFile, timeoutMs: 1000, pollIntervalMs: 5 };
  const task = { websiteURL: 'https://example.test/private-payload', websiteKey: 'fixture-sitekey' };
  let handler, calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { calls.push({ url: req.url, body: JSON.parse(body) }); handler(req, res); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const original = http.request;
  t.mock.method(https, 'request', (url, options, callback) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.2captcha.com');
    return original(`http://127.0.0.1:${server.address().port}${parsed.pathname}`, options, callback);
  });
  t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const send = (res, value) => res.end(JSON.stringify(value));
  const hooks = { authorize: async () => true, reserve: async () => true, onReady: async () => {} };
  const fresh = (settings = config) => createTurnstileTask(settings, task);
  const error = async (promise, code, outcome) => {
    await assert.rejects(promise, e => {
      assert.equal(e.code, code); assert.equal(e.outcome, outcome);
      const publicText = `${e.stack} ${JSON.stringify(e)}`;
      for (const secret of ['fixture-secret-key', 'fixture-sitekey', 'private-payload', 'fixture-token', 'fixture-proxy-password']) assert.ok(!publicText.includes(secret));
      return true;
    });
  };
  await t.test('pending then ready and immutable task', async () => {
    calls = []; let polls = 0; let received;
    handler = (req, res) => send(res, req.url === '/createTask' ? { errorId: 0, taskId: 42 } : ++polls === 1 ? { errorId: 0, status: 'processing' } : { errorId: 0, status: 'ready', solution: { token: 'fixture-token' } });
    const input = { ...task }; const job = createTurnstileTask(config, input); input.websiteKey = 'changed';
    const status = await job.solve({ ...hooks, onReady: token => { received = token; } });
    assert.equal(received, 'fixture-token'); assert.deepEqual(status, { status: 'ready', outcome: 'submitted' });
    assert.equal(calls[0].body.task.websiteKey, 'fixture-sitekey');
    assert.deepEqual(calls.slice(1).map(x => x.body.taskId), [42, 42]);
    await error(job.solve(hooks), 'already-used', 'unknown');
    assert.equal(calls.length, 3);
  });
  await t.test('dotenv sources are isolated, conservative and fail before reservation', async () => {
    const file = path.join(dir, '.env');
    const settings = { enabled: true, provider: '2captcha', envFile: file, timeoutMs: 1000, pollIntervalMs: 5 };
    const old = process.env.TWOCAPTCHA_API_KEY;
    delete process.env.TWOCAPTCHA_API_KEY;
    let reservations = 0;
    const guarded = { ...hooks, reserve: () => { reservations++; return true; } };
    handler = (req, res) => send(res, req.url === '/createTask' ? { errorId: 0, taskId: 42 } : { errorId: 0, status: 'ready', solution: { token: 'fixture-token' } });
    try {
      assert.throws(() => validateCaptchaConfig({ ...settings, keyFile }), { code: 'invalid-config' });
      for (const content of ['TWOCAPTCHA_API_KEY=fixture-secret-key # comment\n', ' export TWOCAPTCHA_API_KEY = "fixture-secret-key" # comment\nOTHER=ignored\n', "TWOCAPTCHA_API_KEY='fixture-secret-key'\n"]) {
        fs.writeFileSync(file, content, { mode: 0o600 }); calls = [];
        validateCaptchaConfig(settings); assert.equal(calls.length, 0);
        await fresh(settings).solve(guarded);
        assert.equal(calls[0].body.clientKey, 'fixture-secret-key');
        assert.equal(process.env.OTHER, undefined);
      }
      process.env.TWOCAPTCHA_API_KEY = 'fixture-environment-key';
      calls = []; await fresh(settings).solve(guarded);
      assert.equal(calls[0].body.clientKey, 'fixture-environment-key');
      process.env.TWOCAPTCHA_API_KEY = '';
      calls = []; const before = reservations;
      await error(fresh(settings).solve(guarded), 'missing-key', 'not-submitted');
      delete process.env.TWOCAPTCHA_API_KEY;
      for (const content of ['', 'TWOCAPTCHA_API_KEY=\n', 'TWOCAPTCHA_API_KEY=fixture-secret-key\nTWOCAPTCHA_API_KEY=other\n', 'TWOCAPTCHA_API_KEY="unterminated\n', 'bad line\n']) {
        fs.writeFileSync(file, content); await error(fresh(settings).solve(guarded), 'unsafe-env-file', 'not-submitted');
      }
      fs.chmodSync(file, 0o644); await error(fresh(settings).solve(guarded), 'unsafe-env-file', 'not-submitted'); fs.chmodSync(file, 0o600);
      const link = path.join(dir, 'env-link'); fs.symlinkSync(file, link);
      await error(fresh({ ...settings, envFile: link }).solve(guarded), 'unsafe-env-file', 'not-submitted');
      const hard = path.join(dir, 'env-hard'); fs.linkSync(file, hard);
      await error(fresh(settings).solve(guarded), 'unsafe-env-file', 'not-submitted'); fs.unlinkSync(hard);
      fs.unlinkSync(file); await error(fresh(settings).solve(guarded), 'unsafe-env-file', 'not-submitted');
      execFileSync('mkfifo', [file]); await error(fresh(settings).solve(guarded), 'unsafe-env-file', 'not-submitted'); fs.unlinkSync(file);
      const publicDir = path.join(dir, 'workspace'); fs.mkdirSync(publicDir, { mode: 0o755 });
      const localFile = path.join(publicDir, '.env'); fs.writeFileSync(localFile, 'TWOCAPTCHA_API_KEY=fixture-secret-key\n', { mode: 0o600 });
      await fresh({ ...settings, envFile: localFile }).solve(guarded); calls = [];
      fs.chmodSync(publicDir, 0o777);
      const afterSafe = reservations;
      await error(fresh({ ...settings, envFile: localFile }).solve(guarded), 'unsafe-env-file', 'not-submitted');
      assert.equal(reservations, afterSafe);
      assert.equal(reservations, before + 1); assert.equal(calls.length, 0);
    } finally {
      if (old === undefined) delete process.env.TWOCAPTCHA_API_KEY; else process.env.TWOCAPTCHA_API_KEY = old;
    }
  });
  await t.test('provider errors and malformed responses are redacted', async () => {
    handler = (req, res) => send(res, { errorId: 1, errorDescription: 'fixture-secret-key fixture-token fixture-proxy-password' });
    await error(fresh().solve(hooks), 'provider-error', 'rejected');
    handler = (req, res) => send(res, req.url === '/createTask' ? { errorId: 0, taskId: 3 } : { errorId: 0, status: 'ready', solution: {} });
    await error(fresh().solve(hooks), 'malformed-response', 'submitted');
    handler = (req, res) => send(res, req.url === '/createTask' ? { errorId: 0, taskId: 3 } : { errorId: 1, errorDescription: 'fixture-token' });
    await error(fresh().solve(hooks), 'provider-error', 'submitted');
    handler = (req, res) => res.end('{');
    await error(fresh().solve(hooks), 'submit-unknown', 'unknown');
  });
  await t.test('ambiguous submission is never retried', async () => {
    calls = []; handler = req => req.socket.destroy();
    const job = fresh(); await error(job.solve(hooks), 'submit-unknown', 'unknown');
    await error(job.solve(hooks), 'already-used', 'unknown'); assert.equal(calls.length, 1);
  });
  await t.test('timeout and abort', async () => {
    handler = () => {};
    await error(fresh({ ...config, timeoutMs: 30 }).solve(hooks), 'timeout', 'unknown');
    const controller = new AbortController();
    const promise = fresh().solve({ ...hooks, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await error(promise, 'aborted', 'unknown');
    handler = (req, res) => send(res, req.url === '/createTask' ? { errorId: 0, taskId: 4 } : { errorId: 0, status: 'processing' });
    await error(fresh({ ...config, timeoutMs: 35 }).solve(hooks), 'timeout', 'submitted');
    await error(fresh({ ...config, timeoutMs: 20 }).solve({ ...hooks, authorize: () => new Promise(() => {}) }), 'timeout', 'not-submitted');
  });
  await t.test('opt in, preflight and private key enforcement', async () => {
    assert.equal(validateCaptchaConfig(undefined), undefined);
    assert.throws(() => validateCaptchaConfig({ ...config, endpoint: 'http://127.0.0.1' }));
    assert.throws(() => validateCaptchaConfig({ ...config, enabled: false }));
    calls = [];
    await error(fresh().solve({ ...hooks, authorize: () => false }), 'authorization-required', 'not-submitted');
    await error(fresh().solve({ ...hooks, reserve: () => false }), 'reservation-required', 'not-submitted');
    fs.chmodSync(keyFile, 0o644);
    await error(fresh().solve(hooks), 'unsafe-key-file', 'not-submitted');
    fs.chmodSync(keyFile, 0o600);
    const link = path.join(dir, 'link'); fs.symlinkSync(keyFile, link);
    await error(fresh({ ...config, keyFile: link }).solve(hooks), 'unsafe-key-file', 'not-submitted');
    const hardlink = path.join(dir, 'hardlink'); fs.linkSync(keyFile, hardlink);
    await error(fresh().solve(hooks), 'unsafe-key-file', 'not-submitted');
    fs.unlinkSync(hardlink);
    fs.chmodSync(dir, 0o755);
    await error(fresh().solve(hooks), 'unsafe-key-file', 'not-submitted');
    fs.chmodSync(dir, 0o700);
    await error(fresh({ ...config, keyFile: path.resolve('package.json') }).solve(hooks), 'unsafe-key-file', 'not-submitted');
    assert.equal(calls.length, 0);
  });
  await t.test('inherited configuration fields reject before task creation', () => {
    calls = [];
    for (const inherited of [Object.create(config), Object.assign(Object.create({ provider: '2captcha' }), { ...config, provider: undefined })]) {
      assert.throws(() => validateCaptchaConfig(inherited), { code: 'invalid-config', outcome: 'not-submitted' });
      assert.throws(() => createTurnstileTask(inherited, task), { code: 'invalid-config', outcome: 'not-submitted' });
    }
    const partlyInherited = Object.create({ provider: '2captcha' });
    Object.assign(partlyInherited, { enabled: true, keyFile, timeoutMs: 1000, pollIntervalMs: 5 });
    assert.throws(() => validateCaptchaConfig(partlyInherited), { code: 'invalid-config', outcome: 'not-submitted' });
    assert.equal(calls.length, 0);
  });
  await t.test('bare repository root and nested keys reject before authorization or network', async () => {
    calls = []; let authorized = 0;
    const bare = path.join(dir, 'bare.git');
    fs.mkdirSync(bare, { mode: 0o700 });
    execFileSync('git', ['init', '--bare', '--quiet', bare]);
    assert.equal(execFileSync('git', ['-C', bare, 'rev-parse', '--is-bare-repository'], { encoding: 'utf8' }).trim(), 'true');
    const nested = path.join(bare, 'private'); fs.mkdirSync(nested, { mode: 0o700 });
    for (const parent of [bare, nested]) {
      const file = path.join(parent, 'key'); fs.writeFileSync(file, 'fixture-secret-key', { mode: 0o600 });
      await error(fresh({ ...config, keyFile: file }).solve({ ...hooks, authorize: () => { authorized++; return true; } }), 'unsafe-key-file', 'not-submitted');
    }
    assert.equal(authorized, 0); assert.equal(calls.length, 0);
  });
});
