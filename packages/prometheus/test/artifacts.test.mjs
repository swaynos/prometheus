import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.mjs';
import { manifest, candidatePaths } from '../src/artifacts.mjs';

test('manifest includes untracked files, excludes secrets and node_modules, and detects edits', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.root, 'untracked.txt'), 'new output');
  fs.writeFileSync(path.join(f.root, '.env'), 'secret');
  fs.writeFileSync(path.join(f.root, 'proxies.txt'), 'private-host:8000:private-user:private-password');
  fs.mkdirSync(path.join(f.root, 'node_modules'));
  fs.writeFileSync(path.join(f.root, 'node_modules', 'dependency'), 'environment');
  const seen = [];
  const before = manifest(f.root, { beforeRead: file => seen.push(file) });
  assert.deepEqual(seen, candidatePaths(f.root));
  assert.deepEqual(before.files.map(item => item.path), ['untracked.txt']);
  assert.ok(before.exclusions.includes('proxies.txt'));
  fs.writeFileSync(path.join(f.root, 'untracked.txt'), 'changed');
  assert.notEqual(before.id, manifest(f.root).id);
});

test('proxy lists are excluded at every depth, but placeholder examples remain candidate files', async t => {
  const f = await fixture(t);
  fs.mkdirSync(path.join(f.root, 'nested'));
  fs.writeFileSync(path.join(f.root, 'nested/proxies.txt'), 'private-host:8000:private-user:private-password');
  fs.writeFileSync(path.join(f.root, 'proxies.txt.example'), 'HOST:PORT:USER:PASS');
  const seen = [];
  const candidate = manifest(f.root, { beforeRead: file => seen.push(file) });
  assert.deepEqual(candidate.files.map(item => item.path), ['proxies.txt.example']);
  assert.deepEqual(seen, candidatePaths(f.root));
  assert.doesNotMatch(JSON.stringify(candidate), /private-host|private-user|private-password/);
});

test('external and absolute symlinks cannot enter a candidate manifest', async t => {
  const f = await fixture(t);
  fs.symlinkSync(f.store.directory, path.join(f.root, 'external'));
  assert.throws(() => manifest(f.root), /candidate symlink/);
});

test('pre-existing hardlinks cannot hide external candidate aliases', async t => {
  const f = await fixture(t);
  const outside = path.join(f.base, 'outside.txt');
  fs.writeFileSync(outside, 'User work.');
  fs.linkSync(outside, path.join(f.root, 'alias.txt'));
  assert.throws(() => manifest(f.root), /multiple hardlinks/);
});
