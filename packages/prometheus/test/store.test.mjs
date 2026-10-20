import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';

function create(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'prometheus-store-'));
  const store = new Store(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return store;
}
test('state and audit events commit together', t => {
  const s = create(t);
  assert.throws(() => s.transaction(() => { s.put('task', { id: 'a' }, 'created'); throw new Error('fault'); }));
  assert.equal(s.get('task', 'a'), undefined);
  assert.equal(s.events('task', 'a').length, 0);
  const task = s.put('task', { id: 'a', requests: 1 }, 'created');
  assert.equal(task.revision, 1);
  assert.equal(s.events('task', 'a').length, 1);
});
test('stale writes and asynchronous transactions fail', t => {
  const s = create(t);
  const first = s.put('task', { id: 'a' }, 'created');
  s.put('task', { ...first, requests: 3 }, 'updated');
  assert.throws(() => s.put('task', first, 'stale'), /Concurrent/);
  assert.throws(() => s.transaction(() => Promise.resolve()), /asynchronous/);
  assert.equal(s.get('task', 'a').requests, 3);
});
test('separate connections preserve consumption and reject conflicting revisions', t => {
  const s = create(t);
  const other = new Store(s.directory);
  t.after(() => other.close());
  const first = s.put('task', { id: 'a', requests: 4 }, 'created');
  assert.equal(other.get('task', 'a').requests, 4);
  other.update('task', 'a', () => ({ requests: 5 }), 'reserved');
  assert.throws(() => s.put('task', first, 'stale'));
  assert.equal(s.get('task', 'a').requests, 5);
});
test('private storage rejects symlinks and public directories', t => {
  const s = create(t);
  const link = `${s.directory}-link`;
  fs.symlinkSync(s.directory, link);
  t.after(() => fs.unlinkSync(link));
  assert.throws(() => new Store(link), /Symlinked/);
  const publicDir = path.join(s.directory, 'public');
  fs.mkdirSync(publicDir, { mode: 0o755 });
  assert.throws(() => new Store(publicDir), /another user/);
});
