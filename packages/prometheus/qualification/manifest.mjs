import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, hash, inside, requireThat } from '../src/util.mjs';
import { workflows } from './scenarios.mjs';

export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const namePattern = /^[a-zA-Z0-9_-]+$/;
const states = ['Unenrolled', 'Draft', 'Working', 'Verifying', 'Paused', 'Accepted'];
const operations = ['prompt', 'command', 'agent', 'wait', 'check', 'interrupt', 'permission', 'answer', 'human', 'mutate'];
const comparisons = ['equals', 'contains', 'min', 'max', 'exists', 'sameAs'];
const positive = value => Number.isSafeInteger(value) && value > 0;
const text = value => typeof value === 'string' && value.trim();
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

// Unlike product capture, admission must not silently exclude configuration or credentials.
export function tree(directory, { fixture = false } = {}) {
  directory = canonical(directory);
  requireThat(fs.statSync(directory).isDirectory(), 'An asset must be a directory.');
  const files = [];
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = path.join(relative, entry.name);
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      requireThat(!stat.isSymbolicLink(), `Qualification assets cannot contain symlinks: ${name}`);
      if (fixture) requireThat(!['.git', '.opencode', 'node_modules', 'opencode.json', 'opencode.jsonc'].includes(entry.name) &&
        !/^\.env(?:\.|$)/.test(entry.name), `A qualification fixture contains private or ambient configuration: ${name}`);
      if (stat.isDirectory()) { files.push({ path: name, type: 'directory' }); visit(name); }
      else {
        requireThat(stat.isFile() && stat.nlink === 1, `Unsupported qualification asset: ${name}`);
        files.push({ path: name, type: 'file', bytes: stat.size, executable: !!(stat.mode & 0o111), hash: hash(fs.readFileSync(file)) });
      }
    }
  }
  visit('');
  return { directory, id: hash(files), files };
}

function checksContract(checks) {
  requireThat(Array.isArray(checks) && checks.length, 'A checkpoint needs explicit checks.');
  for (const check of checks) {
    requireThat(plain(check) && text(check.path) && !check.path.split('.').some(p => ['__proto__', 'prototype', 'constructor'].includes(p)), 'Use a safe checkpoint path.');
    const keys = comparisons.filter(key => Object.hasOwn(check, key));
    requireThat(keys.length === 1 && Object.keys(check).every(key => key === 'path' || comparisons.includes(key)), 'Each check needs exactly one comparison.');
    if (keys[0] === 'min' || keys[0] === 'max') requireThat(Number.isFinite(check[keys[0]]), 'A check bound must be finite.');
    if (keys[0] === 'exists') requireThat(typeof check.exists === 'boolean', 'An existence check must be boolean.');
    if (keys[0] === 'sameAs') requireThat(text(check.sameAs), 'A sameAs check needs another snapshot path.');
  }
}

function stepsContract(steps) {
  requireThat(Array.isArray(steps) && steps.length, 'Declare scenario steps.');
  for (const step of steps) {
    requireThat(plain(step) && operations.includes(step.type), 'Unknown qualification step.');
    const fields = { prompt: ['text', 'resume'], command: ['name', 'text'], agent: ['agent'], wait: ['checks', 'idle', 'stableMs', 'save'],
      check: ['checks', 'save'], interrupt: [], permission: ['action', 'resources', 'decision'], answer: ['title', 'answer'],
      human: ['request', 'instructions', 'action', 'resources', 'title'], mutate: ['path', 'content', 'reason'] };
    requireThat(Object.keys(step).every(key => ['type', 'target', 'participation', 'timeoutMs', ...fields[step.type]].includes(key)), 'A qualification step contains an unknown or ignored field.');
    if (step.timeoutMs !== undefined) requireThat(positive(step.timeoutMs), 'Use a positive step timeout.');
    if (step.target !== undefined) requireThat(['origin', 'worker', 'evaluator'].includes(step.target), 'Unknown session target.');
    if (step.participation !== undefined) requireThat(['stimulus', 'decision', 'rescue'].includes(step.participation), 'Unknown participation class.');
    if (step.save !== undefined) requireThat(namePattern.test(step.save), 'Use a safe checkpoint name.');
    if (step.type === 'prompt') requireThat(text(step.text) && (step.resume === undefined || typeof step.resume === 'boolean'), 'A prompt needs text and an optional boolean resume flag.');
    if (step.type === 'command') requireThat(['goal', 'spike', 'grill-me'].includes(step.name) && (step.text === undefined || typeof step.text === 'string'), 'Use a supported Prometheus command.');
    if (step.type === 'agent') requireThat(['plan', 'build'].includes(step.agent), 'Choose Plan or Build.');
    if (step.type === 'wait' || step.type === 'check') {
      if (step.checks) checksContract(step.checks);
      requireThat(step.checks || step.type === 'wait' && step.idle === true, 'A wait needs checks or an explicit idle condition.');
      if (step.stableMs !== undefined) requireThat(Number.isSafeInteger(step.stableMs) && step.stableMs >= 0, 'Invalid stability duration.');
      if (step.idle !== undefined) requireThat(typeof step.idle === 'boolean', 'An idle checkpoint must be boolean.');
    }
    if (step.type === 'permission') requireThat(text(step.action) && Array.isArray(step.resources) && step.resources.every(text) &&
      ['once', 'reject'].includes(step.decision), 'Match the exact permission action and resources. Only once or reject is allowed.');
    if (step.type === 'answer') requireThat(text(step.title) && plain(step.answer), 'Match a form title and declare its answer.');
    if (step.type === 'human') {
      requireThat(['form', 'permission'].includes(step.request) && text(step.instructions), 'A declared human response needs its request kind and participant instructions.');
      if (step.request === 'permission') requireThat(text(step.action), 'A human permission step needs the expected action.');
      if (step.resources !== undefined) requireThat(Array.isArray(step.resources) && step.resources.every(text), 'Invalid human permission resources.');
      if (step.title !== undefined) requireThat(text(step.title), 'Invalid human form title.');
    }
    if (step.type === 'mutate') requireThat(text(step.path) && !path.isAbsolute(step.path) && !step.path.split(/[\\/]/).includes('..') &&
      typeof step.content === 'string' && text(step.reason), 'A test mutation needs an owned relative file, content, and reason.');
  }
}

function normalize(input) {
  requireThat(input.version === undefined || input.version === 2, 'Unsupported qualification manifest version.');
  requireThat(text(input.model?.providerID) && text(input.model?.id) && !JSON.stringify(input.model).includes('CHOOSE_'), 'Choose an explicit provider and model.');
  requireThat(Object.keys(input.model).every(key => ['providerID', 'id', 'variant'].includes(key)) &&
    (input.model.variant === undefined || text(input.model.variant)), 'A model selection contains unsupported fields.');
  requireThat(positive(input.maxRequests), 'Choose an aggregate model-request allowance.');
  requireThat(positive(input.timeoutMs), 'Choose an aggregate duration in milliseconds.');
  if (input.maxUSD !== undefined) requireThat(Number.isFinite(input.maxUSD) && input.maxUSD > 0, 'Use a positive cost estimate limit.');
  requireThat(input.evidenceClass === undefined || ['real-model', 'scripted-native'].includes(input.evidenceClass), 'Declare real-model or scripted-native evidence.');
  requireThat(Array.isArray(input.cases) && input.cases.length, 'Declare qualification cases.');
  const cases = input.cases.map(item => {
    requireThat(text(item.name) && namePattern.test(item.name), 'Use safe case names.');
    requireThat(text(item.fixture), 'Each case needs a fixture directory.');
    const arm = item.arm ?? 'prometheus';
    requireThat(['prometheus', 'build'].includes(arm), 'Choose the Prometheus or ordinary-Build arm.');
    const agent = item.agent ?? 'build';
    requireThat(['plan', 'build'].includes(agent), 'Choose Plan or Build.');
    const maxRequests = item.maxRequests ?? input.maxRequests;
    requireThat(positive(maxRequests) && maxRequests <= input.maxRequests, 'A case cannot enlarge the campaign allowance.');
    const timeoutMs = item.timeoutMs ?? input.timeoutMs;
    requireThat(positive(timeoutMs) && timeoutMs <= input.timeoutMs, 'A case cannot enlarge the campaign duration.');
    const permissions = item.permissions ?? [];
    requireThat(Array.isArray(permissions) && permissions.every(p => text(p.action) && text(p.resource) && ['allow', 'deny', 'ask'].includes(p.effect)), 'Invalid native permission rules.');
    const steps = item.steps ?? [
      { type: 'prompt', text: item.prompt, resume: arm === 'build' },
      ...(arm === 'prometheus' ? [{ type: 'command', name: 'goal' }, { type: 'wait', checks: [{ path: 'state', equals: 'Accepted' }] }] : [{ type: 'wait', idle: true }]),
    ];
    stepsContract(steps);
    requireThat(arm !== 'build' || steps.every(s => s.type !== 'command'), 'An ordinary-Build comparison cannot invoke Prometheus commands.');
    const expectedStates = item.expect?.states ?? (arm === 'build' ? ['Unenrolled'] : ['Accepted']);
    requireThat(Array.isArray(expectedStates) && expectedStates.length && expectedStates.every(s => states.includes(s)), 'Declare valid expected states.');
    if (item.expect?.checks) checksContract(item.expect.checks);
    if (item.expect?.completionClaim) checksContract(item.expect.completionClaim);
    const observeFiles = item.observeFiles ?? [];
    requireThat(Array.isArray(observeFiles) && observeFiles.every(p => text(p) && !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..')), 'Observe only declared workspace files.');
    const scenarios = item.scenarios ?? [];
    requireThat(Array.isArray(scenarios) && scenarios.every(id => workflows.some(w => w.id === id)), 'Use known workflow scenario identities.');
    if (item.candidateFault) requireThat(arm === 'prometheus' && plain(item.candidateFault) &&
      Object.keys(item.candidateFault).every(key => ['path', 'content', 'reason'].includes(key)) &&
      text(item.candidateFault.path) && !path.isAbsolute(item.candidateFault.path) &&
      !item.candidateFault.path.split(/[\\/]/).some(p => ['..', '.git', '.opencode', 'SPEC.md', 'AGENTS.md', 'opencode.json', 'opencode.jsonc'].includes(p)) &&
      !item.candidateFault.path.split(/[\\/]/).some(p => /^\.env(?:\.|$)/.test(p)) &&
      typeof item.candidateFault.content === 'string' && text(item.candidateFault.reason), 'A candidate fault needs one owned product file, content, and a reason.');
    requireThat(Array.isArray(item.oracles) && item.oracles.length && item.oracles.every(a => Array.isArray(a) && a.length && a.every(v => typeof v === 'string' && !v.includes('\0')) && text(a[0])), 'Each case needs independent executable checks.');
    const failureCodes = item.failureCodes ?? [1];
    requireThat(Array.isArray(failureCodes) && failureCodes.length && failureCodes.every(code => positive(code) && code <= 255), 'Declare nonzero product-failure exit codes.');
    if (item.pair !== undefined) requireThat(namePattern.test(item.pair) && text(item.agreement), 'A comparison pair needs a name and the shared agreement.');
    const readiness = item.readiness ?? [];
    requireThat(Array.isArray(readiness) && readiness.every(r => text(r.fixture) && Number.isInteger(r.exitCode) && r.exitCode >= 0), 'Readiness examples need a fixture and expected exit code.');
    const references = item.references ?? {};
    requireThat(plain(references) && Object.entries(references).every(([key, value]) => namePattern.test(key) && key !== 'baseline' && text(value)), 'Use named reference fixture directories.');
    for (const argv of item.oracles) for (const argument of argv) for (const match of argument.matchAll(/\{reference:([^}]+)\}/g))
      requireThat(Object.hasOwn(references, match[1]), 'An independent check names an absent reference fixture.');
    return { ...item, arm, agent, maxRequests, timeoutMs, permissions, steps, readiness, observeFiles, scenarios, references, failureCodes, expect: { ...item.expect, states: expectedStates } };
  });
  requireThat(new Set(cases.map(c => c.name)).size === cases.length, 'Case names must be unique.');
  return { ...input, version: 2, evidenceClass: input.evidenceClass ?? 'real-model', cases };
}

export function loadManifest(file, { runtimeRoot = packageRoot } = {}) {
  file = canonical(file);
  const bytes = fs.readFileSync(file);
  const input = normalize(JSON.parse(bytes));
  const assets = [];
  function asset(directory, fixture = true) {
    const snapshot = tree(canonical(path.resolve(path.dirname(file), directory)), { fixture });
    assets.push(snapshot);
    return snapshot;
  }
  const cases = input.cases.map(item => ({ ...item, fixtureAsset: asset(item.fixture), oracleAsset: asset(item.oracleFixture ?? item.fixture),
    referenceAssets: Object.fromEntries(Object.entries(item.references).map(([key, directory]) => [key, asset(directory)])),
    readiness: item.readiness.map(example => ({ ...example, asset: asset(example.fixture) })) }));
  const runtime = runtimeIdentity(runtimeRoot);
  let previous;
  if (input.previousCampaign !== undefined) {
    requireThat(text(input.previousCampaign), 'Identify the previous campaign output directory.');
    const reportFile = canonical(path.resolve(path.dirname(file), input.previousCampaign, 'report.json'));
    const reportBytes = fs.readFileSync(reportFile);
    const report = JSON.parse(reportBytes);
    requireThat(report.finished && ['Paused', 'Finished'].includes(report.usage?.campaign?.state) &&
      report.cases.every(c => !c.sessionID || c.stop?.confirmed), 'The previous campaign has unconfirmed activity. Inspect and stop it before another attempt.');
    requireThat(!report.cases.some(c => c.snapshot?.counts.uncertainActions > 0 || c.uncertainActions?.length || c.uncertainDispatches?.length),
      'Reconcile the previous campaign unknown effects before another attempt.');
    requireThat(!report.usage.faults?.some(fault => fault.state !== 'applied'), 'The previous controlled fault has an unknown outcome. Do not replay it.');
    requireThat(Number.isSafeInteger(report.requests) && report.requests >= 0 && report.requests === report.usage.campaign.requests &&
      Number.isFinite(report.observedCostUSD) && report.observedCostUSD >= 0, 'The previous campaign usage is not established.');
    requireThat(hash(report.source) === report.fingerprint, 'The previous campaign source identity is inconsistent.');
    const elapsedMs = report.activeElapsedMs ?? report.finished - report.started;
    requireThat(Number.isSafeInteger(elapsedMs) && elapsedMs >= 0, 'The previous campaign duration is not established.');
    previous = { reportFile, reportSHA256: hash(reportBytes), fingerprint: report.fingerprint,
      requests: report.requests, observedCostUSD: report.observedCostUSD, elapsedMs };
    requireThat(input.maxRequests > previous.requests && input.timeoutMs > previous.elapsedMs,
      'The total allowance must exceed previously consumed and uncertain requests and elapsed qualification time.');
    requireThat(!input.maxUSD || input.maxUSD > previous.observedCostUSD, 'The cost estimate limit has no remaining allowance.');
  }
  const binding = { manifestSHA256: hash(bytes), runtime, assets: assets.map(a => ({ directory: a.directory, id: a.id, files: a.files })), ...(previous ? { previous } : {}) };
  const fingerprint = hash(binding);
  for (const pair of new Set(cases.map(c => c.pair).filter(Boolean))) {
    const group = cases.filter(c => c.pair === pair);
    requireThat(group.length === 2 && new Set(group.map(c => c.arm)).size === 2, `Comparison ${pair} needs one case per arm.`);
    requireThat(group.every(c => !c.candidateFault && c.steps.every(step => step.type !== 'mutate')),
      'Run controlled faults separately from performance comparisons.');
    requireThat(cases.indexOf(group[1]) === cases.indexOf(group[0]) + 1, 'Comparison arms must be adjacent to reserve their request allowances.');
    requireThat(group.every(c => c.steps.find(s => s.type === 'prompt')?.text === c.agreement), `Comparison ${pair} must deliver the same declared agreement to both arms.`);
    requireThat(group.every(c => ['execution', 'discovery'].includes(c.comparison ?? 'execution')), 'Unknown comparison kind.');
    requireThat(group[0].agent === group[1].agent && (group[0].comparison ?? 'execution') === (group[1].comparison ?? 'execution'), 'Comparison arms must start in the same mode and declare the same comparison kind.');
    const identity = c => hash({ fixture: c.fixtureAsset.id, oracle: c.oracleAsset.id, oracles: c.oracles, agreement: c.agreement,
      references: Object.fromEntries(Object.entries(c.referenceAssets).map(([key, asset]) => [key, asset.id])),
      failureCodes: c.failureCodes, permissions: c.permissions, maxRequests: c.maxRequests, timeoutMs: c.timeoutMs });
    requireThat(identity(group[0]) === identity(group[1]), `Comparison ${pair} must share fixtures, checks, agreement, authority, and request allowance.`);
  }
  return { input: { ...input, cases }, bytes, file, runtimeRoot: canonical(runtimeRoot), fingerprint, binding, previous };
}

export function runtimeIdentity(runtimeRoot) {
  const files = [];
  for (const name of ['index.mjs', 'package.json', 'package-lock.json', 'LICENSE', 'README.md']) {
    const source = path.join(runtimeRoot, name);
    files.push({ path: name, hash: hash(fs.readFileSync(source)) });
  }
  for (const name of ['src', 'qualification']) {
    for (const record of tree(path.join(runtimeRoot, name)).files) files.push({ ...record, path: `${name}/${record.path}` });
  }
  return { id: hash(files), files };
}

export function installRuntime(admission, destination) {
  requireThat(!fs.existsSync(destination), 'A qualification runtime needs a fresh installation path.');
  fs.mkdirSync(destination, { mode: 0o700 });
  for (const record of admission.binding.runtime.files) {
    const target = path.join(destination, record.path);
    if (record.type === 'directory') fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    else {
      const bytes = fs.readFileSync(path.join(admission.runtimeRoot, record.path));
      requireThat(hash(bytes) === record.hash, 'The approved runtime changed during installation.', 'admission_changed');
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, bytes, { flag: 'wx', mode: record.executable ? 0o500 : 0o400 });
    }
  }
  // Reuse pinned dependencies, never mutable controller source. No install scripts run.
  const dependencies = canonical(path.join(admission.runtimeRoot, 'node_modules'));
  requireThat(fs.statSync(dependencies).isDirectory(), 'Install the pinned package dependencies before qualification.');
  fs.symlinkSync(dependencies, path.join(destination, 'node_modules'), 'dir');
  requireThat(runtimeIdentity(destination).id === admission.binding.runtime.id, 'The campaign installation differs from the approved runtime.');
  return canonical(destination);
}

export function verifyAdmission(admission) {
  const current = loadManifest(admission.file, { runtimeRoot: admission.runtimeRoot });
  requireThat(current.fingerprint === admission.fingerprint, 'The manifest, runtime, fixtures, or independent checks changed after approval.', 'admission_changed');
}

export function copyAsset(asset, destination, { writable = false } = {}) {
  requireThat(!inside(asset.directory, canonical(destination)) && !inside(canonical(destination), asset.directory), 'Keep qualification copies separate from their sources.');
  requireThat(tree(asset.directory, { fixture: true }).id === asset.id, 'An approved asset changed before copying.', 'admission_changed');
  fs.mkdirSync(destination, { mode: 0o700 });
  for (const entry of asset.files) {
    const target = path.join(destination, entry.path);
    if (entry.type === 'directory') fs.mkdirSync(target, { mode: 0o700 });
    else {
      const bytes = fs.readFileSync(path.join(asset.directory, entry.path));
      requireThat(hash(bytes) === entry.hash, 'An approved asset changed during copying.', 'admission_changed');
      fs.writeFileSync(target, bytes, { flag: 'wx', mode: entry.executable ? writable ? 0o700 : 0o500 : writable ? 0o600 : 0o400 });
    }
  }
  requireThat(tree(destination).id === asset.id && tree(asset.directory, { fixture: true }).id === asset.id, 'An approved asset changed during copying.', 'admission_changed');
}
