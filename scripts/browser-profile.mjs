#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parse, modify, applyEdits } from 'jsonc-parser';
import { browserConfigFromEnv, validateBrowserConfig } from './opencode-browser-runtime.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['state', 'runtime', 'service', 'login'].map(x => `opencode-browser-${x}.mjs`).concat('opencode-playwright-mcp.mjs', 'browser-profiles.mjs');
const inventory = [...files, 'rules/resource-selection.md', 'docs/RESOURCE-SELECTION.md', 'docs/BROWSER-OPERATIONS.md', 'package.json', 'package-lock.json'];
const historical = new Set([...inventory, 'docs/BROWSER-MIGRATION.md']);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const legacy = 'cuddly-winner-browser';
const managed = 'prometheus-browser';
function stat(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
function regular(file) {
  const info = stat(file);
  if (!info) return false;
  if (!info.isFile() || info.nlink !== 1) throw new Error(`Not a single-link regular file: ${file}`);
  return true;
}
function safeRoot(root) {
  for (let here = root; ; here = path.dirname(here)) {
    const info = stat(here);
    if (info && !info.isDirectory()) throw new Error(`Not a real directory: ${here}`);
    if (path.dirname(here) === here) break;
  }
}
function privateDirectory(directory) {
  safeRoot(directory);
  if (stat(directory) && (stat(directory).mode & 0o077)) throw new Error(`Private directory must have mode 0700: ${directory}`);
}
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function configValue(text) {
  const errors = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !object(value)) throw new Error('Invalid OpenCode configuration');
  if (value.mcp !== undefined && (!object(value.mcp) || !object(value.mcp.servers))) throw new Error('Expected V2 mcp.servers configuration');
  if (value.commands !== undefined && !object(value.commands)) throw new Error('Expected commands object');
  if (value.instructions !== undefined && (!Array.isArray(value.instructions) || value.instructions.some(x => typeof x !== 'string'))) throw new Error('Expected instructions array');
  return value;
}
function configAt(root) {
  const candidates = ['opencode.json', 'opencode.jsonc'].map(x => path.join(root, x)).filter(regular);
  if (candidates.length > 1) throw new Error('Both opencode.json and opencode.jsonc exist; resolve ambiguity first.');
  const file = candidates[0] || path.join(root, 'opencode.json');
  const text = regular(file) ? fs.readFileSync(file, 'utf8') : '{ "$schema": "https://opencode.ai/config.json" }\n';
  return { file, text, value: configValue(text) };
}
function set(text, keys, value) {
  return applyEdits(text, modify(text, keys, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
}
function snapshot(file) {
  return regular(file) ? { data: fs.readFileSync(file).toString('base64'), mode: fs.statSync(file).mode & 0o777 } : null;
}
function atomic(file, data, mode = 0o600) {
  safeRoot(path.dirname(file));
  regular(file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, data, { mode, flag: 'wx' }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

const get = (value, keys) => keys.reduce((v, key) => v?.[key], value);
const encoded = value => value === undefined ? { absent: true } : { value };
const decoded = entry => entry.absent ? undefined : entry.value;
const matches = (file, digest) => regular(file) && hash(fs.readFileSync(file)) === digest;

function readReceipt(file, root) {
  if (!regular(file)) return undefined;
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('Invalid private migration receipt; inspect manually'); }
  if (receipt.version !== 2 || receipt.root !== root) throw new Error('Unsupported receipt or configuration root; reconcile manually');
  if (path.dirname(receipt.backup) !== path.join(root, 'prometheus-browser-backups') || !/^[a-f0-9-]{36}$/.test(path.basename(receipt.backup))) throw new Error('Unsafe backup path');
  safeRoot(receipt.backup);
  if (!Array.isArray(receipt.files) || receipt.files.length !== inventory.length || new Set(receipt.files.map(x => x.name)).size !== inventory.length || receipt.files.some(x => !historical.has(x.name) || !/^[a-f0-9]{64}$/.test(x.after))) throw new Error('Invalid runtime inventory');
  if (!['opencode.json', 'opencode.jsonc'].some(name => receipt.config.file === path.join(root, name))) throw new Error('Unsafe configuration path');
  if (!Array.isArray(receipt.config.changes) || receipt.config.changes.some(x => {
    const keys = x.keys;
    return !Array.isArray(keys) || !x.before || !x.after || !(
      isDeepStrictEqual(keys, ['mcp', 'servers', managed]) || isDeepStrictEqual(keys, ['mcp', 'servers', legacy]) ||
      isDeepStrictEqual(keys, ['commands', 'browser']) ||
      /^(permissions|policies)\/\d+\/(action|resource)$/.test(keys.join('/')) ||
      /^agents\/[^/]+\/(permissions|policies)\/\d+\/(action|resource)$/.test(keys.join('/')));
  })) throw new Error('Unsafe configuration change in receipt');
  if (receipt.config.retiredRule && receipt.config.retiredRule !== path.join(root, 'rules/resource-selection.md')) throw new Error('Unsafe retired instruction path');
  return receipt;
}

function drift(receipt, config, runtime) {
  const changed = receipt.files.filter(x => {
    safeRoot(path.dirname(path.join(runtime, x.name)));
    return !matches(path.join(runtime, x.name), x.after);
  }).map(x => path.join(runtime, x.name));
  if (receipt.config.file !== config.file || receipt.config.changes.some(x => !isDeepStrictEqual(get(config.value, x.keys), decoded(x.after))) ||
      !config.value.instructions?.includes(path.join(runtime, 'rules/resource-selection.md')) ||
      receipt.config.retiredRule && config.value.instructions.includes(receipt.config.retiredRule)) changed.push(config.file);
  return changed;
}

function browserCommand(runtime) {
  return { description: 'Use the managed browser in this separate native conversation.', agent: 'build', subagent: false,
    template: `This is a human-invoked browser request, separate from Prometheus goal execution. Use a separate native conversation, not an enrolled goal session. Read ${JSON.stringify(path.join(runtime, 'rules/resource-selection.md'))} and its managed browser reference before browser actions. Follow their workflow precedence, private login handoff, and evidence requirements. Do not start or resume a goal.\n\nRequest: $ARGUMENTS` };
}

function configuration(config, root, runtime, sourceRoot, previous) {
  let text = config.text;
  const changes = [];
  function edit(keys, value) {
    const before = get(config.value, keys);
    const original = previous?.config.changes.find(x => isDeepStrictEqual(x.keys, keys));
    if (!isDeepStrictEqual(before, value)) text = set(text, keys, value);
    if (original || !isDeepStrictEqual(before, value)) changes.push({ keys, before: original?.before ?? encoded(before), after: encoded(value) });
  }
  const old = config.value.mcp?.servers?.[legacy];
  const entry = previous ? config.value.mcp.servers[managed] : { ...(old || {}), type: 'local',
    command: [old?.command?.[0] || process.execPath, path.join(runtime, 'opencode-playwright-mcp.mjs')],
    environment: Object.fromEntries(Object.entries(old?.environment || {}).map(([key, value]) => [key.replace(/^CUDDLY_WINNER_/, 'PROMETHEUS_'), value])), codemode: old ? old.codemode ?? true : false };
  if (!previous) {
    for (const [key, value] of Object.entries(old?.environment || {})) {
      const renamed = key.replace(/^CUDDLY_WINNER_/, 'PROMETHEUS_');
      if (key !== renamed && old.environment[renamed] !== undefined && old.environment[renamed] !== value) throw new Error('Conflicting legacy and Prometheus environment settings; reconcile manually');
    }
    entry.environment.PROMETHEUS_CONFIG_DIR = root;
    delete entry.enabled;
    if (old?.enabled === false) entry.disabled = true;
  }
  edit(['mcp', 'servers', managed], entry);
  if (old || previous?.config.changes.some(x => isDeepStrictEqual(x.keys, ['mcp', 'servers', legacy]))) edit(['mcp', 'servers', legacy], undefined);
  edit(['commands', 'browser'], browserCommand(runtime));
  // Only migrate permission/policy patterns, not arbitrary objects with an action field.
  function patterns(value, keys) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const next = [...keys, Array.isArray(value) ? Number(key) : key];
      if (['action', 'resource'].includes(key) && typeof child === 'string' && child.includes(legacy)) {
        if (!(child === legacy || child.startsWith(`${legacy}_`) || child.startsWith(`${legacy}:`))) throw new Error('Custom legacy permission pattern requires manual reconciliation');
        edit(next, child.replace(legacy, managed));
      } else patterns(child, next);
    }
  }
  for (const name of ['permissions', 'policies']) {
    patterns(config.value[name], [name]);
    for (const [agent, value] of Object.entries(config.value.agents || {})) patterns(value[name], ['agents', agent, name]);
  }
  // Keep original permission changes across updates, even though they no longer contain the old name.
  for (const item of previous?.config.changes || []) if (!changes.some(x => isDeepStrictEqual(x.keys, item.keys))) changes.push(item);
  const oldRule = path.join(root, 'rules/resource-selection.md');
  const instructions = config.value.instructions || [];
  const retiredRule = previous?.config.retiredRule || (instructions.includes(oldRule) ? oldRule : undefined);
  if (!previous && retiredRule) {
    safeRoot(path.dirname(oldRule));
    const expected = fs.readFileSync(path.join(sourceRoot, 'rules/resource-selection.md'), 'utf8').replaceAll('prometheus', 'cuddly-winner');
    if (!regular(oldRule) || fs.readFileSync(oldRule, 'utf8') !== expected) throw new Error('Custom legacy resource rule requires manual reconciliation');
  }
  const rule = path.join(runtime, 'rules/resource-selection.md');
  text = set(text, ['instructions'], [...new Set([...instructions.filter(x => x !== retiredRule), rule])]);
  return { text, entry, record: { file: config.file, before: previous ? previous.config.before : snapshot(config.file),
    after: previous && hash(config.text) !== previous.config.after ? null : hash(text), changes,
    ...(retiredRule ? { retiredRule } : {}) } };
}

function restoreConfig(receipt, config, runtime) {
  if (drift(receipt, config, runtime).includes(config.file)) throw new Error(`Modified configuration preserved: ${config.file}`);
  if (hash(config.text) === receipt.config.after) {
    const before = receipt.config.before;
    return before ? { data: Buffer.from(before.data, 'base64'), mode: before.mode } : null;
  }
  let text = config.text;
  for (const item of [...receipt.config.changes].reverse()) text = set(text, item.keys, decoded(item.before));
  const rule = path.join(runtime, 'rules/resource-selection.md');
  const instructions = config.value.instructions.filter(x => x !== rule);
  if (receipt.config.retiredRule && !instructions.includes(receipt.config.retiredRule)) instructions.push(receipt.config.retiredRule);
  text = set(text, ['instructions'], instructions);
  return { data: Buffer.from(text), mode: fs.statSync(config.file).mode & 0o777 };
}

function verifyRuntime(stage, config, environment) {
  // A real blank-page launch checks the selected browser and display dependencies without loading accounts.
  for (const [name, version] of Object.entries(JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8')).dependencies)) {
    const manifest = path.join(stage, 'node_modules', name, 'package.json');
    safeRoot(path.dirname(manifest));
    if (!regular(manifest) || JSON.parse(fs.readFileSync(manifest, 'utf8')).version !== version) throw new Error('Installed browser dependencies are missing or changed; inspect and remove/reinstall the owned profile');
  }
  const probe = path.join(stage, '.verify.mjs');
  fs.writeFileSync(probe, `import { chromium } from 'playwright';\nimport { enterTaskDisplay } from './opencode-browser-service.mjs';\nimport { createTaskContext } from './opencode-browser-runtime.mjs';\nconst config = ${JSON.stringify(config)};\nawait enterTaskDisplay(config);\nconst { browser, context } = await createTaskContext(chromium, config);\ntry { await (await context.newPage()).goto('about:blank'); } finally { await browser.close(); }\n`, { mode: 0o600, flag: 'wx' });
  try { execFileSync(process.execPath, [probe], { env: { ...process.env, ...environment, PROMETHEUS_VIRTUAL_DISPLAY: '' }, stdio: 'pipe', timeout: 30000 }); }
  catch { throw new Error('Browser readiness check failed; install the selected Playwright browser (and xvfb/xauth for Linux virtual-display), then retry. No cutover was published.'); }
  finally { fs.unlinkSync(probe); }
}

function lockAt(file) {
  if (regular(file)) {
    const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid migration lock; inspect manually');
    try { process.kill(owner.pid, 0); throw new Error('Browser profile is locked by another operation'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    fs.unlinkSync(file);
  }
  const fd = fs.openSync(file, 'wx', 0o600);
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
  return () => { fs.closeSync(fd); fs.unlinkSync(file); };
}

function recover(pendingFile, receiptFile, root, runtime) {
  const pending = readReceipt(pendingFile, root);
  if (pending.stage !== path.join(root, `.prometheus-browser-stage-${path.basename(pending.backup)}`) || !Array.isArray(pending.writes)) throw new Error('Invalid pending migration');
  safeRoot(pending.stage);
  for (const item of pending.writes) {
    const relative = path.relative(root, item.file);
    if (item.file !== pending.config.file && relative !== 'prometheus-browser.json' && !/^prometheus-sessions\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(relative)) throw new Error('Unsafe pending write path');
    safeRoot(path.dirname(item.file));
    const current = snapshot(item.file);
    const isAfter = item.after === null ? current === null : current && hash(Buffer.from(current.data, 'base64')) === item.after;
    if (!isDeepStrictEqual(current, item.before) && !isAfter) throw new Error(`Interrupted migration conflict preserved: ${item.file}`);
  }
  const savedRuntime = path.join(pending.backup, 'runtime');
  safeRoot(savedRuntime);
  const published = pending.operation !== 'remove' && !stat(pending.stage) && stat(runtime) && (!pending.previous || stat(savedRuntime));
  function unchanged(directory, entries) {
    return entries.every(x => { safeRoot(path.dirname(path.join(directory, x.name))); return matches(path.join(directory, x.name), x.after); });
  }
  if (published && !unchanged(runtime, pending.files)) throw new Error('Interrupted runtime has changed; reconcile manually');
  if (stat(savedRuntime) && (stat(runtime) && !published || !unchanged(savedRuntime, pending.previous.files))) throw new Error('Saved runtime or its destination has changed; reconcile manually');
  // Restore configuration first. Never leave a registration pointing at a removed runtime.
  for (const item of [...pending.writes].reverse()) {
    if (item.after === null ? regular(item.file) : !matches(item.file, item.after)) continue;
    if (item.before) atomic(item.file, Buffer.from(item.before.data, 'base64'), item.before.mode);
    else fs.unlinkSync(item.file);
  }
  if (published) fs.renameSync(runtime, path.join(pending.backup, 'interrupted-runtime'));
  if (stat(savedRuntime)) fs.renameSync(savedRuntime, runtime);
  if (stat(pending.stage)) fs.rmSync(pending.stage, { recursive: true }); // Only this transaction's newly created staging tree.
  const current = readReceipt(receiptFile, root);
  if (current?.backup === pending.backup || pending.operation === 'remove' && !current) {
    if (pending.previous) atomic(receiptFile, JSON.stringify(pending.previous));
    else fs.unlinkSync(receiptFile);
  }
  fs.renameSync(pendingFile, path.join(pending.backup, 'interrupted.json'));
  return { operation: 'rollback', recovered: true, restartRequired: true };
}

export function profile(operation, { root, migrate = false, quiescent = false, prepare, verify = verifyRuntime, sourceRoot = source } = {}) {
  if (!['install', 'status', 'remove', 'rollback'].includes(operation)) throw new Error('Expected install, status, remove, or rollback');
  root = path.resolve(root || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode'));
  safeRoot(root);
  const runtime = path.join(root, managed);
  safeRoot(runtime);
  const receiptFile = path.join(root, 'prometheus-browser-migration.json');
  const pendingFile = path.join(root, 'prometheus-browser-pending.json');
  if (operation === 'status') {
    const config = configAt(root);
    const receipt = readReceipt(receiptFile, root);
    return { configured: !!config.value.mcp?.servers?.[managed], legacyConfigured: !!config.value.mcp?.servers?.[legacy],
      drift: receipt ? drift(receipt, config, runtime) : [], receipt: !!receipt, pending: regular(pendingFile),
      updateAvailable: receipt ? inventory.some(name => !matches(path.join(runtime, name), hash(payload(sourceRoot, name)))) ||
        !isDeepStrictEqual(config.value.commands?.browser, browserCommand(runtime)) : false };
  }
  if (!quiescent) throw new Error('Stop browser tasks, login helpers, and affected OpenCode servers first; then pass --quiescent. This is an explicit operator assertion, not automatic process detection.');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const unlock = lockAt(path.join(root, '.prometheus-browser-migration.lock'));
  try {
    // Both namespaces must be idle. Coordination records are never migrated or replayed.
    for (const name of ['cuddly-winner-logins', 'prometheus-logins']) {
      const directory = path.join(root, name);
      safeRoot(directory);
      if (stat(directory) && fs.readdirSync(directory).length) throw new Error('Login coordination records exist; inspect and finish/cancel handoffs first');
    }
    if (regular(pendingFile)) {
      if (operation === 'rollback') return recover(pendingFile, receiptFile, root, runtime);
      throw new Error('Interrupted migration exists; inspect status and use rollback --quiescent before retrying');
    }
    const receipt = readReceipt(receiptFile, root);
    const config = configAt(root);
    if (receipt && drift(receipt, config, runtime).length) throw new Error('Existing installation has managed-file or configuration drift; preserve it and reconcile manually');
    privateDirectory(path.join(root, 'prometheus-browser-backups'));
    if (operation === 'rollback' || operation === 'remove') {
      if (!receipt) throw new Error('No migration receipt exists');
      const restored = restoreConfig(receipt, config, runtime);
      const backup = path.join(root, 'prometheus-browser-backups', crypto.randomUUID());
      safeRoot(backup);
      fs.mkdirSync(backup, { mode: 0o700 });
      const pending = { ...receipt, backup, operation: 'remove', stage: path.join(root, `.prometheus-browser-stage-${path.basename(backup)}`), previous: receipt,
        writes: [{ file: config.file, before: snapshot(config.file), after: restored ? hash(restored.data) : null }] };
      atomic(pendingFile, JSON.stringify(pending));
      try {
        if (restored) atomic(config.file, restored.data, restored.mode);
        else fs.unlinkSync(config.file);
        fs.renameSync(runtime, path.join(backup, 'runtime'));
        fs.renameSync(receiptFile, path.join(backup, 'retired.json'));
        fs.renameSync(pendingFile, path.join(backup, 'receipt.json'));
      } catch (error) {
        try { recover(pendingFile, receiptFile, root, runtime); }
        catch { throw new Error('Removal interrupted; inspect status and use rollback --quiescent. Private backups retained.'); }
        throw error;
      }
      return { operation, restored: true, restartRequired: true, note: 'Settings, authentication, and private runtime backups retained.' };
    }
    const servers = config.value.mcp?.servers || {};
    if (!receipt && servers[managed]) throw new Error('Unowned prometheus-browser registration already exists');
    const old = servers[legacy];
    if (old && !migrate) throw new Error('Legacy server exists; use --migrate for explicit cutover');
    if (old && (old.type !== 'local' || old.command?.length !== 2 || path.resolve(old.command[1]) !== path.join(root, 'opencode-playwright-mcp.mjs') || old.environment?.CUDDLY_WINNER_CONFIG_DIR !== root)) {
      throw new Error('Unrecognized legacy registration; preserve it and reconcile manually');
    }
    if (!receipt && (config.value.commands?.browser || ['commands/browser.md', 'command/browser.md'].some(name => stat(path.join(root, name))))) throw new Error('Existing /browser command requires manual reconciliation');
    if (!receipt && stat(runtime)) throw new Error('Unowned runtime directory exists');
    privateDirectory(path.join(root, 'prometheus-sessions'));
    const plans = [];
    const add = (file, data, userData = false) => {
      safeRoot(path.dirname(file));
      const before = snapshot(file);
      if (before && userData && !Buffer.from(before.data, 'base64').equals(Buffer.from(data))) throw new Error(`Destination conflict: ${file}`);
      if (before && Buffer.from(before.data, 'base64').equals(Buffer.from(data))) {
        if (userData && before.mode !== 0o600) throw new Error(`Private file must have mode 0600: ${file}`);
        return;
      }
      plans.push({ file, data: Buffer.from(data), before, userData });
    };
    if (migrate && !receipt) {
      const settings = path.join(root, 'cuddly-winner-browser.json');
      if (regular(settings)) add(path.join(root, 'prometheus-browser.json'), fs.readFileSync(settings), true);
      const sessions = path.join(root, 'cuddly-winner-sessions');
      safeRoot(sessions);
      if (fs.existsSync(sessions)) for (const name of fs.readdirSync(sessions)) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(name)) throw new Error('Unexpected session storage entry');
        const file = path.join(sessions, name);
        regular(file);
        add(path.join(root, 'prometheus-sessions', name), fs.readFileSync(file), true);
      }
    }
    const configured = configuration(config, root, runtime, sourceRoot, receipt);
    const launchEnvironment = Object.fromEntries(Object.entries(configured.entry.environment).map(([key, value]) => [key, value.replace(/\{env:([^}]+)\}/g, (_, name) => process.env[name] || '')]));
    const environment = { ...process.env, ...launchEnvironment };
    const settings = plans.find(x => x.file === path.join(root, 'prometheus-browser.json'));
    const selected = settings ? validateBrowserConfig(JSON.parse(settings.data)) : browserConfigFromEnv(environment);
    if (selected.executionMode === 'virtual-display' && process.platform !== 'linux') throw new Error('virtual-display execution requires Linux and Xvfb');
    const desired = inventory.map(name => ({ name, data: payload(sourceRoot, name) }));
    if (receipt && desired.every(x => matches(path.join(runtime, x.name), hash(x.data))) && configured.text === config.text) {
      verify(runtime, selected, launchEnvironment);
      return { operation, unchanged: true };
    }
    add(config.file, configured.text);
    const backup = path.join(root, 'prometheus-browser-backups', crypto.randomUUID());
    safeRoot(backup);
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    const stage = path.join(root, `.prometheus-browser-stage-${path.basename(backup)}`);
    const next = { version: 2, root, backup, files: desired.map(x => ({ name: x.name, after: hash(x.data) })), config: configured.record };
    const pending = { ...next, stage, previous: receipt, writes: plans.map(({ data, ...item }) => ({ ...item, after: hash(data) })) };
    atomic(pendingFile, JSON.stringify(pending));
    let publishing = false;
    try {
      fs.mkdirSync(stage, { mode: 0o700 });
      for (const item of desired) atomic(path.join(stage, item.name), item.data);
      try { (prepare || (directory => execFileSync('npm', ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], { cwd: directory, stdio: 'pipe', timeout: 120000 })))(stage); }
      catch { throw new Error('Browser dependency preparation failed; no cutover was published'); }
      verify(stage, selected, launchEnvironment);
      for (const item of plans) if (!isDeepStrictEqual(snapshot(item.file), item.before)) throw new Error(`Concurrent change preserved: ${item.file}`);
      if (receipt && drift(receipt, configAt(root), runtime).length) throw new Error('Concurrent managed installation change preserved');
      if (!receipt && stat(runtime)) throw new Error('Concurrent unowned runtime directory preserved');
      publishing = true;
      if (stat(runtime)) fs.renameSync(runtime, path.join(backup, 'runtime'));
      fs.renameSync(stage, runtime);
      for (const item of plans) atomic(item.file, item.data);
      atomic(receiptFile, JSON.stringify(next));
      fs.renameSync(pendingFile, path.join(backup, 'receipt.json'));
    } catch (error) {
      try {
        if (publishing) recover(pendingFile, receiptFile, root, runtime);
        else {
          if (stat(stage)) fs.rmSync(stage, { recursive: true });
          fs.renameSync(pendingFile, path.join(backup, 'interrupted.json'));
        }
      }
      catch { throw new Error(`${error.message}. Recovery needs inspection; use status and rollback --quiescent. Private backups retained.`); }
      throw error;
    }
    return { operation, backup, restartRequired: true };
  } finally { unlock(); }
}

function payload(sourceRoot, name) {
  return fs.readFileSync(path.join(sourceRoot, files.includes(name) ? 'scripts' : '', name));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, ...args] = process.argv.slice(2);
  try {
    const options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--config-dir') {
        if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--config-dir requires a directory');
        options.root = args[++i];
      }
      else if (args[i] === '--migrate') options.migrate = true;
      else if (args[i] === '--quiescent') options.quiescent = true;
      else throw new Error(`Unknown argument: ${args[i]}`);
    }
    console.log(JSON.stringify(profile(operation, options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
