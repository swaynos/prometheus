#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse, modify, applyEdits } from 'jsonc-parser';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['state', 'runtime', 'service', 'login'].map(x => `opencode-browser-${x}.mjs`).concat('opencode-playwright-mcp.mjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function regular(file) {
  if (!fs.existsSync(file)) {
    try { fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular file: ${file}`);
  return true;
}
function safeRoot(root) {
  for (let here = root; ; here = path.dirname(here)) {
    if (fs.existsSync(here) && fs.lstatSync(here).isSymbolicLink()) throw new Error(`Symlinked directory: ${here}`);
    if (path.dirname(here) === here) break;
  }
}
function configAt(root) {
  const candidates = ['opencode.json', 'opencode.jsonc'].map(x => path.join(root, x)).filter(regular);
  if (candidates.length > 1) throw new Error('Both opencode.json and opencode.jsonc exist; resolve ambiguity first.');
  const file = candidates[0] || path.join(root, 'opencode.json');
  const text = regular(file) ? fs.readFileSync(file, 'utf8') : '{}\n';
  const errors = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid OpenCode configuration');
  if (value.mcp && (!value.mcp.servers || typeof value.mcp.servers !== 'object')) throw new Error('Expected V2 mcp.servers configuration');
  return { file, text, value };
}
function set(text, keys, value) {
  return applyEdits(text, modify(text, keys, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
}
function snapshot(file) {
  return regular(file) ? { data: fs.readFileSync(file).toString('base64'), mode: fs.statSync(file).mode & 0o777 } : null;
}
function atomic(file, data, mode = 0o600) {
  safeRoot(path.dirname(file));
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, data, { mode, flag: 'wx' }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

export function profile(operation, { root, migrate = false, quiescent = false, prepare } = {}) {
  root = path.resolve(root || path.join(os.homedir(), '.config/opencode'));
  safeRoot(root);
  const receiptFile = path.join(root, 'prometheus-browser-migration.json');
  if (operation === 'status') {
    const config = configAt(root);
    const receipt = regular(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile, 'utf8')) : undefined;
    return { configured: !!config.value.mcp?.servers?.['prometheus-browser'], legacyConfigured: !!config.value.mcp?.servers?.['cuddly-winner-browser'],
      drift: receipt ? receipt.changes.filter(x => !regular(x.file) || hash(fs.readFileSync(x.file)) !== x.after).map(x => x.file) : [], receipt: !!receipt };
  }
  if (!quiescent) throw new Error('Stop browser tasks, login helpers, and affected OpenCode servers first; then pass --quiescent. This is an explicit operator assertion, not automatic process detection.');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = path.join(root, '.prometheus-browser-migration.lock');
  const fd = fs.openSync(lock, 'wx', 0o600);
  try {
    if (operation === 'rollback' || operation === 'remove') {
      if (!regular(receiptFile)) throw new Error('No migration receipt exists');
      const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
      if (receipt.root !== root) throw new Error('Receipt belongs to another configuration root');
      for (const item of receipt.changes) {
        if (!item.file.startsWith(`${root}${path.sep}`)) throw new Error('Unsafe receipt path');
        safeRoot(path.dirname(item.file));
        if (!regular(item.file) || hash(fs.readFileSync(item.file)) !== item.after) throw new Error(`Modified file preserved: ${item.file}`);
      }
      // Remove retains copied authentication/settings. Rollback restores all prior bytes.
      for (const item of [...receipt.changes].reverse()) {
        if (operation === 'remove' && item.userData) continue;
        if (item.before) atomic(item.file, Buffer.from(item.before.data, 'base64'), item.before.mode);
        else fs.unlinkSync(item.file);
      }
      fs.renameSync(receiptFile, `${receiptFile}.${Date.now()}.retired`);
      return { operation, restored: true, note: 'Private backups and installed dependency directory retained.' };
    }
    if (operation !== 'install') throw new Error('Expected install, status, remove, or rollback');
    if (regular(receiptFile)) {
      const status = profile('status', { root });
      if (status.drift.length || !status.configured) throw new Error('Existing installation has drift; inspect before changing it');
      return { operation, unchanged: true };
    }
    const config = configAt(root);
    const servers = config.value.mcp?.servers || {};
    if (servers['prometheus-browser']) throw new Error('Unowned prometheus-browser registration already exists');
    const old = servers['cuddly-winner-browser'];
    if (old && !migrate) throw new Error('Legacy server exists; use --migrate for explicit cutover');
    if (old && (old.type !== 'local' || old.command?.length !== 2 || path.resolve(old.command[1]) !== path.join(root, 'opencode-playwright-mcp.mjs') || old.environment?.CUDDLY_WINNER_CONFIG_DIR !== root)) {
      throw new Error('Unrecognized legacy registration; preserve it and reconcile manually');
    }
    const plans = [];
    const add = (file, data, userData = false) => {
      safeRoot(path.dirname(file));
      const before = snapshot(file);
      if (before && userData && !Buffer.from(before.data, 'base64').equals(Buffer.from(data))) throw new Error(`Destination conflict: ${file}`);
      if (before && Buffer.from(before.data, 'base64').equals(Buffer.from(data))) return;
      plans.push({ file, data: Buffer.from(data), before, userData });
    };
    const runtime = path.join(root, 'prometheus-browser');
    if (fs.existsSync(runtime)) throw new Error('Unowned runtime directory exists');
    if (migrate) {
      const login = path.join(root, 'cuddly-winner-logins');
      safeRoot(login);
      if (fs.existsSync(login) && fs.readdirSync(login).length) throw new Error('Legacy login coordination records exist; inspect and finish/cancel handoffs first');
      const settings = path.join(root, 'cuddly-winner-browser.json');
      if (regular(settings)) add(path.join(root, 'prometheus-browser.json'), fs.readFileSync(settings), true);
      const sessions = path.join(root, 'cuddly-winner-sessions');
      safeRoot(sessions);
      if (fs.existsSync(sessions)) for (const name of fs.readdirSync(sessions)) {
        if (!name.endsWith('.json')) throw new Error('Unexpected session storage entry');
        const file = path.join(sessions, name);
        regular(file);
        add(path.join(root, 'prometheus-sessions', name), fs.readFileSync(file), true);
      }
    }
    for (const file of files) add(path.join(runtime, file), fs.readFileSync(path.join(source, 'scripts', file)));
    add(path.join(runtime, 'resource-selection.md'), fs.readFileSync(path.join(source, 'rules/resource-selection.md'), 'utf8').replace('../docs/RESOURCE-SELECTION.md', './RESOURCE-SELECTION.md'));
    add(path.join(runtime, 'RESOURCE-SELECTION.md'), fs.readFileSync(path.join(source, 'docs/RESOURCE-SELECTION.md')));
    let text = config.text;
    const entry = { ...(old || {}), type: 'local', command: [old?.command?.[0] || process.execPath, path.join(runtime, 'opencode-playwright-mcp.mjs')],
      environment: Object.fromEntries(Object.entries(old?.environment || {}).map(([key, value]) => [key.replace(/^CUDDLY_WINNER_/, 'PROMETHEUS_'), value])), codemode: old?.codemode ?? false };
    entry.environment.PROMETHEUS_CONFIG_DIR = root;
    delete entry.enabled;
    if (old?.enabled === false) entry.disabled = true;
    text = set(text, ['mcp', 'servers', 'prometheus-browser'], entry);
    if (old) text = set(text, ['mcp', 'servers', 'cuddly-winner-browser'], undefined);
    // Change permission action patterns, including agent-local rules, without changing other text.
    function permissions(value, keys = []) {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        const next = [...keys, Array.isArray(value) ? Number(key) : key];
        if (key === 'action' && typeof child === 'string' && child.startsWith('cuddly-winner-browser_')) text = set(text, next, child.replace('cuddly-winner-browser_', 'prometheus-browser_'));
        else permissions(child, next);
      }
    }
    permissions(config.value);
    const oldRule = path.join(root, 'rules/resource-selection.md');
    const instructions = config.value.instructions || [];
    if (!Array.isArray(instructions)) throw new Error('Expected instructions array');
    const rule = path.join(runtime, 'resource-selection.md');
    // Preserve custom instructions; only retire the exact known legacy rule.
    const legacyRule = fs.readFileSync(path.join(source, 'rules/resource-selection.md'), 'utf8').replaceAll('prometheus', 'cuddly-winner');
    const ownedRule = regular(oldRule) && fs.readFileSync(oldRule, 'utf8') === legacyRule;
    if (instructions.includes(oldRule) && !ownedRule) throw new Error('Custom legacy resource rule requires manual reconciliation');
    text = set(text, ['instructions'], [...instructions.filter(x => !ownedRule || x !== oldRule), rule]);
    add(config.file, text);
    const backup = path.join(root, 'prometheus-browser-backups', crypto.randomUUID());
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    const receipt = { root, backup, changes: plans.map(({ data, ...item }) => ({ ...item, after: hash(data) })) };
    atomic(path.join(backup, 'receipt.json'), JSON.stringify(receipt));
    // Prepare dependencies before publishing the registration. Failed preparation leaves no cutover.
    fs.mkdirSync(runtime, { mode: 0o700 });
    for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(source, name), path.join(runtime, name));
    (prepare || (() => execFileSync('npm', ['ci', '--ignore-scripts', '--omit=dev'], { cwd: runtime, stdio: 'pipe' })))();
    const written = [];
    try {
      for (const item of plans) { atomic(item.file, item.data); written.push(item); }
      atomic(receiptFile, JSON.stringify(receipt));
    } catch (error) {
      for (const item of written.reverse()) {
        if (item.before) atomic(item.file, Buffer.from(item.before.data, 'base64'), item.before.mode);
        else fs.unlinkSync(item.file);
      }
      throw error;
    }
    return { operation, backup, restartRequired: true };
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, ...args] = process.argv.slice(2);
  try {
    const options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--config-dir') options.root = args[++i];
      else if (args[i] === '--migrate') options.migrate = true;
      else if (args[i] === '--quiescent') options.quiescent = true;
      else throw new Error(`Unknown argument: ${args[i]}`);
    }
    console.log(JSON.stringify(profile(operation, options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
