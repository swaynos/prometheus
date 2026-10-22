import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import metadata from '../package.json' with { type: 'json' };
import { OPENCODE_RELEASE_LINE, OPENCODE_VERSION_LABEL, supportsOpenCodeVersion, requireOpenCodeVersion } from '../src/compatibility.mjs';
import { serviceVersion, unsupportedVersions } from './versions.mjs';

test('the package policy accepts stable patch versions in its declared release line only', () => {
  assert.equal(OPENCODE_RELEASE_LINE, metadata.prometheus.openCodeReleaseLine);
  assert.equal(OPENCODE_VERSION_LABEL, `${OPENCODE_RELEASE_LINE}.x`);
  for (const patch of [0, 1, 2, 123]) {
    const version = `${OPENCODE_RELEASE_LINE}.${patch}`;
    assert.equal(supportsOpenCodeVersion(version), true);
    assert.doesNotThrow(() => requireOpenCodeVersion(version));
  }
  for (const version of unsupportedVersions) {
    assert.equal(supportsOpenCodeVersion(version), false);
    assert.throws(() => requireOpenCodeVersion(version), error =>
      error.message === `Prometheus supports stable OpenCode ${OPENCODE_VERSION_LABEL}. The current service reports ${version}.`);
  }
});

test('release-line matching needs no code change for another minor release', () => {
  for (const releaseLine of ['2.1', '2.2']) {
    for (const patch of [0, 2, 123]) assert.equal(supportsOpenCodeVersion(`${releaseLine}.${patch}`, releaseLine), true);
    for (const version of ['2.0.29', '3.0.0', `${releaseLine}.02`, `${releaseLine}.2-beta.1`, `${releaseLine}.2+build`, `v${releaseLine}.2`, `${releaseLine}.2\n`])
      assert.equal(supportsOpenCodeVersion(version, releaseLine), false);
    assert.equal(supportsOpenCodeVersion(`${releaseLine}.2`, releaseLine === '2.1' ? '2.2' : '2.1'), false);
  }
});

test('OpenCode dependency pins agree and satisfy the package policy', () => {
  assert.equal(metadata.dependencies['@opencode/plugin'], serviceVersion);
  assert.equal(supportsOpenCodeVersion(serviceVersion), true, 'Pin both dependencies to a stable version in the supported release line.');
});

test('the extracted npm package includes a readable compatibility policy', { timeout: 30000 }, async t => {
  const temp = path.join(fs.realpathSync(os.tmpdir()), 'opencode');
  fs.mkdirSync(temp, { recursive: true, mode: 0o700 });
  const base = fs.mkdtempSync(path.join(temp, 'prometheus-package-policy-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const exec = promisify(execFile);
  const packed = await exec('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', base], {
    cwd: path.resolve(import.meta.dirname, '..'), timeout: 15000,
  });
  const archive = JSON.parse(packed.stdout)[0].filename;
  await exec('tar', ['-xzf', path.join(base, archive), '-C', base], { timeout: 10000 });
  const installed = await import(pathToFileURL(path.join(base, 'package/src/compatibility.mjs')));
  assert.equal(installed.OPENCODE_RELEASE_LINE, OPENCODE_RELEASE_LINE);
  assert.doesNotThrow(() => installed.requireOpenCodeVersion(serviceVersion));
  assert.throws(() => installed.requireOpenCodeVersion(unsupportedVersions[0]));
});
