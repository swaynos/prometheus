import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import './validators.mjs';

const [good, bad, baseline] = process.argv.slice(2);
assert.ok(good && bad && baseline, 'Supply controlled good, bad, and original fixture directories.');
const root = process.cwd();
for (const file of ['src/export.mjs', 'bin/export.mjs', 'TASK.md']) assert.deepEqual(fs.readFileSync(path.join(root, file)), fs.readFileSync(path.join(baseline, file)), `Validator-only work changed ${file}.`);
console.log('Validator-only controlled checks passed.');
