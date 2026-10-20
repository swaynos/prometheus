import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture } from './helpers.mjs';
import { preflight } from '../qualification/preflight.mjs';

const exec = promisify(execFile);
test('qualification requires an explicit model and approval before model work', async t => {
  const f = await fixture(t);
  const manifest = path.join(f.base, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ model: { providerID: 'fixture', id: 'fixture' }, maxRequests: 10, timeoutMs: 1000,
    cases: [{ name: 'case', fixture: f.root, prompt: 'Write a result.', oracles: [['node', '{oracle}/check.mjs']] }] }));
  const { stdout } = await exec(process.execPath, ['qualification/run.mjs', '--manifest', manifest], { cwd: path.resolve(import.meta.dirname, '..') });
  const admission = JSON.parse(stdout);
  assert.equal(admission.status, 'awaiting-approval');
  assert.equal(admission.maxRequests, 10);
  assert.match(admission.fingerprint, /^[a-f0-9]{64}$/);
  await assert.rejects(exec(process.execPath, ['qualification/run.mjs', '--manifest', manifest, '--approval', 'wrong'], { cwd: path.resolve(import.meta.dirname, '..') }), /Approval does not identify/);
});
test('qualification rejects a failed plugin before using an unrelated native goal command', async t => {
  const f = await fixture(t);
  let commandsRead = false;
  const client = {
    plugin: { list: async () => ({ data: [{ source: { type: 'local', path: f.root }, state: { status: 'failed' } }] }) },
    command: { list: async () => { commandsRead = true; return { data: [{ name: 'goal' }] }; } },
  };
  await assert.rejects(preflight(client, { root: f.root, packageRoot: f.root }), /plugin failed to load/);
  assert.equal(commandsRead, false);
});
