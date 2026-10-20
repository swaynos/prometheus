import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxAvailable } from '../src/sandbox.mjs';
import { startFixture } from './helpers.mjs';

test('a worker switched to native Plan cannot retain managed product-write capability', { skip: !sandboxAvailable() }, async t => {
  const f = await startFixture(t);
  const worker = f.controller.status('sesOrigin').worker;
  f.native.sessions.get(worker).agent = 'plan';
  const result = await f.controller.runProcess(worker, { argv: ['/bin/sh', '-c', 'printf unauthorized > plan-write.txt'] });
  assert.equal(fs.existsSync(path.join(f.root, 'plan-write.txt')), false);
  assert.notEqual(result.code, 0);
});

test('native Plan cannot dispatch a network process through a retained worker role', async t => {
  const f = await startFixture(t);
  const worker = f.controller.status('sesOrigin').worker;
  f.native.sessions.get(worker).agent = 'plan';
  let dispatched = false;
  f.runner.run = async () => { dispatched = true; return { code: 0, interrupted: false }; };
  await assert.rejects(f.controller.runProcess(worker, { argv: ['controlled-test'], network: true }), /Plan/);
  assert.equal(dispatched, false);
  assert.equal(f.store.list('action').length, 0);
});
