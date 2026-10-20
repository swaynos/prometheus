import assert from 'node:assert/strict';
import fs from 'node:fs';
assert.equal(fs.readFileSync('greeting.txt', 'utf8'), 'hello');
