import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse, modify, applyEdits } from 'jsonc-parser';
import { profile } from '../../scripts/browser-profile.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const moduleURL = pathToFileURL(path.join(repo, 'scripts/browser-profile.mjs')).href;
const runtimeNames = ['state', 'runtime', 'service', 'login'].map(x => `opencode-browser-${x}.mjs`).concat('opencode-playwright-mcp.mjs');
const oldName = 'cuddly-winner-browser';
const newName = 'prometheus-browser';
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'prometheus-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'config');
  fs.mkdirSync(root, { mode: 0o700 });
  const options = { root, quiescent: true, prepare() {}, verify() {} };
  const config = path.join(root, 'opencode.jsonc');
  return { directory, root, options, config, runtime: path.join(root, newName),
    run: (action, extra = {}) => profile(action, { ...options, ...extra }),
    value: () => parse(fs.readFileSync(fs.existsSync(config) ? config : path.join(root, 'opencode.json'), 'utf8')) };
}
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 });
}
function edit(file, keys, value) {
  fs.writeFileSync(file, applyEdits(fs.readFileSync(file, 'utf8'), modify(fs.readFileSync(file, 'utf8'), keys, value, {})));
}
function legacy(f, extras = {}) {
  const entry = { type: 'local', command: ['node', path.join(f.root, 'opencode-playwright-mcp.mjs')], environment: { CUDDLY_WINNER_CONFIG_DIR: f.root }, enabled: true, ...extras };
  write(f.config, { mcp: { servers: { [oldName]: entry, unrelated: { type: 'remote', url: 'https://example.com/mcp' } } } });
  return entry;
}
function newerSource(f) {
  const sourceRoot = path.join(f.directory, 'source');
  for (const relative of [...runtimeNames.map(x => `scripts/${x}`), 'rules/resource-selection.md', 'docs/RESOURCE-SELECTION.md', 'docs/BROWSER-OPERATIONS.md', 'package.json', 'package-lock.json']) {
    write(path.join(sourceRoot, relative), fs.readFileSync(path.join(repo, relative), 'utf8'));
  }
  fs.appendFileSync(path.join(sourceRoot, 'scripts/opencode-browser-service.mjs'), '\n// New source revision.\n');
  return sourceRoot;
}

test('fresh install owns only its runtime, V2 registration, rule, and human-invoked command', t => {
  const f = fixture(t);
  const installed = f.run('install');
  assert.equal(installed.restartRequired, true);
  const value = f.value();
  assert.equal(value.$schema, 'https://opencode.ai/config.json');
  assert.deepEqual(value.mcp.servers[newName].command, [process.execPath, path.join(f.runtime, 'opencode-playwright-mcp.mjs')]);
  assert.equal(value.mcp.servers[newName].codemode, false);
  assert.equal(value.mcp.servers[newName].environment.PROMETHEUS_CONFIG_DIR, f.root);
  assert.equal(value.commands.browser.agent, 'build');
  assert.equal(value.commands.browser.subagent, false);
  assert.match(value.commands.browser.template, /separate native conversation/);
  assert.match(value.commands.browser.template, /\$ARGUMENTS/);
  assert.deepEqual(value.instructions, [path.join(f.runtime, 'rules/resource-selection.md')]);
  assert.match(fs.readFileSync(value.instructions[0], 'utf8'), /read `\.\.\/docs\/RESOURCE-SELECTION.md`/);
  assert.match(fs.readFileSync(path.join(f.runtime, 'docs/RESOURCE-SELECTION.md'), 'utf8'), /^# Managed Browser Reference/);
  assert.match(fs.readFileSync(path.join(f.runtime, 'docs/RESOURCE-SELECTION.md'), 'utf8'), /prometheus-browser\/opencode-browser-login\.mjs/);
  assert.equal(fs.existsSync(path.join(f.runtime, 'docs/BROWSER-OPERATIONS.md')), true);
  for (const name of runtimeNames) assert.equal(fs.readFileSync(path.join(f.runtime, name), 'utf8'), fs.readFileSync(path.join(repo, 'scripts', name), 'utf8'));
  assert.equal(fs.statSync(path.join(f.root, 'prometheus-browser-migration.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(f.root, 'prometheus-browser-backups')).mode & 0o777, 0o700);
  assert.deepEqual(f.run('status'), { configured: true, legacyConfigured: false, drift: [], receipt: true, pending: false, updateAvailable: false });
  assert.equal(f.run('install').unchanged, true);
  f.run('remove');
  assert.equal(fs.existsSync(path.join(f.root, 'opencode.json')), false);
  assert.equal(fs.existsSync(f.runtime), false);
  assert.equal(f.run('install').restartRequired, true, 'removal does not leave an unowned dependency directory blocking reinstall');
});

test('legacy cutover preserves JSONC, options, permissions, policies, source state, and exact rollback', t => {
  const f = fixture(t);
  const entry = legacy(f, { disabled: true, codemode: true, timeout: { startup: 45000 } });
  edit(f.config, ['permissions'], [
    { action: `${oldName}_*`, resource: '*', effect: 'ask' },
    { action: 'opencode_read_mcp_resource', resource: `${oldName}:*`, effect: 'deny' },
  ]);
  edit(f.config, ['agents'], { plan: { permissions: [{ action: `${oldName}_browser_click`, resource: '*', effect: 'deny' }] } });
  edit(f.config, ['policies'], [{ action: 'mcp.use', resource: oldName, effect: 'deny' }]);
  edit(f.config, ['providers'], { custom: { action: `${oldName}_not_a_permission` } });
  const rule = path.join(f.root, 'rules/resource-selection.md');
  write(rule, fs.readFileSync(path.join(repo, 'rules/resource-selection.md'), 'utf8').replaceAll('prometheus', 'cuddly-winner'));
  edit(f.config, ['instructions'], ['custom.md', rule]);
  fs.writeFileSync(f.config, `// Keep this comment.\n${fs.readFileSync(f.config, 'utf8')}\n`);
  const original = fs.readFileSync(f.config, 'utf8');
  write(path.join(f.root, 'cuddly-winner-browser.json'), { channel: 'default', automationCompatibility: true });
  const oldSession = path.join(f.root, 'cuddly-winner-sessions/site.account-1.json');
  write(oldSession, { fixtureSecret: 'not-real-authentication' });
  assert.throws(() => f.run('install'), /--migrate/);
  f.run('install', { migrate: true });
  const value = f.value();
  assert.equal(value.mcp.servers[oldName], undefined);
  assert.equal(value.mcp.servers[newName].disabled, true);
  assert.equal(value.mcp.servers[newName].enabled, undefined);
  assert.equal(value.mcp.servers[newName].codemode, true);
  assert.deepEqual(value.mcp.servers[newName].timeout, entry.timeout);
  assert.equal(value.permissions[0].action, `${newName}_*`);
  assert.equal(value.permissions[1].resource, `${newName}:*`);
  assert.equal(value.agents.plan.permissions[0].action, `${newName}_browser_click`);
  assert.equal(value.policies[0].resource, newName);
  assert.equal(value.providers.custom.action, `${oldName}_not_a_permission`);
  assert.deepEqual(value.instructions, ['custom.md', path.join(f.runtime, 'rules/resource-selection.md')]);
  assert.match(fs.readFileSync(f.config, 'utf8'), /Keep this comment/);
  const copied = path.join(f.root, 'prometheus-sessions/site.account-1.json');
  assert.deepEqual(fs.readFileSync(copied), fs.readFileSync(oldSession));
  assert.equal(fs.statSync(copied).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(copied)).mode & 0o777, 0o700);
  assert.doesNotMatch(JSON.stringify(f.run('status')), /not-real-authentication/);
  write(copied, { refreshed: 'preserve-new-login' });
  write(path.join(f.root, 'prometheus-browser.json'), { channel: 'chromium' });
  assert.deepEqual(f.run('status').drift, []);
  f.run('rollback');
  assert.equal(fs.readFileSync(f.config, 'utf8'), original);
  assert.match(fs.readFileSync(copied, 'utf8'), /preserve-new-login/);
  assert.equal(fs.existsSync(oldSession), true);
  assert.equal(f.run('status').legacyConfigured, true);
});

test('updates compare shipped bytes and retain unrelated config edits and user files on removal', t => {
  const f = fixture(t);
  legacy(f);
  f.run('install', { migrate: true });
  edit(f.config, ['model'], 'provider/user-selected');
  edit(f.config, ['commands', 'custom'], { template: 'Keep me' });
  edit(f.config, ['instructions'], [...f.value().instructions, 'new-user-rule.md']);
  write(path.join(f.runtime, 'user-note.txt'), 'Not an installer-owned file');
  const sourceRoot = newerSource(f);
  assert.equal(f.run('status', { sourceRoot }).updateAvailable, true);
  const update = f.run('install', { sourceRoot });
  assert.equal(update.restartRequired, true);
  assert.match(fs.readFileSync(path.join(f.runtime, 'opencode-browser-service.mjs'), 'utf8'), /New source revision/);
  assert.equal(f.run('status', { sourceRoot }).updateAvailable, false);
  assert.equal(fs.readFileSync(path.join(update.backup, 'runtime/user-note.txt'), 'utf8'), 'Not an installer-owned file');
  assert.equal(f.run('install', { sourceRoot }).unchanged, true);
  f.run('remove');
  const value = f.value();
  assert.equal(value.model, 'provider/user-selected');
  assert.deepEqual(value.commands.custom, { template: 'Keep me' });
  assert.deepEqual(value.instructions, ['new-user-rule.md']);
  assert.ok(value.mcp.servers[oldName]);
  assert.equal(value.mcp.servers[newName], undefined);
});

test('updating a fresh installation retains the absent original configuration baseline', t => {
  const f = fixture(t);
  f.run('install');
  f.run('install', { sourceRoot: newerSource(f) });
  f.run('rollback');
  assert.equal(fs.existsSync(path.join(f.root, 'opencode.json')), false);
});

test('migration preserves effective V2 Code Mode and disabled preferences without widening permissions', t => {
  const f = fixture(t);
  legacy(f, { enabled: false });
  f.run('install', { migrate: true });
  assert.equal(f.value().mcp.servers[newName].codemode, true, 'V2 defaults to Code Mode when the old entry omits it');
  assert.equal(f.value().mcp.servers[newName].disabled, true);
  assert.equal(f.value().permissions, undefined);
});

test('failed dependency preparation and readiness checks leave no cutover and permit retry', t => {
  for (const failure of ['prepare', 'verify']) {
    const f = fixture(t);
    legacy(f);
    const before = fs.readFileSync(f.config, 'utf8');
    assert.throws(() => f.run('install', { migrate: true, [failure]() { throw new Error('fixture failure'); } }), failure === 'prepare' ? /dependency preparation failed/ : /fixture failure/);
    assert.equal(fs.readFileSync(f.config, 'utf8'), before);
    assert.equal(fs.existsSync(f.runtime), false);
    assert.equal(f.run('status').pending, false);
    assert.equal(fs.readdirSync(f.root).some(x => x.startsWith('.prometheus-browser-stage-')), false);
    f.run('install', { migrate: true });
  }
});

test('publication errors roll back config, runtime, and receipt for fresh installs and updates', t => {
  for (const update of [false, true]) {
    const f = fixture(t);
    legacy(f);
    if (update) f.run('install', { migrate: true });
    const before = fs.readFileSync(f.config, 'utf8');
    const receiptFile = path.join(f.root, 'prometheus-browser-migration.json');
    const receiptBefore = fs.existsSync(receiptFile) ? fs.readFileSync(receiptFile, 'utf8') : null;
    const rename = fs.renameSync;
    let failed = false;
    const mock = t.mock.method(fs, 'renameSync', (from, to) => {
      if (!failed && to === receiptFile) { failed = true; throw new Error('fixture disk failure'); }
      return rename(from, to);
    });
    assert.throws(() => f.run('install', { migrate: true, ...(update ? { sourceRoot: newerSource(f) } : {}) }), /fixture disk failure/);
    mock.mock.restore();
    assert.equal(fs.readFileSync(f.config, 'utf8'), before);
    assert.equal(fs.existsSync(receiptFile) ? fs.readFileSync(receiptFile, 'utf8') : null, receiptBefore);
    assert.deepEqual(f.run('status').drift, []);
    assert.equal(f.run('status').pending, false);
    assert.equal(fs.existsSync(f.runtime), update);
    f.run('install', { migrate: true });
  }
});

test('interrupted staging or publication requires explicit rollback, then supports retry', t => {
  for (const update of [false, true]) for (const phase of ['prepare', 'published']) {
    const f = fixture(t);
    legacy(f);
    if (update) f.run('install', { migrate: true });
    const before = fs.readFileSync(f.config, 'utf8');
    const code = `import fs from 'node:fs'; import { profile } from ${JSON.stringify(moduleURL)};
      const root = ${JSON.stringify(f.root)};
      ${phase === 'published' ? `const rename = fs.renameSync; fs.renameSync = (from, to) => { rename(from, to); if (to === root + '/prometheus-browser-migration.json') process.exit(17); };` : ''}
      profile('install', { root, migrate: true, quiescent: true, ${update ? `sourceRoot: ${JSON.stringify(newerSource(f))},` : ''}
        prepare() { ${phase === 'prepare' ? 'process.exit(17);' : ''} }, verify() {} });`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    assert.equal(child.status, 17, child.stderr);
    assert.equal(f.run('status').pending, true);
    assert.throws(() => f.run('install'), /Interrupted migration/);
    assert.equal(f.run('rollback').recovered, true);
    assert.equal(fs.readFileSync(f.config, 'utf8'), before);
    assert.equal(fs.existsSync(f.runtime), update);
    assert.equal(f.run('status').pending, false);
    assert.deepEqual(f.run('status').drift, []);
    f.run('install', { migrate: true });
  }
});

test('concurrent edits and managed drift are preserved instead of overwritten', t => {
  const unowned = fixture(t);
  assert.throws(() => unowned.run('install', { prepare() { write(path.join(unowned.runtime, 'user-file.txt'), 'Preserve me'); } }), /Concurrent unowned runtime/);
  assert.equal(fs.readFileSync(path.join(unowned.runtime, 'user-file.txt'), 'utf8'), 'Preserve me');
  assert.equal(unowned.run('status').pending, false);
  const f = fixture(t);
  legacy(f);
  assert.throws(() => f.run('install', { migrate: true, prepare() { edit(f.config, ['model'], 'keep-concurrent'); } }), /Concurrent change preserved/);
  assert.equal(f.value().model, 'keep-concurrent');
  assert.equal(f.run('status').pending, false);
  f.run('install', { migrate: true });
  fs.appendFileSync(path.join(f.runtime, 'opencode-browser-state.mjs'), '\n// User edit.\n');
  assert.deepEqual(f.run('status').drift, [path.join(f.runtime, 'opencode-browser-state.mjs')]);
  assert.throws(() => f.run('remove'), /drift/);
  assert.throws(() => f.run('install'), /drift/);
  assert.match(fs.readFileSync(path.join(f.runtime, 'opencode-browser-state.mjs'), 'utf8'), /User edit/);
});

test('interrupted removal restores the preceding installation, including an originally absent config', t => {
  for (const migrated of [false, true]) {
    const f = fixture(t);
    if (migrated) legacy(f);
    f.run('install', { migrate: migrated });
    const configFile = migrated ? f.config : path.join(f.root, 'opencode.json');
    const before = fs.readFileSync(configFile, 'utf8');
    const code = `import fs from 'node:fs'; import { profile } from ${JSON.stringify(moduleURL)};
      const rename = fs.renameSync; fs.renameSync = (from, to) => { rename(from, to); if (to.endsWith('/retired.json')) process.exit(19); };
      profile('remove', { root: ${JSON.stringify(f.root)}, quiescent: true });`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    assert.equal(child.status, 19, child.stderr);
    assert.equal(f.run('status').pending, true);
    assert.equal(f.run('rollback').recovered, true);
    assert.equal(fs.readFileSync(configFile, 'utf8'), before);
    assert.deepEqual(f.run('status').drift, []);
    assert.equal(f.run('status').configured, true);
    f.run('remove');
    assert.equal(f.run('status').receipt, false);
  }
});

test('interrupted recovery refuses newer conflicting bytes without overwriting them', t => {
  const f = fixture(t);
  legacy(f);
  const code = `import fs from 'node:fs'; import { profile } from ${JSON.stringify(moduleURL)};
    const rename = fs.renameSync; fs.renameSync = (from, to) => { rename(from, to); if (to.endsWith('/prometheus-browser-migration.json')) process.exit(17); };
    profile('install', { root: ${JSON.stringify(f.root)}, migrate: true, quiescent: true, prepare() {}, verify() {} });`;
  assert.equal(spawnSync(process.execPath, ['--input-type=module', '-e', code]).status, 17);
  edit(f.config, ['model'], 'newer-change');
  const changed = fs.readFileSync(f.config, 'utf8');
  assert.throws(() => f.run('rollback'), /conflict preserved/);
  assert.equal(fs.readFileSync(f.config, 'utf8'), changed);
  assert.equal(f.run('status').pending, true);
});

test('actual readiness failure does not publish registration or prevent another attempt', { timeout: 120000 }, t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [fileURLToPath(moduleURL), 'install', '--config-dir', f.root, '--quiescent'], {
    encoding: 'utf8', timeout: 90000,
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(f.directory, 'missing-browsers'), PROMETHEUS_BROWSER_CHANNEL: 'default', PROMETHEUS_BROWSER_EXECUTION_MODE: 'headless' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Browser readiness check failed/);
  assert.equal(f.run('status').configured, false);
  assert.equal(f.run('status').pending, false);
  assert.equal(fs.existsSync(f.runtime), false);
  f.run('install');
});

test('unsafe roots, files, receipts, conflicting registrations, and login handoffs fail closed', t => {
  for (const setup of [
    f => { write(f.config, '{}'); write(path.join(f.root, 'opencode.json'), '{}'); },
    f => { write(f.config, '{broken'); },
    f => { write(f.config, { mcp: { servers: [] } }); },
    f => { legacy(f, { command: ['node', '/some/custom/script.mjs'] }); },
    f => { write(f.config, { mcp: { servers: { [newName]: {} } } }); },
    f => { write(f.config, { commands: { browser: { template: 'Custom browser' } } }); },
    f => { write(path.join(f.root, 'commands/browser.md'), 'Custom browser'); },
    f => { legacy(f); write(path.join(f.root, 'cuddly-winner-logins/site.json'), '{}'); },
    f => { write(path.join(f.root, 'prometheus-logins/site.json'), '{}'); },
    f => { legacy(f); edit(f.config, ['instructions'], [path.join(f.root, 'rules/resource-selection.md')]); write(path.join(f.root, 'rules/resource-selection.md'), 'custom rule'); },
    f => { legacy(f); write(path.join(f.root, 'cuddly-winner-browser.json'), { channel: 'invalid' }); },
    f => { legacy(f); write(path.join(f.root, 'cuddly-winner-sessions/site.json'), '{}'); write(path.join(f.root, 'prometheus-sessions/site.json'), '{"different":true}'); },
    f => { legacy(f); fs.symlinkSync('/does/not/exist', path.join(f.root, 'cuddly-winner-sessions')); },
    f => { fs.symlinkSync('/does/not/exist', path.join(f.root, newName)); },
    f => { write(f.config, '{}'); fs.symlinkSync(f.config, path.join(f.root, 'opencode.json')); },
    f => { write(f.config, '{}'); fs.linkSync(f.config, path.join(f.root, 'linked.json')); },
    f => { legacy(f); edit(f.config, ['permissions'], [{ action: `*${oldName}_*`, resource: '*', effect: 'deny' }]); },
    f => { legacy(f, { environment: { CUDDLY_WINNER_CONFIG_DIR: f.root, CUDDLY_WINNER_BROWSER_CHANNEL: 'default', PROMETHEUS_BROWSER_CHANNEL: 'chrome' } }); },
  ]) {
    const f = fixture(t);
    setup(f);
    const before = fs.existsSync(f.config) ? fs.readFileSync(f.config, 'utf8') : null;
    assert.throws(() => f.run('install', { migrate: true }));
    assert.equal(fs.existsSync(f.config) ? fs.readFileSync(f.config, 'utf8') : null, before);
    assert.equal(fs.existsSync(path.join(f.root, 'prometheus-browser-migration.json')), false);
  }
  const f = fixture(t);
  f.run('install');
  const receipt = path.join(f.root, 'prometheus-browser-migration.json');
  const data = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  data.files[0].name = '../../outside';
  write(receipt, data);
  assert.throws(() => f.run('rollback'), /Invalid runtime inventory/);
  assert.ok(f.value().mcp.servers[newName]);
});

test('quiescence and lock checks do not silently claim that active work is stopped', t => {
  const f = fixture(t);
  assert.throws(() => f.run('install', { quiescent: false }), /operator assertion/);
  f.run('install', { prepare() { assert.throws(() => f.run('install'), /locked/); } });
  const cli = spawnSync(process.execPath, [fileURLToPath(moduleURL), 'install', '--config-dir'], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /requires a directory/);
});

test('default config lookup honors XDG_CONFIG_HOME without writing a profile', t => {
  const f = fixture(t);
  write(path.join(f.directory, 'opencode/opencode.json'), '{not-valid-json');
  const cli = spawnSync(process.execPath, [fileURLToPath(moduleURL), 'status'], { encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: f.directory } });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /Invalid OpenCode configuration/);
  assert.equal(fs.existsSync(path.join(f.directory, 'opencode/prometheus-browser')), false);
});

test('installed runtime starts with isolated dependencies and reuses migrated state for verified transfers', { timeout: 120000 }, async t => {
  const f = fixture(t);
  const server = http.createServer((req, res) => {
    if (req.url === '/download') {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(Buffer.from('89504e470d0a1a0a', 'hex'));
    } else {
      res.setHeader('content-type', 'text/html');
      res.end('<h1 id="account" hidden>Migration fixture account</h1><input id="upload" type="file"><script>document.querySelector("#account").hidden = localStorage.getItem("fixture") !== "approved";</script>');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  legacy(f);
  write(path.join(f.root, 'cuddly-winner-browser.json'), { channel: 'default', executionMode: 'headless' });
  write(path.join(f.root, 'cuddly-winner-sessions/site.json'), { schemaVersion: 1, name: 'site', origins: [origin], capturedAt: new Date().toISOString(),
    storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: 'fixture', value: 'approved' }] }] }, verification: { selector: '#account' } });
  // Exercise the actual npm preparation and real blank-page readiness launch, not the test hooks.
  profile('install', { root: f.root, quiescent: true, migrate: true });
  write(path.join(f.root, 'prometheus-browser.json'), { channel: process.env.PROMETHEUS_TEST_BROWSER_CHANNEL || 'default', executionMode: 'headless',
    launchOptions: { slowMo: 0 }, contextOptions: { viewport: { width: 1440, height: 900 }, locale: 'en-GB' } });
  assert.equal(profile('install', { root: f.root, quiescent: true }).unchanged, true);
  const entry = f.value().mcp.servers[newName];
  const child = spawn(entry.command[0], entry.command.slice(1), { cwd: f.directory, env: { ...process.env, ...entry.environment }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let stderr = '', id = 0;
  child.stderr.on('data', chunk => { stderr += chunk; });
  const pending = new Map();
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  });
  function rpc(method, params = {}) {
    const request = ++id;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Installed RPC timed out: ${stderr}`)), 10000);
      pending.set(request, message => { clearTimeout(timeout); pending.delete(request); resolve(message); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: request, method, params })}\n`);
    });
  }
  async function call(name, args = {}) {
    const message = await rpc('tools/call', { name, arguments: args });
    assert.equal(message.result.isError, undefined, JSON.stringify(message.result));
    return message.result.content.map(x => x.text).join('');
  }
  try {
    assert.equal((await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })).result.serverInfo.name, newName);
    // Measure display settings before private saved state disables arbitrary evaluation.
    await call('browser_navigate', { url: 'about:blank' });
    assert.equal(await call('browser_evaluate', { expression: 'String(innerWidth)' }), '1440');
    await call('browser_navigate', { url: origin });
    assert.match(await call('browser_snapshot'), /Migration fixture account/);
    const status = JSON.parse(await call('browser_status'));
    assert.equal(status.hydratedAuthentication, true);
    assert.equal(status.mode, 'headless');
    assert.equal(status.playwrightVersion, '1.63.0');
    assert.deepEqual(status.contextOptions, { viewport: { width: 1440, height: 900 }, locale: 'en-GB' });
    assert.equal(status.launchOptions.slowMo, 0);
    const upload = path.join(f.directory, 'input.png');
    fs.writeFileSync(upload, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex'));
    const attached = JSON.parse(await call('browser_upload_image', { selector: '#upload', path: upload }));
    assert.equal(attached.bytes, fs.statSync(upload).size);
    const output = path.join(f.directory, 'output.png');
    await call('browser_download', { url: `${origin}/download`, path: output, signature_hex: '89504e470d0a1a0a', expected_content_type: 'application/octet-stream' });
    assert.equal(fs.readFileSync(output).toString('hex'), '89504e470d0a1a0a');
    const helper = spawnSync(process.execPath, [path.join(f.runtime, 'opencode-browser-state.mjs'), 'list', '--config-dir', f.root], { encoding: 'utf8' });
    assert.equal(helper.status, 0, helper.stderr);
    assert.doesNotMatch(helper.stdout, /approved/);
    assert.equal(fs.existsSync(path.join(f.runtime, 'node_modules/playwright/package.json')), true);
    await call('browser_close');
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timer);
  }
  const manifest = path.join(f.runtime, 'node_modules/playwright/package.json');
  fs.unlinkSync(manifest);
  assert.throws(() => profile('install', { root: f.root, quiescent: true }), /dependencies are missing or changed/);
  assert.equal(f.run('status').pending, false);
  assert.equal(f.run('status').configured, true, 'a failed readiness check does not remove a valid registration');
});
