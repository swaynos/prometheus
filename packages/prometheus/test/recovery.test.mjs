import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture, startFixture, goal } from './helpers.mjs';

const exec = promisify(execFile);
test('an impossibility claim alone does not establish a blocker', async t => {
  const f = await startFixture(t);
  const worker = f.controller.status('sesOrigin').worker;
  await assert.rejects(f.controller.requestPause(worker, { reason: 'This is impossible.' }), /blocker needs evidence/);
  assert.equal(f.controller.status('sesOrigin').state, 'Working');
});
test('the worker cannot mutate the product while evaluation is active', async t => {
  const f = await startFixture(t);
  const worker = f.controller.status('sesOrigin').worker;
  await f.controller.candidate(worker, { readiness: {} });
  await assert.rejects(f.controller.runProcess(worker, { argv: ['/bin/sh', '-c', 'touch x'] }), /cannot mutate/);
  assert.equal(fs.existsSync(path.join(f.root, 'x')), false);
});
test('recovery does not resume a durable pause or reset consumption', async t => {
  const f = await startFixture(t);
  f.controller.reserveRequest(f.controller.status('sesOrigin').worker, 'primary');
  await f.controller.pause('sesOrigin', 'The user cancelled.');
  const sent = f.native.sent.length;
  await f.controller.recover();
  assert.equal(f.controller.status('sesOrigin').state, 'Paused');
  assert.equal(f.controller.status('sesOrigin').requests, 1);
  assert.equal(f.native.sent.length, sent);
});
test('acceptance and its pending notification survive a reporting failure', async t => {
  const f = await startFixture(t);
  await f.controller.candidate(f.controller.status('sesOrigin').worker, { readiness: {} });
  const evaluator = f.controller.status('sesOrigin').evaluator;
  const evidence = f.controller.addEvidence(evaluator, { content: 'Observed.', criterionIDs: ['greeting'] });
  const notice = f.native.notice.bind(f.native);
  f.native.notice = async () => { throw new Error('Lost reporting connection.'); };
  await assert.rejects(f.controller.evaluate(evaluator, { results: [{ id: 'greeting', status: 'pass', explanation: 'Inspected.', evidenceIDs: [evidence.id] }] }), /Lost reporting/);
  assert.equal(f.controller.status('sesOrigin').state, 'Accepted');
  assert.equal(f.store.list('evaluation').length, 1);
  assert.equal(f.store.list('notification')[0].state, 'intended');
  f.native.notice = notice;
  await f.controller.recover();
  assert.equal(f.store.list('notification')[0].state, 'delivered');
  assert.equal(f.native.notices.length, 1);
});
test('an uncertain operation requires observed evidence before explicit resume', async t => {
  const f = await startFixture(t);
  const task = f.controller.taskFor('sesOrigin');
  f.store.put('action', { id: 'unknown', taskID: task.id, runID: task.runID, state: 'unknown' }, 'fault');
  await f.controller.pause('sesOrigin', 'The effect is unknown.');
  f.user('Resume the goal.');
  await assert.rejects(f.controller.resume('sesOrigin'), /uncertain/);
  const evidence = f.controller.addEvidence('sesOrigin', { content: 'The destination confirms no effect.', kind: 'reconciliation' });
  f.controller.reconcileOutcome('sesOrigin', { actionID: 'unknown', outcome: 'no-effect', evidenceIDs: [evidence.id] });
  await f.controller.resume('sesOrigin');
  assert.equal(f.controller.status('sesOrigin').state, 'Working');
  assert.equal(f.store.get('action', 'unknown').observedOutcome, 'no-effect');
});
test('operator grants preserve consumption and never resume a task', async t => {
  const f = await startFixture(t);
  f.controller.reserveRequest(f.controller.status('sesOrigin').worker, 'primary');
  await f.controller.pause('sesOrigin', 'The user paused.');
  const task = f.controller.taskFor('sesOrigin');
  const { stdout } = await exec(process.execPath, ['src/admin.mjs', 'grant', f.store.directory, task.id, '150'], { cwd: path.resolve(import.meta.dirname, '..') });
  assert.equal(JSON.parse(stdout).resumed, false);
  assert.equal(f.controller.status('sesOrigin').state, 'Paused');
  assert.equal(f.controller.status('sesOrigin').requests, 1);
  assert.equal(f.controller.status('sesOrigin').limits.maxRequests, 150);
});
test('a deadline stops owned work without another model request', async t => {
  const f = await fixture(t);
  f.controller.prepare('sesOrigin', goal({ limits: { maxRequests: 100, deadline: Date.now() + 80 } }));
  await f.controller.start('sesOrigin');
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(f.controller.status('sesOrigin').state, 'Paused');
  assert.match(f.controller.status('sesOrigin').reason, /deadline expired/);
  assert.equal(f.controller.status('sesOrigin').requests, 0);
});
test('evidence assertions alone do not establish an executable validator', async t => {
  const f = await fixture(t);
  f.controller.prepare('sesOrigin', goal({ validators: [{ id: 'check', method: 'Execute the test.', argv: ['/usr/bin/true'], environment: 'macOS.', limitations: 'One example.', negative: 'Reject a defect.' }] }));
  await f.controller.start('sesOrigin');
  const worker = f.controller.status('sesOrigin').worker;
  const evidence = f.controller.addEvidence(worker, { content: 'The files exist.' });
  await assert.rejects(f.controller.candidate(worker, { readiness: { check: [evidence.id] } }), /actual procedure execution/);
});
test('missing machine evidence returns to the worker without a user pause', async t => {
  const f = await startFixture(t);
  const worker = f.controller.status('sesOrigin').worker;
  for (const d of f.store.list('dispatch')) f.store.update('dispatch', d.id, () => ({ state: 'settled' }), 'test_receipt');
  await f.controller.candidate(worker, { readiness: {} });
  const evaluator = f.controller.status('sesOrigin').evaluator;
  await f.controller.evaluate(evaluator, { results: [{ id: 'greeting', status: 'unresolved', explanation: 'Collect the missing test result.', evidenceIDs: [] }] });
  assert.equal(f.controller.status('sesOrigin').state, 'Working');
  assert.equal(f.controller.status('sesOrigin').worker, worker);
});
test('proposed limits cannot increase the approved allowance', async t => {
  const f = await fixture(t, { limits: { maxRequests: 2 } });
  f.controller.prepare('sesOrigin', goal({ limits: { maxRequests: 1000 } }));
  assert.equal(f.controller.status('sesOrigin').limits.maxRequests, 2);
  await assert.rejects(f.controller.start('sesOrigin'), /allowance lacks user authority/);
  assert.equal(fs.existsSync(path.join(f.root, 'SPEC.md')), false);
});
test('an unapproved Plan proposal cannot fund investigation children', async t => {
  const f = await fixture(t, { agent: 'plan', limits: null });
  f.controller.prepare('sesOrigin', goal());
  await assert.rejects(f.controller.spike('sesOrigin', { question: 'Question?', decision: 'Select a method.', experiment: 'Inspect.', observations: 'Report.', writable: false }), /Obtain an aggregate/);
  assert.equal(f.native.sessions.size, 1);
});
test('a spike limit produces an inconclusive finding without a global attempt quota', async t => {
  const f = await fixture(t);
  const spike = await f.controller.spike('sesOrigin', { question: 'Question?', decision: 'Select a method.', experiment: 'Inspect.', observations: 'Report.', writable: false, allowance: { maxRequests: 1 } });
  f.controller.reserveRequest(spike.sessionID, 'primary');
  assert.throws(() => f.controller.reserveRequest(spike.sessionID, 'primary'), /spike allowance/);
  assert.equal(f.controller.status('sesOrigin').findings[0].outcome, 'inconclusive');
  assert.equal(f.controller.status('sesOrigin').requests, 1);
  assert.equal(f.controller.status('sesOrigin').limits.maxRequests, 100);
});
test('a never-created worker can complete its intended creation after explicit resume', async t => {
  const f = await fixture(t);
  f.controller.prepare('sesOrigin', goal());
  const create = f.native.create.bind(f.native);
  f.native.create = async () => { throw new Error('Creation failed before effect.'); };
  await assert.rejects(f.controller.start('sesOrigin'), /Creation failed/);
  const worker = f.controller.status('sesOrigin').worker;
  assert.equal(f.native.sessions.has(worker), false);
  f.native.create = create;
  f.user('Resume the goal.');
  await f.controller.resume('sesOrigin');
  assert.equal(f.controller.status('sesOrigin').worker, worker);
  assert.equal(f.native.sessions.has(worker), true);
  assert.equal(f.native.sent.length, 1);
});
test('a denied evaluator creation does not make the existing worker impossible to resume', async t => {
  const f = await startFixture(t);
  const worker = f.controller.status('sesOrigin').worker;
  f.native.authorizeChild = async () => { throw new Error('No evaluator permission.'); };
  await assert.rejects(f.controller.candidate(worker, { readiness: {} }), /No evaluator permission/);
  delete f.native.authorizeChild;
  f.user('Resume the goal.');
  await f.controller.resume('sesOrigin');
  assert.equal(f.controller.status('sesOrigin').worker, worker);
  assert.equal(f.controller.status('sesOrigin').state, 'Working');
});
test('an inspectable local timeout remains ordinary repair', async t => {
  const f = await startFixture(t);
  f.runner.run = async () => ({ code: null, signal: 'SIGKILL', output: '', interrupted: true });
  await f.controller.runProcess(f.controller.status('sesOrigin').worker, { argv: ['test'] });
  assert.equal(f.controller.status('sesOrigin').state, 'Working');
  assert.equal(f.store.list('action')[0].state, 'settled');
});
test('an interrupted network operation retains an unknown effect', async t => {
  const f = await startFixture(t);
  f.runner.run = async () => ({ code: null, signal: 'SIGKILL', output: '', interrupted: true });
  await f.controller.runProcess(f.controller.status('sesOrigin').worker, { argv: ['test'], network: true });
  assert.equal(f.controller.status('sesOrigin').state, 'Paused');
  assert.equal(f.store.list('action')[0].state, 'unknown');
});
test('retirement ends a run without accepting it or resetting consumption', async t => {
  const f = await startFixture(t);
  const worker = f.controller.status('sesOrigin').worker;
  f.controller.reserveRequest(worker, 'primary');
  await f.controller.retire('sesOrigin');
  assert.equal(f.controller.status('sesOrigin').retired, true);
  assert.equal(f.controller.status('sesOrigin').state, 'Paused');
  assert.equal(f.controller.status('sesOrigin').requests, 1);
  assert.throws(() => f.controller.reserveRequest(worker, 'primary'), /retired/);
  f.user('/goal');
  await f.controller.start('sesOrigin');
  assert.notEqual(f.controller.status('sesOrigin').worker, worker);
  assert.equal(f.controller.status('sesOrigin').requests, 1);
});
test('pause status distinguishes a requested stop from confirmed cessation', async t => {
  const f = await startFixture(t);
  let release;
  const interrupted = f.native.interrupt.bind(f.native);
  f.native.interrupt = async key => { await new Promise(resolve => { release = resolve; }); return interrupted(key); };
  await f.controller.pause('sesOrigin', 'The user requested a stop.');
  assert.equal(f.controller.status('sesOrigin').state, 'Paused');
  assert.equal(f.controller.status('sesOrigin').stop.state, 'requested');
  release();
  await f.controller.stopFlights.get(f.controller.taskFor('sesOrigin').runID);
  assert.equal(f.controller.status('sesOrigin').stop.state, 'confirmed');
  f.native.interrupt = interrupted;
});
test('a later edit invalidates current acceptance without erasing the accepted history', async t => {
  const f = await startFixture(t);
  await f.controller.candidate(f.controller.status('sesOrigin').worker, { readiness: {} });
  const evaluator = f.controller.status('sesOrigin').evaluator;
  const evidence = f.controller.addEvidence(evaluator, { content: 'Observed.', criterionIDs: ['greeting'] });
  await f.controller.evaluate(evaluator, { results: [{ id: 'greeting', status: 'pass', explanation: 'Inspected.', evidenceIDs: [evidence.id] }] });
  fs.writeFileSync(path.join(f.root, 'later.txt'), 'User work.');
  assert.equal(f.controller.status('sesOrigin').state, 'Draft');
  assert.equal(f.controller.status('sesOrigin').acceptanceCurrent, false);
  assert.equal(f.controller.status('sesOrigin').lastRun.state, 'Accepted');
  f.user('/goal');
  await f.controller.start('sesOrigin');
  assert.equal(f.controller.status('sesOrigin').state, 'Working');
  assert.equal(fs.readFileSync(path.join(f.root, 'later.txt'), 'utf8'), 'User work.');
});
test('untrusted workflow fields cannot replace record identities or authority', async t => {
  const f = await fixture(t);
  const taskID = f.controller.taskFor('sesOrigin').id;
  const spike = await f.controller.spike('sesOrigin', { id: 'chosen', taskID: 'foreign', owner: 'foreign', question: 'Question?',
    decision: 'Select a method.', experiment: 'Inspect.', observations: 'Report.', writable: false });
  assert.notEqual(spike.id, 'chosen');
  assert.equal(spike.taskID, taskID);
  const finding = f.controller.finding(spike.sessionID, { id: 'chosen', taskID: 'foreign', outcome: 'inconclusive',
    observations: 'No result.', interpretation: 'Unknown.', limitations: 'No evidence.' });
  assert.notEqual(finding.id, 'chosen');
  assert.equal(finding.taskID, taskID);
  const decision = await f.controller.decision('sesOrigin', { id: 'chosen', taskID: 'foreign', interpretation: 'Use a fixture.',
    example: 'A controlled result.', validator: 'Inspect it.', status: 'needs-investigation' });
  assert.notEqual(decision.id, 'chosen');
  assert.equal(decision.taskID, taskID);
});
test('a new cancellation instruction cannot be cleared by late resumption work', async t => {
  const f = await startFixture(t);
  await f.controller.pause('sesOrigin', 'The user paused.');
  f.user('Resume the goal.');
  const reconcile = f.controller.reconcile.bind(f.controller);
  f.controller.reconcile = async key => { await reconcile(key); f.user('Pause the goal.', { allowStart: false, allowResume: false }); };
  await assert.rejects(f.controller.resume('sesOrigin'), /explicit user resume instruction/);
  assert.equal(f.controller.status('sesOrigin').state, 'Paused');
});
test('interruption before process dispatch has no process effect', async t => {
  const f = await startFixture(t);
  let dispatched = false;
  f.runner.run = async () => { dispatched = true; };
  await assert.rejects(f.controller.runProcess(f.controller.status('sesOrigin').worker, { argv: ['test'] }, { signal: AbortSignal.abort() }));
  assert.equal(dispatched, false);
  assert.equal(f.store.list('action').length, 0);
});
test('a lost outcome record after an effect remains unknown and never replays automatically', async t => {
  const f = await startFixture(t);
  let executions = 0;
  f.runner.run = async () => {
    executions++;
    fs.writeFileSync(path.join(f.root, 'effect.txt'), 'The effect occurred.');
    return { code: 0, interrupted: false, output: 'Completed.' };
  };
  f.controller.addEvidence = () => { throw new Error('Outcome storage failed.'); };
  await assert.rejects(f.controller.runProcess(f.controller.status('sesOrigin').worker, { argv: ['test'] }), /Outcome storage/);
  assert.equal(f.store.list('action')[0].state, 'unknown');
  await f.controller.recover();
  assert.equal(executions, 1);
  assert.equal(f.controller.status('sesOrigin').state, 'Paused');
  assert.equal(fs.readFileSync(path.join(f.root, 'effect.txt'), 'utf8'), 'The effect occurred.');
});
