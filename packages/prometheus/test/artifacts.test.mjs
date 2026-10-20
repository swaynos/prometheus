import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.mjs';
import { capture, manifest, evidenceFile, checkEvidence } from '../src/artifacts.mjs';

test('capture includes untracked artifacts and binds exact bytes', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.root, 'untracked.txt'), 'new output');
  fs.writeFileSync(path.join(f.root, '.env'), 'secret');
  fs.mkdirSync(path.join(f.root, 'node_modules'));
  fs.writeFileSync(path.join(f.root, 'node_modules', 'dependency'), 'environment');
  const candidate = capture(f.root, path.join(f.base, 'candidate'));
  assert.equal(candidate.id, manifest(f.root).id);
  assert.equal(fs.readFileSync(path.join(candidate.directory, 'untracked.txt'), 'utf8'), 'new output');
  assert.equal(fs.existsSync(path.join(candidate.directory, '.env')), false);
  fs.writeFileSync(path.join(f.root, 'untracked.txt'), 'changed');
  assert.notEqual(candidate.id, manifest(f.root).id);
});
test('external and absolute symlinks cannot silently enter a candidate', async t => {
  const f = await fixture(t);
  fs.symlinkSync(f.store.directory, path.join(f.root, 'external'));
  assert.throws(() => manifest(f.root), /candidate symlink/);
});
test('evidence files reject changed bytes', async t => {
  const f = await fixture(t);
  const evidence = evidenceFile(path.join(f.store.directory, 'evidence'), 'observed');
  assert.equal(checkEvidence(evidence).id, evidence.id);
  fs.writeFileSync(evidence.file, 'modified');
  assert.throws(() => checkEvidence(evidence), /changed/);
});
test('pre-existing hardlinks cannot hide external candidate aliases', async t => {
  const f = await fixture(t);
  const outside = path.join(f.base, 'outside.txt');
  fs.writeFileSync(outside, 'User work.');
  fs.linkSync(outside, path.join(f.root, 'alias.txt'));
  assert.throws(() => manifest(f.root), /multiple hardlinks/);
});
test('a user edit during capture prevents a coherent-candidate claim without reverting the edit', async t => {
  const f = await fixture(t);
  const file = path.join(f.root, 'result.txt');
  fs.writeFileSync(file, 'First value.');
  assert.throws(() => capture(f.root, path.join(f.base, 'candidate'), {
    afterFile: () => fs.writeFileSync(file, 'Concurrent user work.'),
  }), /changed during capture/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'Concurrent user work.');
});
