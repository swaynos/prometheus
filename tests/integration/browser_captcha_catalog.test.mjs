import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { CAPTCHA_TYPES, createCaptchaTask, validateCaptchaConfig } from '../../scripts/opencode-browser-2captcha.mjs';
import { bindCaptchaProxy, snapshotCaptchaValue, validateCaptchaTask, validateCaptchaSolution } from '../../scripts/opencode-browser-captcha-types.mjs';
import { captchaFixtures, captchaVariants } from './captcha_catalog_fixtures.mjs';

const fixture = type => structuredClone(captchaFixtures.find(f => f.task.type === type));
const proxy = { server: 'http://proxy.example.test:8080', credentials: { username: 'fixture-user', password: 'private-password' } };
const settings = { enabled: true, provider: '2captcha', timeoutMs: 1500, pollIntervalMs: 1 };
const canonical = task => ({ ...task, type: CAPTCHA_TYPES[task.type].canonicalType || task.type });
test('every documented API v2 task has a request and solution fixture', () => {
  assert.equal(captchaFixtures.length, 66);
  assert.deepEqual(captchaFixtures.map(f => f.task.type).sort(), Object.keys(CAPTCHA_TYPES).sort());
  for (const { task, solution } of captchaVariants) {
    assert.deepEqual(validateCaptchaTask(task), canonical(task));
    assert.deepEqual(validateCaptchaSolution(task, solution), solution);
  }
  for (const { task, solution } of captchaFixtures) {
    assert.deepEqual(validateCaptchaTask(task), canonical(task));
    assert.deepEqual(validateCaptchaSolution(task, solution), solution);
    for (const field of CAPTCHA_TYPES[task.type].required) {
      const bad = { ...task }; delete bad[field];
      assert.throws(() => validateCaptchaTask(bad));
    }
    assert.throws(() => validateCaptchaTask({ ...task, endpoint: 'https://evil.test' }));
    assert.throws(() => validateCaptchaSolution(task, {}));
  }
});

test('conditional variants, constraints and structured answers validate conservatively', () => {
  const gee = fixture('GeeTestTaskProxyless').task;
  const gee4 = { type: gee.type, websiteURL: gee.websiteURL, version: 4, initParameters: { captcha_id: 'private-id' } };
  validateCaptchaTask(gee4);
  validateCaptchaSolution(gee4, { captcha_id: 'id', lot_number: 'lot', pass_token: 'token', gen_time: '123', captcha_output: 'output' });
  assert.throws(() => validateCaptchaSolution(gee4, fixture(gee.type).solution));
  const amazon = fixture('AmazonTaskProxyless').task;
  validateCaptchaTask({ type: amazon.type, websiteURL: amazon.websiteURL, jsapiScript: 'https://example.test/jsapi.js' });
  const altcha = fixture('AltchaTaskProxyless').task;
  validateCaptchaTask({ type: altcha.type, websiteURL: altcha.websiteURL, challengeJSON: '{"challenge":"private"}' });
  const grid = fixture('GridTask').task;
  validateCaptchaSolution(grid, { click: 'No_matching_images' });
  const { websiteURL, ...aliasInput } = fixture('BasiliskTaskProxyless').task;
  assert.equal(validateCaptchaTask({ ...aliasInput, websiteUrl: websiteURL }).websiteURL, websiteURL);
  assert.throws(() => validateCaptchaTask({ ...aliasInput, websiteUrl: websiteURL, websiteURL }));
  for (const task of [
    { ...gee4, initParameters: {} }, { ...gee4, gt: 'old', challenge: 'old' },
    { ...gee, version: 2 }, { ...amazon, context: undefined },
    { ...altcha, challengeJSON: '{}' },
    { type: altcha.type, websiteURL: altcha.websiteURL },
    { ...fixture('RecaptchaV3TaskProxyless').task, minScore: 0.5 },
    { ...grid, comment: undefined }, { ...grid, minClicks: 10 },
    { ...grid, minClicks: 4, maxClicks: 3 },
    { ...fixture('ImageToTextTask').task, numeric: 6 },
    { ...fixture('AudioTask').task, lang: 'invalid' },
    { ...fixture('PazlCaptchaTask').task, task: '{}' },
    { ...gee, websiteURL: 'http://example.test' },
    { ...gee, websiteURL: 'https://user:password@example.test' },
    { ...gee, websiteURL: 'https://example.test/#fragment' },
  ]) assert.throws(() => validateCaptchaTask(task));
  for (const [type, solution] of [
    ['CoordinatesTask', { coordinates: [{ x: -1, y: 2 }] }],
    ['GridTask', { click: [0] }],
    ['BoundingBoxTask', { bounding_boxes: [{ xMin: 5, xMax: 1, yMin: 2, yMax: 6 }] }],
    ['RecaptchaV2TaskProxyless', { token: '' }],
    ['RotateTask', { rotate: Infinity }],
    ['PazlCaptchaTask', { text: '8' }],
  ]) assert.throws(() => validateCaptchaSolution(fixture(type).task, solution));
});

test('snapshots reject accessors, inherited fields, pollution and oversized payloads', () => {
  let touched = false;
  const accessor = { get type() { touched = true; return 'TextCaptchaTask'; } };
  assert.throws(() => validateCaptchaTask(accessor)); assert.equal(touched, false);
  assert.throws(() => validateCaptchaTask(Object.create(fixture('TextCaptchaTask').task)));
  assert.throws(() => snapshotCaptchaValue(JSON.parse('{"__proto__":{"polluted":true}}')));
  const circular = {}; circular.self = circular;
  assert.throws(() => snapshotCaptchaValue(circular));
  assert.throws(() => snapshotCaptchaValue({ text: 'x'.repeat(10 * 1024 * 1024 + 1) }));
  const input = { type: 'GeeTestTaskProxyless', websiteURL: 'https://example.test', version: 4, initParameters: { captcha_id: 'private-id' } };
  const copy = validateCaptchaTask(input); input.initParameters.captcha_id = 'changed';
  assert.equal(copy.initParameters.captcha_id, 'private-id'); assert.ok(Object.isFrozen(copy.initParameters));
});

test('all proxy-capable variants bind the same upstream; proxyless-only never falls back', () => {
  for (const { task } of captchaFixtures) {
    const spec = CAPTCHA_TYPES[task.type];
    if (spec.proxy === 'optional') {
      const bound = bindCaptchaProxy(task, proxy);
      assert.equal(bound.type, task.type.replace(/Proxyless$/, ''));
      assert.equal(bound.proxyAddress, 'proxy.example.test'); assert.equal(bound.proxyPort, 8080);
      assert.equal(bound.proxyLogin, 'fixture-user'); assert.equal(bound.proxyPassword, 'private-password');
    } else if (spec.proxy === 'required') {
      const input = Object.fromEntries(Object.entries(task).filter(([k]) => !k.startsWith('proxy')));
      assert.deepEqual(bindCaptchaProxy(input, proxy), canonical(task));
      assert.throws(() => validateCaptchaTask(input));
      assert.throws(() => bindCaptchaProxy(task, proxy), 'page-supplied proxy must not override pinned proxy');
    } else if (spec.proxy === 'proxyless-only') assert.throws(() => bindCaptchaProxy(task, proxy));
    else assert.deepEqual(bindCaptchaProxy(task, proxy), canonical(task));
  }
  for (const server of ['socks5://proxy.test:80', 'http://user:secret@proxy.test', 'http://proxy.test/path']) {
    assert.throws(() => bindCaptchaProxy(fixture('TurnstileTaskProxyless').task, { server }));
  }
});

test('generic transport submits every task once, delivers typed solutions privately, and settles receipts', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'captcha-catalog-'));
  fs.chmodSync(dir, 0o700);
  const keyFile = path.join(dir, 'key'); fs.writeFileSync(keyFile, 'private-api-key', { mode: 0o600 });
  let current, requests = [], rejectPoll = false, drop = false;
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      requests.push({ path: req.url, body: JSON.parse(body) });
      if (drop) { req.socket.destroy(); return; }
      res.end(JSON.stringify(req.url === '/createTask' ? { errorId: 0, taskId: 7 } :
        { errorId: 0, status: 'ready', cost: '0.0000011', solution: rejectPoll ? {} : current.solution }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const original = http.request;
  t.mock.method(https, 'request', (url, options, callback) => {
    assert.equal(new URL(url).origin, 'https://api.2captcha.com');
    return original(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, options, callback);
  });
  t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const config = { ...settings, keyFile }, hooks = { authorize: () => true, reserve: () => true, onReady: () => {} };
  for (const entry of [...captchaFixtures, ...captchaVariants]) {
    await t.test(entry.name || entry.task.type, async () => {
      current = entry; requests = []; let received, receipt, reserved = false;
      const job = createCaptchaTask(config, entry.task);
      const status = await job.solve({
        authorize: () => true, reserve: () => { reserved = true; return true; },
        onReceipt: cost => { receipt = cost; },
        onReady: solution => { assert.equal(reserved, true); assert.equal(receipt, 2); received = solution; },
      });
      assert.deepEqual(received, entry.solution);
      assert.deepEqual(status, { status: 'ready', outcome: 'submitted' });
      assert.deepEqual(requests[0].body.task, canonical(entry.task));
      assert.equal(requests[0].body.clientKey, 'private-api-key');
      assert.equal(requests.length, 2);
      await assert.rejects(job.solve(hooks), { code: 'already-used' }); assert.equal(requests.length, 2);
      assert.doesNotMatch(JSON.stringify(status), /private-/);
    });
  }
  current = fixture('TextCaptchaTask');
  requests = [];
  await createCaptchaTask(config, current.task, { languagePool: 'en' }).solve(hooks);
  assert.equal(requests[0].body.languagePool, 'en');
  requests = [];
  current = fixture('TurnstileTaskProxyless');
  await createCaptchaTask(config, fixture('TurnstileTaskProxyless').task, { proxy }).solve(hooks);
  assert.deepEqual(requests[0].body.task, fixture('TurnstileTask').task);
  current = fixture('TextCaptchaTask');
  rejectPoll = true; requests = [];
  await assert.rejects(createCaptchaTask(config, current.task).solve(hooks), { code: 'malformed-response', outcome: 'submitted' });
  rejectPoll = false; drop = true; requests = [];
  const job = createCaptchaTask(config, current.task);
  await assert.rejects(job.solve(hooks), { code: 'submit-unknown', outcome: 'unknown' });
  await assert.rejects(job.solve(hooks), { code: 'already-used' }); assert.equal(requests.length, 1);
  drop = false; requests = [];
  await assert.rejects(createCaptchaTask(config, current.task).solve({ ...hooks, reserve: () => false }), { code: 'reservation-required' });
  assert.equal(requests.length, 0);
  for (const input of [{ ...current.task, secretUnknown: 'private-secret' }, { type: 'UnknownTask' }]) {
    assert.throws(() => createCaptchaTask(config, input), e => {
      assert.doesNotMatch(`${e.stack} ${JSON.stringify(e)}`, /private-secret/);
      return e.code === 'invalid-task-or-proxy' && e.outcome === 'not-submitted';
    });
  }
});

test('operator site adapters and proxy-disclosure policies validate and snapshot', () => {
  const challenge = { type: 'TextCaptchaTask', widgetSelector: '#captcha', taskCallback: 'getTask', solutionCallback: 'applySolution' };
  const config = { ...settings, proxyMode: 'browser', policy: { ledgerDir: '/private/budget', sites: [{ origin: 'https://example.test', acceptSelector: '#accepted', challenge }], estimateMicros: 3000, dailyTasks: 1, lifetimeTasks: 1, dailyMicros: 3000, lifetimeMicros: 3000 } };
  const validated = validateCaptchaConfig(config);
  challenge.type = 'UnknownTask';
  assert.equal(validated.policy.sites[0].challenge.type, 'TextCaptchaTask');
  assert.ok(Object.isFrozen(validated.policy.sites[0].challenge));
  assert.throws(() => validateCaptchaConfig(config), { code: 'invalid-config' });
  assert.throws(() => validateCaptchaConfig({ ...settings, proxyMode: 'automatic' }), { code: 'invalid-config' });
});
