import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

assert.equal(process.argv[2], '--candidate');
assert.ok(process.argv[3], 'Supply the candidate directory.');
const root = path.resolve(process.argv[3]);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'reference-validation-'));
try {
  const file = path.join(scratch, 'input.json');
  const rows = [{ name: 'Ada, A.', note: '"quoted"\nnext', count: 2, active: true }, { note: null, extra: 'x\ry' }];
  const json = JSON.stringify(rows);
  fs.writeFileSync(file, json);
  const cli = args => spawnSync(process.execPath, [path.join(root, 'bin/export.mjs'), ...args], { encoding: 'utf8', timeout: 5000 });
  const csv = 'name,note,count,active,extra\r\n"Ada, A.","""quoted""\nnext",2,true,\r\n,,,,"x\ry"\r\n';
  for (const args of [['--input', file], ['--input', file, '--format', 'json'], ['--format', 'json', '--input', file]]) {
    const result = cli(args); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, `${json}\n`);
  }
  for (const args of [['--input', file, '--format', 'csv'], ['--format', 'csv', '--input', file]]) {
    const result = cli(args); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, csv);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), json);
  const empty = path.join(scratch, 'empty.json'); fs.writeFileSync(empty, '[]');
  assert.equal(cli(['--input', empty, '--format', 'csv']).stdout, '');
  for (const [index, value] of ['bad json', '{}', '[1]', '[null]', '[{"x":{}}]', '[{"x":[]}]'].entries()) {
    const invalid = path.join(scratch, `invalid-${index}.json`); fs.writeFileSync(invalid, value);
    const result = cli(['--input', invalid]); assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.ok(result.stderr.trim());
  }
  for (const args of [[], ['--input'], ['--input', file, '--format', 'xml'], ['--input', file, '--unknown', 'x'],
    ['--input', file, '--input', file], ['--input', file, '--format', 'csv', '--format', 'json'], ['--input', file, '--format'], ['--input', path.join(scratch, 'missing')]]) {
    const result = cli(args); assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.ok(result.stderr.trim());
  }
  const { exportRows } = await import(pathToFileURL(path.join(root, 'src/export.mjs')));
  assert.equal(exportRows(rows), `${json}\n`); assert.equal(exportRows(rows, { format: 'csv' }), csv);
  assert.throws(() => exportRows([1])); assert.throws(() => exportRows(rows, { format: 'xml' }));
  assert.throws(() => exportRows([{ value: Infinity }])); assert.throws(() => exportRows([new Date()]));
  assert.equal(exportRows(JSON.parse('[{"__proto__":"data","constructor":false},{"other":0}]'), { format: 'csv' }), '__proto__,constructor,other\r\ndata,false,\r\n,,0\r\n');
  assert.ok(fs.statSync(path.join(root, 'test/json.test.mjs')).isFile());
  const retained = spawnSync(process.execPath, ['--test', path.join(root, 'test/json.test.mjs')], { encoding: 'utf8', timeout: 5000 });
  assert.equal(retained.status, 0, retained.stderr);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
