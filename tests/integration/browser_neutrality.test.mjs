import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = '.prometheus-local/browser-enhancement';
const legacy = path.join('.prometheus-local', 'pok' + 'emon-browser-enhancement');
// Assemble prohibited identifiers so this test does not itself introduce them.
const forbidden = [
  new RegExp('pok' + '[eé]' + 'mon', 'iu'),
  new RegExp('jol' + 'tik', 'iu'),
  new RegExp('72-' + '10909-' + '101', 'iu'),
];
const excluded = name => name.split(/[\\/]/).some(part => part.startsWith('.env') ||
  ['private', 'node_modules', 'thirdparty', 'vendor', '.git'].includes(part));

// lstat every component, including ancestors, before opening a file or directory.
// This guard is for a trusted checkout, not protection against concurrent path swaps.
function safePath(base, name) {
  let current = base;
  for (const part of name.split(/[\\/]/)) {
    current = path.join(current, part);
    let stat;
    try { stat = lstatSync(current); } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
      throw error;
    }
    if (stat.isSymbolicLink()) return false;
  }
  return true;
}
function scan(base, candidates) {
  const files = [...candidates];
  function collect(dir) {
    if (excluded(dir) || !safePath(base, dir) || !lstatSync(path.join(base, dir)).isDirectory()) return;
    for (const entry of readdirSync(path.join(base, dir), { withFileTypes: true })) {
      const name = path.join(dir, entry.name);
      if (excluded(name) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) collect(name);
      else if (entry.isFile()) files.push(name);
    }
  }
  collect(artifacts);
  const matches = [];
  for (const name of new Set(files)) {
    if (excluded(name)) continue;
    if (forbidden.some(pattern => pattern.test(name))) matches.push(`${name}: filename`);
    if (!safePath(base, name) || !lstatSync(path.join(base, name)).isFile()) continue;
    const bytes = readFileSync(path.join(base, name));
    if (!bytes.includes(0) && forbidden.some(pattern => pattern.test(bytes.toString('utf8')))) matches.push(`${name}: content`);
  }
  return matches;
}
function legacyExists(base) {
  if (!safePath(base, '.prometheus-local')) return false;
  try { lstatSync(path.join(base, legacy)); return true; } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

test('owned source and feature artifacts remain retailer-neutral', () => {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root })
    .toString().split('\0').filter(Boolean);
  // Even an empty or symlinked legacy entry is a regression; never follow it.
  assert.equal(legacyExists(root), false, 'legacy artifact directory must be absent');
  assert.deepEqual(scan(root, files), []);
});

test('neutrality guard respects synthetic private and symlink boundaries', t => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'neutrality-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const marker = 'pok' + 'emon';
  mkdirSync(path.join(base, 'private'));
  writeFileSync(path.join(base, 'private', 'probe.txt'), marker);
  writeFileSync(path.join(base, '.env.fixture'), marker);
  mkdirSync(path.join(base, 'external'));
  writeFileSync(path.join(base, 'external', 'probe.txt'), marker);
  mkdirSync(path.join(base, '.prometheus-local'));
  assert.equal(legacyExists(base), false);
  mkdirSync(path.join(base, legacy));
  assert.equal(legacyExists(base), true);
  rmSync(path.join(base, legacy), { recursive: true });
  symlinkSync(path.join(base, 'external'), path.join(base, legacy));
  assert.equal(legacyExists(base), true);
  rmSync(path.join(base, legacy));
  symlinkSync(path.join(base, 'external'), path.join(base, artifacts));
  assert.deepEqual(scan(base, ['private/probe.txt', '.env.fixture', artifacts + '/probe.txt']), []);
  rmSync(path.join(base, artifacts));
  mkdirSync(path.join(base, artifacts));
  mkdirSync(path.join(base, artifacts, 'private'));
  writeFileSync(path.join(base, artifacts, 'private', 'probe.txt'), marker);
  symlinkSync(path.join(base, 'external'), path.join(base, artifacts, 'link'));
  assert.deepEqual(scan(base, [artifacts + '/link/probe.txt']), []);
  writeFileSync(path.join(base, artifacts, 'probe.txt'), marker);
  assert.equal(scan(base, []).length, 1);
  rmSync(path.join(base, '.prometheus-local'), { recursive: true });
  symlinkSync(path.join(base, 'external'), path.join(base, '.prometheus-local'));
  assert.deepEqual(scan(base, [artifacts + '/probe.txt']), []);
});
