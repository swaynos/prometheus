import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.mjs';
import { Runner, sandboxAvailable } from '../src/sandbox.mjs';

test('an unavailable boundary fails before process launch', async t => {
  const f = await fixture(t);
  const runner = new Runner({ available: () => false, scratchRoot: path.join(f.base, 'scratch') });
  await assert.rejects(runner.run({ argv: [process.execPath, '-e', 'process.exit(0)'], cwd: f.root }), /unavailable/);
});
test('managed processes can write authorized outputs but cannot change control files', { skip: !sandboxAvailable() }, async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.root, 'SPEC.md'), 'Protected.');
  const result = await f.runner.run({ argv: [process.execPath, '-e', `const fs=require('fs'); fs.writeFileSync('out.txt','result'); try { fs.writeFileSync('SPEC.md','bad'); process.exit(2); } catch {} `], cwd: f.root, writable: true });
  assert.equal(result.code, 0, result.output);
  assert.equal(fs.readFileSync(path.join(f.root, 'SPEC.md'), 'utf8'), 'Protected.');
  assert.equal(fs.readFileSync(path.join(f.root, 'out.txt'), 'utf8'), 'result');
});
test('read-only validation cannot write the candidate or private controller state', { skip: !sandboxAvailable() }, async t => {
  const f = await fixture(t);
  const privateFile = path.join(f.store.directory, 'secret');
  fs.writeFileSync(privateFile, 'private');
  const code = `const fs=require('fs'); for(const p of ['out.txt',${JSON.stringify(privateFile)}]) { try { fs.writeFileSync(p,'bad'); process.exit(2); } catch {} } try { fs.readFileSync(${JSON.stringify(privateFile)}); process.exit(3); } catch {} fs.writeFileSync(process.env.TMPDIR+'/allowed','yes');`;
  const result = await f.runner.run({ argv: [process.execPath, '-e', code], cwd: f.root });
  assert.equal(result.code, 0, result.output);
  assert.equal(fs.readFileSync(privateFile, 'utf8'), 'private');
  assert.equal(fs.existsSync(path.join(f.root, 'out.txt')), false);
});
test('managed processes do not inherit provider credentials', { skip: !sandboxAvailable() }, async t => {
  const f = await fixture(t);
  process.env.PROMETHEUS_TEST_SECRET = 'not-for-the-child';
  t.after(() => delete process.env.PROMETHEUS_TEST_SECRET);
  const result = await f.runner.run({ argv: [process.execPath, '-e', 'if(process.env.PROMETHEUS_TEST_SECRET)process.exit(1)'], cwd: f.root });
  assert.equal(result.code, 0, result.output);
});
test('managed processes cannot read or replace project credential files', { skip: !sandboxAvailable() }, async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.root, '.env'), 'private');
  const code = `const fs=require('fs'); try { fs.readFileSync('.env'); process.exit(2); } catch {} try { fs.writeFileSync('.env','bad'); process.exit(3); } catch {}`;
  const result = await f.runner.run({ argv: [process.execPath, '-e', code], cwd: f.root, writable: true });
  assert.equal(result.code, 0, result.output);
});
test('filesystem boundaries cover sibling paths, symlink escapes, and nested governing files', { skip: !sandboxAvailable() }, async t => {
  const f = await fixture(t);
  const outside = path.join(f.base, 'outside.txt');
  fs.writeFileSync(outside, 'User work.');
  fs.symlinkSync(outside, path.join(f.root, 'alias.txt'));
  fs.mkdirSync(path.join(f.root, 'nested'));
  fs.writeFileSync(path.join(f.root, 'nested', 'AGENTS.md'), 'Governing instructions.');
  fs.writeFileSync(path.join(f.root, 'opencode.json'), '{}');
  const code = `const fs=require('fs'); for(const p of [${JSON.stringify(outside)},'alias.txt']) {try{fs.readFileSync(p);process.exit(2)}catch{} try{fs.writeFileSync(p,'bad');process.exit(3)}catch{}} for(const p of ['nested/AGENTS.md','opencode.json']){try{fs.writeFileSync(p,'bad');process.exit(4)}catch{}}`;
  const result = await f.runner.run({ argv: [process.execPath, '-e', code], cwd: f.root, writable: true });
  assert.equal(result.code, 0, result.output);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'User work.');
});
test('the process boundary does not permit external hardlink creation', { skip: !sandboxAvailable() }, async t => {
  const f = await fixture(t);
  const outside = path.join(f.base, 'outside.txt');
  fs.writeFileSync(outside, 'User work.');
  const code = `const fs=require('fs'); try{fs.linkSync(${JSON.stringify(outside)},'hardlink');process.exit(2)}catch{}`;
  const result = await f.runner.run({ argv: [process.execPath, '-e', code], cwd: f.root, writable: true });
  assert.equal(result.code, 0, result.output);
});
test('a Data-volume alias does not widen system reads', { skip: !sandboxAvailable() }, async t => {
  const f = await fixture(t);
  const outside = path.join(f.base, 'outside.txt');
  fs.writeFileSync(outside, 'User work.');
  const alias = path.join('/System/Volumes/Data', outside);
  if (!fs.existsSync(alias)) { t.skip('This host does not expose the Data-volume alias.'); return; }
  const code = `try{require('fs').readFileSync(${JSON.stringify(alias)});process.exit(2)}catch{}`;
  const result = await f.runner.run({ argv: [process.execPath, '-e', code], cwd: f.root });
  assert.equal(result.code, 0, result.output);
});
