import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, startFixture, goal } from './helpers.mjs';
import { Controller } from '../src/controller.mjs';
import { manifest } from '../src/artifacts.mjs';

test('Plan prepares without project writes or execution', async t => {
  const f = await fixture(t, { agent: 'plan' });
  f.controller.prepare('sesOrigin', goal());
  assert.equal(f.controller.status('sesOrigin').state, 'Draft');
  assert.equal(fs.existsSync(path.join(f.root, 'SPEC.md')), false);
  await assert.rejects(f.controller.start('sesOrigin'), /Switch to Build/);
  f.native.sessions.get('sesOrigin').agent = 'build';
  await assert.rejects(f.controller.start('sesOrigin'), /mode switch/);
  f.user('Execute your plan.');
  await f.controller.start('sesOrigin');
  assert.equal(f.controller.status('sesOrigin').state, 'Working');
});
test('an identifiable real user instruction is required', async t => {
  const f = await fixture(t);
  f.controller.prepare('sesOrigin', goal());
  f.controller.source('sesOrigin', { id: 'msgSynthetic', agent: 'build', allowStart: true });
  f.native.messages.get('sesOrigin').push({ id: 'msgSynthetic', type: 'synthetic', text: 'Execute your plan.' });
  await assert.rejects(f.controller.start('sesOrigin'), /absent from native/);
});
test('start creates one fresh worker and duplicate start returns status', async t => {
  const f = await startFixture(t);
  const worker = f.controller.status('sesOrigin').worker;
  assert.notEqual(worker, 'sesOrigin');
  assert.equal(f.native.sessions.get(worker).parentID, 'sesOrigin');
  assert.equal(f.native.sent.length, 1);
  await f.controller.start('sesOrigin');
  assert.equal(f.native.sent.length, 1);
  assert.equal(f.controller.status('sesOrigin').worker, worker);
  assert.ok(!f.native.sent[0].text.includes('msgUser'));
});
test('unknown SPEC.md content is preserved', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.root, 'SPEC.md'), 'User work.');
  f.controller.prepare('sesOrigin', goal());
  await assert.rejects(f.controller.start('sesOrigin'), /existing SPEC/);
  assert.equal(fs.readFileSync(path.join(f.root, 'SPEC.md'), 'utf8'), 'User work.');
});
test('explicit specification content can preserve an agreed existing document', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.root, 'SPEC.md'), 'Agreed requirements.');
  f.controller.prepare('sesOrigin', goal({ document: 'Agreed requirements.' }));
  await f.controller.start('sesOrigin');
  assert.equal(f.controller.status('sesOrigin').state, 'Working');
});
test('shared request reservations include spikes, compaction, and retries', async t => {
  const f = await fixture(t, { limits: { maxRequests: 3 } });
  f.controller.reserveRequest('sesOrigin', 'primary');
  f.controller.reserveRequest('sesOrigin', 'compaction');
  f.controller.reserveRequest('sesOrigin', 'primary-retry');
  assert.throws(() => f.controller.reserveRequest('sesOrigin', 'title'), /exhausted/);
  assert.equal(f.controller.status('sesOrigin').requests, 3);
});
test('status and late receipts cannot clear cancellation', async t => {
  const f = await startFixture(t);
  await f.controller.pause('sesOrigin', 'Cancelled by the user.');
  const status = f.controller.status('sesOrigin');
  assert.equal(status.state, 'Paused');
  f.native.sessions.get(status.worker).outcome = 'succeeded';
  assert.equal(f.controller.status('sesOrigin').state, 'Paused');
  await assert.rejects(f.controller.dispatch(status.worker, 'Continue.', 'late'), /prohibited/);
});
test('a stale controller cannot dispatch', async t => {
  const f = await startFixture(t);
  const run = f.store.get('run', f.controller.taskFor('sesOrigin').runID);
  f.store.update('run', run.id, () => ({ owner: 'other:123:controller' }), 'fault');
  await assert.rejects(f.controller.dispatch(run.worker, 'Continue.', 'stale'), /no longer owns/);
  // Restore the test owner for owned cleanup only.
  f.store.update('run', run.id, () => ({ owner: f.controller.owner }), 'test_cleanup');
});
test('uncertain dispatch is preserved rather than automatically replayed', async t => {
  const f = await startFixture(t);
  const worker = f.controller.status('sesOrigin').worker;
  for (const d of f.store.list('dispatch')) f.store.update('dispatch', d.id, () => ({ state: 'settled' }), 'test_receipt');
  f.native.failSend = true;
  await assert.rejects(f.controller.dispatch(worker, 'An action.', 'fault'), /Lost transport/);
  f.native.failSend = false;
  await assert.rejects(f.controller.dispatch(worker, 'An action.', 'retry'), /reconciliation/);
  assert.equal(f.store.list('dispatch').filter(d => d.state === 'unknown').length, 1);
});
test('write experiments remain pending in Plan and require explicit Build continuation', async t => {
  const f = await fixture(t, { agent: 'plan' });
  const input = { question: 'Can the tool write a fixture?', decision: 'Select the tool.', experiment: 'Write a temporary file.', observations: 'Inspect the file.', writable: true };
  const pending = await f.controller.spike('sesOrigin', input);
  assert.equal(pending.state, 'pending');
  assert.equal(f.native.sessions.size, 1);
  f.native.sessions.get('sesOrigin').agent = 'build';
  await assert.rejects(f.controller.spike('sesOrigin', input), /mode switch/);
  f.user('Continue your investigation work.', { allowInvestigation: true });
  const working = await f.controller.spike('sesOrigin', input);
  assert.equal(working.id, pending.id);
  assert.equal(f.controller.status('sesOrigin').state, 'Draft');
  assert.ok(f.native.sent[0].text.includes('Do not implement the product'));
});
test('findings stay separate from user decisions', async t => {
  const f = await fixture(t);
  const spike = await f.controller.spike('sesOrigin', { question: 'Does the file exist?', decision: 'Choose a path.', experiment: 'Read the path.', observations: 'Record existence.', writable: false });
  const finding = f.controller.finding(spike.sessionID, { outcome: 'supported', observations: 'The file exists.', interpretation: 'The path is usable.', limitations: 'Only this environment.' });
  f.user('Use another path instead.');
  await f.controller.decision('sesOrigin', { interpretation: 'Use the second path.', example: 'The output appears there.', validator: 'Inspect the path.', decision: 'Second path.', status: 'ready' });
  assert.equal(f.store.get('finding', finding.id).observations, 'The file exists.');
  assert.equal(f.controller.status('sesOrigin').decisions.length, 1);
});
test('candidate evaluation is fresh and cannot receive worker conversation', async t => {
  const f = await startFixture(t);
  fs.writeFileSync(path.join(f.root, 'greeting.txt'), 'hello');
  const worker = f.controller.status('sesOrigin').worker;
  await f.controller.candidate(worker, { readiness: {} });
  const status = f.controller.status('sesOrigin');
  assert.notEqual(status.evaluator, worker);
  assert.equal(status.state, 'Verifying');
  const prompt = f.native.sent.find(s => s.sessionID === status.evaluator).text;
  assert.ok(!prompt.includes('Execute only this specification'));
  assert.ok(prompt.includes('worker conversation is intentionally absent'));
  await assert.rejects(f.controller.evaluate(worker, { results: [] }), /independent evaluator/);
});
test('independent evidence binds acceptance to the delivered candidate', async t => {
  const f = await startFixture(t);
  fs.writeFileSync(path.join(f.root, 'greeting.txt'), 'hello');
  const worker = f.controller.status('sesOrigin').worker;
  await f.controller.candidate(worker, { readiness: {} });
  const evaluator = f.controller.status('sesOrigin').evaluator;
  const evidence = f.controller.addEvidence(evaluator, { content: 'I read hello.', criterionIDs: ['greeting'] });
  const result = await f.controller.evaluate(evaluator, { results: [{ id: 'greeting', status: 'pass', explanation: 'The file matches.', evidenceIDs: [evidence.id] }] });
  assert.equal(result.state, 'Accepted');
  assert.equal(f.native.notices.length, 1);
});
test('worker evidence and missing evidence cannot establish acceptance', async t => {
  const f = await startFixture(t);
  const worker = f.controller.status('sesOrigin').worker;
  await f.controller.candidate(worker, { readiness: {} });
  const evaluator = f.controller.status('sesOrigin').evaluator;
  const workerEvidence = f.controller.addEvidence(worker, { content: 'It passed.', criterionIDs: ['greeting'] });
  await assert.rejects(f.controller.evaluate(evaluator, { results: [{ id: 'greeting', status: 'pass', explanation: 'Looks good.', evidenceIDs: [] }] }), /requires evidence/);
  await assert.rejects(f.controller.evaluate(evaluator, { results: [{ id: 'greeting', status: 'pass', explanation: 'Worker said so.', evidenceIDs: [workerEvidence.id] }] }), /Worker assertions/);
});
test('candidate changes invalidate acceptance and preserve user edits', async t => {
  const f = await startFixture(t);
  const worker = f.controller.status('sesOrigin').worker;
  await f.controller.candidate(worker, { readiness: {} });
  const evaluator = f.controller.status('sesOrigin').evaluator;
  const evidence = f.controller.addEvidence(evaluator, { content: 'Inspection.', criterionIDs: ['greeting'] });
  fs.writeFileSync(path.join(f.root, 'user.txt'), 'Concurrent user work.');
  await assert.rejects(f.controller.evaluate(evaluator, { results: [{ id: 'greeting', status: 'pass', explanation: 'Inspected.', evidenceIDs: [evidence.id] }] }), /Delivered artifacts differ/);
  assert.equal(fs.readFileSync(path.join(f.root, 'user.txt'), 'utf8'), 'Concurrent user work.');
});
test('evaluation failure returns repair to the same worker', async t => {
  const f = await startFixture(t);
  const worker = f.controller.status('sesOrigin').worker;
  // Settle the original inbox item before the controlled evaluator reply.
  for (const d of f.store.list('dispatch')) f.store.update('dispatch', d.id, () => ({ state: 'settled' }), 'test_receipt');
  await f.controller.candidate(worker, { readiness: {} });
  const evaluator = f.controller.status('sesOrigin').evaluator;
  await f.controller.evaluate(evaluator, { results: [{ id: 'greeting', status: 'fail', explanation: 'No greeting.', evidenceIDs: [] }] });
  assert.equal(f.controller.status('sesOrigin').worker, worker);
  assert.equal(f.controller.status('sesOrigin').state, 'Working');
  assert.ok(f.native.sent.some(s => s.sessionID === worker && s.text.includes('rejected')));
});
test('missing browser evidence pauses rather than accepting', async t => {
  const f = await fixture(t);
  f.controller.prepare('sesOrigin', goal({ criteria: [{ id: 'browser', description: 'A live result exists.', pass: 'Verified live.', owner: 'browser', validatorIDs: [] }] }));
  await f.controller.start('sesOrigin');
  await f.controller.candidate(f.controller.status('sesOrigin').worker, { readiness: {} });
  await f.controller.evaluate(f.controller.status('sesOrigin').evaluator, { results: [{ id: 'browser', status: 'unresolved', explanation: 'The user must invoke /browser.', evidenceIDs: [] }] });
  assert.equal(f.controller.status('sesOrigin').state, 'Paused');
});
test('validator-only goals retain their selected intent', async t => {
  const f = await fixture(t);
  f.controller.prepare('sesOrigin', goal({ outcome: 'Create validators only.', intent: 'validators' }));
  await f.controller.start('sesOrigin');
  assert.equal(f.controller.status('sesOrigin').intent, 'validators');
  assert.ok(f.native.sent[0].text.includes('validators'));
});
test('tool boundaries block outside writes, nested execution, and governing files', async t => {
  const f = await startFixture(t);
  const worker = f.controller.status('sesOrigin').worker;
  const event = (tool, input, sessionID = worker) => ({ tool, input, sessionID });
  assert.throws(() => f.controller.checkTool(event('shell', { command: 'touch x' })), /managed/);
  assert.throws(() => f.controller.checkTool(event('execute', {})), /managed/);
  assert.throws(() => f.controller.checkTool(event('edit', { path: '../private/prometheus.sqlite' })), /managed process/);
  assert.throws(() => f.controller.checkTool(event('patch', { patchText: '*** Update File: SPEC.md\n+x' })), /managed process/);
  assert.throws(() => f.controller.checkTool(event('glob', { pattern: '../**' })), /leaves/);
  assert.throws(() => f.controller.checkTool(event('read', { path: '.env' })), /Credential/);
  assert.throws(() => f.controller.checkTool(event('edit', { path: 'greeting.txt' })), /managed process/);
  assert.throws(() => f.controller.checkTool(event('edit', { path: 'x' }, 'sesOrigin')), /managed process/);
});

test('an authorized pivot retains the worker, evidence, and consumption', async t => {
  const f = await startFixture(t);
  const worker = f.controller.status('sesOrigin').worker;
  f.controller.reserveRequest(worker, 'primary');
  await f.controller.pause('sesOrigin', 'The user selected a narrower outcome.');
  await f.controller.reconcile(f.controller.taskFor('sesOrigin').runID);
  f.user('/goal create the validator only');
  f.controller.prepare('sesOrigin', goal({ outcome: 'Create a validator.', intent: 'validators' }));
  await f.controller.start('sesOrigin');
  assert.equal(f.controller.status('sesOrigin').worker, worker);
  assert.equal(f.controller.status('sesOrigin').requests, 1);
  assert.equal(f.controller.status('sesOrigin').intent, 'validators');
});

test('changed specification content prevents further dispatch', async t => {
  const f = await startFixture(t);
  fs.writeFileSync(path.join(f.root, 'SPEC.md'), 'A user edit.');
  for (const d of f.store.list('dispatch')) f.store.update('dispatch', d.id, () => ({ state: 'settled' }), 'test_receipt');
  await assert.rejects(f.controller.dispatch(f.controller.status('sesOrigin').worker, 'Continue.', 'fault'), /SPEC.md changed/);
});

test('fresh evaluator paths resolve to the candidate, not the working directory', async t => {
  const f = await startFixture(t);
  await f.controller.candidate(f.controller.status('sesOrigin').worker, { readiness: {} });
  const evaluator = f.controller.status('sesOrigin').evaluator;
  const event = { sessionID: evaluator, tool: 'read', input: { path: 'SPEC.md' } };
  f.controller.checkTool(event);
  assert.ok(event.input.path.includes('/candidates/'));
  assert.throws(() => f.controller.checkTool({ sessionID: evaluator, tool: 'read', input: { path: path.join(f.root, 'SPEC.md') } }), /outside/);
});

test('external acceptance stays unresolved until an origin-bound receipt exists', async t => {
  const f = await fixture(t);
  f.controller.prepare('sesOrigin', goal({ criteria: [{ id: 'human', description: 'The user accepts the result.', pass: 'Explicit user acceptance.', owner: 'user', validatorIDs: [] }] }));
  await f.controller.start('sesOrigin');
  await f.controller.candidate(f.controller.status('sesOrigin').worker, { readiness: {} });
  f.user('I accept this candidate.');
  const evidence = f.controller.addEvidence('sesOrigin', { content: 'Explicit acceptance.', kind: 'user-acceptance', criterionIDs: ['human'] });
  const evaluator = f.controller.status('sesOrigin').evaluator;
  const result = await f.controller.evaluate(evaluator, { results: [{ id: 'human', status: 'pass', explanation: 'The user accepted this candidate.', evidenceIDs: [evidence.id] }] });
  assert.equal(result.state, 'Accepted');
});
test('overlapping workspace goals cannot start a second worker', async t => {
  const f = await startFixture(t);
  const nested = path.join(f.root, 'package');
  fs.mkdirSync(nested);
  const second = new Controller({ store: f.store, native: f.native, runner: f.runner, root: nested, limits: { maxRequests: 100 } });
  await f.native.create({ id: 'sesSecond', agent: 'build' });
  f.native.messages.get('sesSecond').push({ id: 'msgSecond', type: 'user', text: '/goal' });
  second.enroll('sesSecond');
  second.source('sesSecond', { id: 'msgSecond', agent: 'build', allowStart: true });
  second.prepare('sesSecond', goal());
  await assert.rejects(second.start('sesSecond'), /Another goal owns/);
  assert.equal(fs.existsSync(path.join(nested, 'SPEC.md')), false);
  assert.equal(f.store.list('session').filter(s => s.role === 'worker').length, 1);
  await second.close();
});
