import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkLinks, headingIDs, localLinkIssues } from '../../scripts/check-documentation.mjs';

test('project Markdown links point to existing files and sections', () => {
  assert.deepEqual(checkLinks(), []);
});

test('heading IDs distinguish repeated headings', () => {
  assert.deepEqual([...headingIDs('# Guide\n## Repeat\n## Repeat\n')], ['guide', 'repeat', 'repeat-1']);
});

test('local links reject missing sections, external paths, and symlink targets', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-check-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'guide.md'), '# Guide\n## Start\n');
  fs.writeFileSync(path.join(directory, '.env.secret.md'), '# Private\n');
  fs.symlinkSync('guide.md', path.join(directory, 'alias.md'));
  assert.deepEqual(localLinkIssues(directory, 'index.md', '[Start](guide.md#start)'), []);
  for (const target of ['guide.md#absent', '../outside.md', 'alias.md', 'missing.md', '.env.secret.md#private']) {
    assert.equal(localLinkIssues(directory, 'index.md', `[Link](${target})`).length, 1);
  }
});
