import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, goal } from './helpers.mjs';
import { argumentsContract } from '../src/contracts.mjs';

test('validator repairs invalidate readiness for the old procedure version', async t => {
  const f = await fixture(t);
  f.controller.prepare('sesOrigin', goal({ validators: [{ id: 'check', method: 'Inspect the greeting.', argv: ['node', 'check.mjs'], files: ['check.mjs'],
    environment: 'Node.', limitations: 'One controlled example.', negative: 'A wrong greeting.' }] }));
  await f.controller.start('sesOrigin');
  const worker = f.controller.status('sesOrigin').worker;
  f.runner.run = async () => ({ code: 1, interrupted: false, output: 'The known-bad example failed.' });
  const file = path.join(f.root, 'check.mjs');
  fs.writeFileSync(file, 'A first procedure.');
  const first = await f.controller.runProcess(worker, { argv: ['node', 'check.mjs'], validatorID: 'check' });
  fs.writeFileSync(file, 'A repaired procedure.');
  await assert.rejects(f.controller.candidate(worker, { readiness: { check: [first.evidenceID] } }), /current version/);
  assert.equal(f.controller.status('sesOrigin').state, 'Working');
  const second = await f.controller.runProcess(worker, { argv: ['node', 'check.mjs'], validatorID: 'check' });
  await f.controller.candidate(worker, { readiness: { check: [second.evidenceID] } });
  assert.equal(f.controller.status('sesOrigin').state, 'Verifying');
  assert.equal(f.controller.status('sesOrigin').worker, worker);
  const run = f.store.get('run', f.controller.taskFor('sesOrigin').runID);
  assert.equal(run.validatorVersions.check, f.store.get('evidence', second.evidenceID).validatorVersionAfter);
  assert.notEqual(run.validatorVersions.check, f.store.get('evidence', first.evidenceID).validatorVersionAfter);
});
test('argument contracts preserve literal empty arguments and whitespace', () => {
  assert.deepEqual(argumentsContract(['node', '-e', ' ', '']), ['node', '-e', ' ', '']);
  assert.throws(() => argumentsContract(['']), /executable/);
  assert.throws(() => argumentsContract(['node', '\0']), /executable/);
});
