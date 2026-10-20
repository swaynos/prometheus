import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const baseline = process.argv[2];
assert.ok(baseline, 'Supply an immutable baseline directory.');
function records(root, relative = '') {
  return fs.readdirSync(path.join(root, relative)).sort().flatMap(name => {
    if (['opencode.json', 'SPEC.md', '.DS_Store'].includes(name)) return [];
    const file = path.join(relative, name);
    const stat = fs.lstatSync(path.join(root, file));
    assert.ok(!stat.isSymbolicLink(), 'An unchanged fixture cannot gain a symlink.');
    return stat.isDirectory() ? records(root, file) : [[file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]];
  });
}
assert.deepEqual(records(process.cwd()), records(baseline), 'Investigation or preparation changed product artifacts.');
console.log('Product artifacts match the original fixture.');
