import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, callContext, criteria, toolMessage, result } from './helpers.mjs';
import { Records } from '../src/records.mjs';
import { Verification } from '../src/verification.mjs';

async function setup(t, options) {
  const h = await fixture(t, options);
  fs.writeFileSync(path.join(h.root, 'greeting.txt'), 'hello');
  const service = new Verification(h.ctx, new Records(h.ctx));
  t.after(() => service.stop('Test cleanup.'));
  return { ...h, service };
}
const start = h => h.service.execute('start', { criteria }, callContext());
async function report(h, verification, results = [result()]) {
  return h.service.execute('report', { verificationID: verification.id, results }, callContext(verification.evaluator));
}

test('verification creates one native child, inherits permissions, and does not execute commands', async t => {
  const h = await setup(t);
  const verification = await start(h);
  const child = h.sessions.get(verification.evaluator);
  assert.deepEqual(child.permissions, h.sessions.get('sesOrigin').permissions);
  assert.deepEqual(child.model, h.sessions.get('sesOrigin').model);
  assert.equal(child.parentID, 'sesOrigin');
  assert.equal(h.assertions[0].action, 'subagent');
  assert.equal(h.synthetics.length, 1);
  assert.equal(verification.status, 'pending');
  assert.match(h.synthetics[0].text, /not an isolated or read-only sandbox/);
  await assert.rejects(start(h), /already pending/);
});

test('Plan and native delegation denial prevent evaluator dispatch', async t => {
  const h = await setup(t, { agent: 'plan' });
  await assert.rejects(start(h), /Switch to Build/);
  assert.equal(h.assertions.length, 0);
  h.sessions.get('sesOrigin').agent = 'build';
  h.ctx.permission.assert = async () => { throw new Error('Native permission denied.'); };
  await assert.rejects(start(h), /Native permission denied/);
  assert.equal(h.sessions.size, 1);
  assert.equal(h.synthetics.length, 0);
});

test('fresh evaluator accepts actual native evidence, not worker assertions', async t => {
  const h = await setup(t);
  const verification = await start(h);
  h.messages.set('sesOrigin', [toolMessage()]);
  await assert.rejects(h.service.execute('report', { verificationID: verification.id, results: [result()] }, callContext()), /Only the assigned evaluator/);
  await assert.rejects(report(h, verification), /completed native tool result/);
  h.messages.set(verification.evaluator, [toolMessage()]);
  const event = { sessionID: verification.evaluator, tools: { shell: {}, edit: {} }, system: [] };
  await h.service.context(event);
  assert.match(event.system[0].text, /msgEvidence/);
  assert.deepEqual(event.tools, { shell: {}, edit: {} });
  const accepted = await report(h, verification);
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.results[0].evidence[0].content[0].text, 'hello');
  assert.equal(h.synthetics.at(-1).resume, false);
  await assert.rejects(report(h, verification), /already reported/);
  fs.writeFileSync(path.join(h.root, 'greeting.txt'), 'user edit');
  const status = await h.service.execute('status', {}, callContext());
  assert.equal(status.status, 'changed');
  assert.equal(fs.readFileSync(path.join(h.root, 'greeting.txt'), 'utf8'), 'user edit');
});

test('running tools and Prometheus tools cannot establish a pass', async t => {
  const h = await setup(t); const verification = await start(h);
  for (const override of [{ state: { status: 'running', input: {} } }, { name: 'prometheus_record' }]) {
    h.messages.set(verification.evaluator, [toolMessage(override)]);
    await assert.rejects(report(h, verification), /completed native tool result/);
  }
  h.messages.set(verification.evaluator, [toolMessage()]);
  await assert.rejects(report(h, verification, [{ ...result(), evidence: [] }]), /requires completed native tool evidence/);
});

test('changed candidates and incomplete criterion reports cannot be accepted', async t => {
  const h = await setup(t); const verification = await start(h);
  h.messages.set(verification.evaluator, [toolMessage()]);
  await assert.rejects(report(h, verification, []), /every criterion/);
  fs.writeFileSync(path.join(h.root, 'greeting.txt'), 'changed');
  await assert.rejects(report(h, verification), /candidate changed/);
});

test('failed and unresolved results return a notice without dispatching repairs', async t => {
  for (const [verdict, status] of [['fail', 'failed'], ['unresolved', 'unresolved']]) {
    const h = await setup(t); const verification = await start(h);
    const reported = await report(h, verification, [result(verdict)]);
    assert.equal(reported.status, status);
    assert.equal(h.sessions.size, 2);
    assert.equal(h.synthetics.length, 2);
    assert.equal(h.synthetics.at(-1).resume, false);
  }
});

test('an evaluator that stops without a report becomes unresolved, not permanently pending', async t => {
  const h = await setup(t); const verification = await start(h);
  await h.service.observe({ type: 'session.execution.succeeded', data: { sessionID: 'sesOrigin' } });
  assert.equal((await h.service.execute('status', {}, callContext())).status, 'pending');
  await h.service.observe({ type: 'session.execution.succeeded', data: { sessionID: verification.evaluator } });
  assert.equal((await h.service.execute('status', {}, callContext())).status, 'unresolved');
  assert.equal(h.synthetics.at(-1).resume, false);
  assert.equal(h.sessions.size, 2);
  assert.equal(h.interrupts.length, 0);
});

test('cancellation rejects late reports and interrupts only the owned evaluator', async t => {
  const h = await setup(t); const verification = await start(h);
  await h.service.observe({ type: 'session.execution.interrupted', data: { sessionID: 'sesUnrelated' } });
  assert.equal(h.interrupts.length, 0);
  await h.service.observe({ type: 'session.execution.interrupted', data: { sessionID: 'sesOrigin' } });
  await assert.rejects(report(h, verification), /interrupted/);
  assert.deepEqual(h.interrupts, [{ sessionID: verification.evaluator, resume: false }]);
  assert.equal((await h.service.execute('status', {}, callContext())).status, 'interrupted');
  assert.equal(h.synthetics.length, 1);
});

test('a restart preserves records but does not resume or accept pending work', async t => {
  const h = await setup(t); const verification = await start(h);
  const replacement = new Verification(h.ctx, new Records(h.ctx));
  assert.equal((await replacement.execute('status', {}, callContext())).status, 'interrupted');
  await assert.rejects(replacement.execute('report', { verificationID: verification.id, results: [result()] }, callContext(verification.evaluator)), /interrupted/);
  assert.equal(h.synthetics.length, 1);
  assert.equal(h.sessions.size, 2);
});

test('lost admission receipts are not replayed', async t => {
  const h = await setup(t);
  h.ctx.session.synthetic = async () => { throw new Error('Lost receipt.'); };
  await assert.rejects(start(h), /Lost receipt/);
  assert.equal((await h.service.execute('status', {}, callContext())).status, 'interrupted');
  assert.equal(h.sessions.size, 2);
  assert.equal(h.interrupts.length, 1);
});

test('cancellation during native creation stops the late child without dispatch', async t => {
  const h = await setup(t);
  const create = h.ctx.session.create;
  h.ctx.session.create = async input => {
    await h.service.observe({ type: 'session.execution.interrupted', data: { sessionID: 'sesOrigin' } });
    return create(input);
  };
  await assert.rejects(start(h), /interrupted/);
  assert.equal(h.interrupts.length, 1);
  assert.equal(h.synthetics.length, 0);
});

test('native read denial prevents candidate reads and evaluator dispatch', async t => {
  const h = await setup(t);
  h.ctx.permission.assert = async input => { if (input.action === 'read') throw new Error('Read denied.'); };
  await assert.rejects(start(h), /Read denied/);
  assert.equal(h.sessions.size, 1);
  assert.equal(h.synthetics.length, 0);
});

test('an evaluator cannot start a nested verification', async t => {
  const h = await setup(t); const verification = await start(h);
  await assert.rejects(h.service.execute('start', { criteria }, callContext(verification.evaluator)), /cannot start another verification/);
  assert.equal(h.sessions.size, 2);
});

test('lost report notification retains accepted evidence without redispatch', async t => {
  const h = await setup(t); const verification = await start(h);
  h.messages.set(verification.evaluator, [toolMessage()]);
  h.ctx.session.synthetic = async () => { throw new Error('Notification failed.'); };
  const accepted = await report(h, verification);
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.noticeError, 'Notification failed.');
  assert.equal((await h.service.execute('status', {}, callContext())).status, 'accepted');
  assert.equal(h.sessions.size, 2);
});

test('cancellation during report persistence wins over acceptance and suppresses its notice', async t => {
  const h = await setup(t); const verification = await start(h);
  h.messages.set(verification.evaluator, [toolMessage()]);
  const set = h.ctx.storage.set;
  let cancellation;
  h.ctx.storage.set = async (key, value) => {
    if (value?.status === 'accepted') cancellation = h.service.observe({ type: 'session.execution.interrupted', data: { sessionID: 'sesOrigin' } });
    return set(key, value);
  };
  assert.equal((await report(h, verification)).status, 'interrupted');
  await cancellation;
  assert.equal((await h.service.execute('status', {}, callContext())).status, 'interrupted');
  assert.equal(h.synthetics.length, 1);
});

test('verification rejects duplicate criteria and unrelated status requests', async t => {
  const h = await setup(t);
  await assert.rejects(h.service.execute('start', { criteria: [...criteria, ...criteria] }, callContext()), /unique/);
  const verification = await start(h);
  await assert.rejects(h.service.execute('status', { verificationID: verification.id }, callContext('sesUnrelated')), /another session/);
});
