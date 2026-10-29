import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture } from './helpers.mjs';
import { hash } from '../src/util.mjs';

const exec = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, '..');

test('historical database inspection is read-only and legacy grants are rejected', async t => {
  const h = await fixture(t);
  const file = path.join(h.store.directory, 'prometheus.sqlite');
  const database = new DatabaseSync(file);
  database.exec('CREATE TABLE records (kind TEXT, id TEXT, data TEXT)');
  database.prepare('INSERT INTO records VALUES (?, ?, ?)').run('run', 'runLegacy', JSON.stringify({ state: 'Working', requests: 12 }));
  database.close();
  const before = hash(fs.readFileSync(file));
  const inspected = await exec(process.execPath, ['src/admin.mjs', 'inspect', h.store.directory], { cwd: packageRoot });
  const report = JSON.parse(inspected.stdout);
  assert.equal(report.resumed, false);
  assert.equal(report.records[0].data.requests, 12);
  await assert.rejects(exec(process.execPath, ['src/admin.mjs', 'grant', h.store.directory], { cwd: packageRoot }), /Legacy grants and execution are retired/);
  assert.equal(hash(fs.readFileSync(file)), before);
});

test('old campaign arguments fail before service discovery or model execution', async () => {
  await assert.rejects(exec(process.execPath, ['qualification/run.mjs', '--manifest', '/missing/old.json', '--approval', 'old'], { cwd: packageRoot }), /No service or model request was made/);
  const { stdout } = await exec(process.execPath, ['qualification/catalog.mjs'], { cwd: packageRoot });
  const catalog = JSON.parse(stdout);
  assert.ok(catalog.workflows.some(item => item.id === 'N05'));
  assert.match(catalog.note, /No service or model work occurred/);
});
