import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'export-oracle-'));
try {
  const input = path.join(scratch, 'rows.json');
  const rows = [{ name: 'Ada, A.', note: '"quoted"\nnext', count: 2, active: true }, { note: null, extra: 'x\ry' }];
  const bytes = JSON.stringify(rows);
  fs.writeFileSync(input, bytes);
  const invoke = args => spawnSync(process.execPath, [path.join(root, 'bin/export.mjs'), ...args], { cwd: scratch, encoding: 'utf8', timeout: 10000 });
  for (const args of [['--input', input], ['--input', input, '--format', 'json'], ['--format', 'json', '--input', input]]) {
    const result = invoke(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${bytes}\n`);
  }
  const csv = 'name,note,count,active,extra\r\n"Ada, A.","""quoted""\nnext",2,true,\r\n,,,,"x\ry"\r\n';
  for (const args of [['--input', input, '--format', 'csv'], ['--format', 'csv', '--input', input]]) {
    const result = invoke(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, csv);
  }
  assert.equal(fs.readFileSync(input, 'utf8'), bytes);
  const empty = path.join(scratch, 'empty.json'); fs.writeFileSync(empty, '[]');
  assert.equal(invoke(['--input', empty, '--format', 'csv']).stdout, '');
  for (const [index, invalid] of ['not json', '{}', '[1]', '[null]', '[{"nested":{}}]', '[{"nested":[]}]'].entries()) {
    const file = path.join(scratch, `invalid-${index}.json`); fs.writeFileSync(file, invalid);
    const result = invoke(['--input', file]);
    assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.ok(result.stderr.trim());
  }
  for (const args of [[], ['--input'], ['--input', input, '--format', 'xml'], ['--input', input, '--unknown', 'x'],
    ['--input', input, '--input', input], ['--input', input, '--format', 'csv', '--format', 'json'],
    ['--input', input, '--format'], ['--input', path.join(scratch, 'missing.json')]]) {
    const result = invoke(args);
    assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.ok(result.stderr.trim());
  }
  const { exportRows } = await import(pathToFileURL(path.join(root, 'src/export.mjs')));
  assert.equal(exportRows(rows), `${bytes}\n`);
  assert.equal(exportRows(rows, { format: 'csv' }), csv);
  assert.throws(() => exportRows([1]));
  assert.throws(() => exportRows(rows, { format: 'xml' }));
  assert.throws(() => exportRows([{ value: Infinity }]));
  assert.throws(() => exportRows([new Date()]));
  const special = JSON.parse('[{"__proto__":"data","constructor":false},{"other":0}]');
  assert.equal(exportRows(special, { format: 'csv' }), '__proto__,constructor,other\r\ndata,false,\r\n,,0\r\n');
  assert.ok(fs.statSync(path.join(root, 'test/json.test.mjs')).isFile(), 'The existing JSON check is missing.');
  const retained = spawnSync(process.execPath, ['--test', path.join(root, 'test/json.test.mjs')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(retained.status, 0, retained.stderr);
  console.log('The independent JSON/CSV checks passed.');
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
