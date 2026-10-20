import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [good, bad] = process.argv.slice(2);
assert.ok(good && bad, 'Supply controlled good and bad fixture directories.');
const validator = path.join(process.cwd(), 'validate.mjs');
assert.ok(fs.statSync(validator).isFile(), 'A runnable validation procedure is missing.');
for (const [candidate, pass] of [[good, true], [bad, false]]) {
  const result = spawnSync(process.execPath, [validator, '--candidate', candidate], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, 'Validation did not finish.');
  assert.equal(result.status === 0, pass, `The validator misclassified a controlled example: ${result.stderr}`);
}
console.log('Validator controlled checks passed.');
