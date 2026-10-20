import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyAsset, installRuntime, loadManifest, tree, verifyAdmission } from '../qualification/manifest.mjs';
import { compare, Ledger } from '../qualification/ledger.mjs';
import { runCampaign } from '../qualification/driver.mjs';
import { nativeFileBoundary, nativeShellBoundary } from '../qualification/boundary.mjs';
import { Store } from '../src/store.mjs';
import { hash } from '../src/util.mjs';
import { preflight } from '../qualification/preflight.mjs';
import { Runner, sandboxAvailable } from '../src/sandbox.mjs';

const exec = promisify(execFile);
const runtimeRoot = path.resolve(import.meta.dirname, '..');
async function setup(t, overrides = {}) {
  const temp = path.join(fs.realpathSync(os.tmpdir()), 'opencode');
  fs.mkdirSync(temp, { recursive: true, mode: 0o700 });
  const base = fs.mkdtempSync(path.join(temp, 'prometheus-qualification-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const fixture = path.join(base, 'fixture');
  fs.mkdirSync(fixture, { mode: 0o700 });
  fs.writeFileSync(path.join(fixture, 'greeting.txt'), 'wrong');
  fs.writeFileSync(path.join(fixture, 'check.mjs'), 'Independent fixture.');
  const file = path.join(base, 'manifest.json');
  const input = { version: 2, evidenceClass: 'scripted-native', model: { providerID: 'fixture', id: 'fixture' }, maxRequests: 20, timeoutMs: 30000,
    cases: [{ name: 'ordinary', arm: 'build', fixture: 'fixture', prompt: 'Write hello. End with Implementation complete.',
      oracles: [['node', '{oracle}/check.mjs']], expect: { completionClaim: [{ path: 'native.lastAssistantText', contains: 'Implementation complete.' }] } }], ...overrides };
  fs.writeFileSync(file, JSON.stringify(input));
  return { base, fixture, file, input, admission: loadManifest(file), output: path.join(base, 'output') };
}

class ScriptedClient {
  constructor({ wrong = false, unexpected = false, failure = false } = {}) {
    this.wrong = wrong; this.unexpected = unexpected; this.failure = failure; this.sessions = new Map(); this.ledgers = new Set(); this.calls = [];
    this.server = { info: async () => ({ version: '2.0.29' }) };
    this.model = { list: async () => ({ data: [...this.sessions.values()].map(s => s.model) }) };
    this.session = {
      create: async input => {
        const root = input.location.directory;
        const config = JSON.parse(fs.readFileSync(path.join(root, 'opencode.json')));
        const options = config.plugins.find(p => p.package.endsWith('/meter')).options;
        const ledger = new Ledger(options.directory);
        this.ledgers.add(ledger);
        const session = { id: `ses_fixture_${this.sessions.size}`, projectID: `project_${this.sessions.size}`, location: { directory: root }, cost: 0, agent: input.agent,
          model: input.model, messages: [], ledger, options, config };
        this.sessions.set(session.id, session);
        ledger.session(options.caseID, session);
        return session;
      },
      get: async ({ sessionID }) => this.sessions.get(sessionID),
      active: async () => ({}),
      context: async ({ sessionID }) => this.sessions.get(sessionID).messages,
      prompt: async input => {
        const session = this.sessions.get(input.sessionID);
        session.messages.push({ type: 'user', id: input.id, text: input.text });
        session.ledger.event(session.options.caseID, 'prompt_admitted', { sessionID: input.sessionID, messageID: input.id, textHash: hash(input.text) });
        if (input.resume !== false) {
          session.ledger.reserve(session.options.caseID, { sessionID: input.sessionID, kind: 'primary', model: session.model });
          session.cost += 0.01;
          if (this.failure) throw new Error('Lost model transport.');
          fs.writeFileSync(path.join(session.location.directory, 'greeting.txt'), this.wrong ? 'wrong' : 'hello');
          session.messages.push({ type: 'assistant', text: 'Implementation complete.' });
          if (this.unexpected) session.messages.push({ id: 'msg_manual', type: 'user', text: 'I repaired it manually.' });
          session.outcome = 'succeeded';
        }
        return { id: input.id };
      },
      command: async ({ sessionID, name }) => {
        const session = this.sessions.get(sessionID);
        const options = session.config.plugins.find(p => p.options.stateDirectory).options;
        const store = new Store(path.join(options.stateDirectory, hash(session.projectID)));
        const messageID = `msg_command_${session.messages.length}`;
        session.messages.push({ type: 'user', id: messageID, text: '/goal' });
        session.ledger.event(session.options.caseID, 'prompt_admitted', { sessionID, messageID });
        const task = store.put('task', { id: 'task', origin: sessionID, root: session.location.directory, requests: 0, decisions: [], findings: [] }, 'created');
        store.put('session', { id: sessionID, taskID: task.id, role: 'origin' }, 'enrolled');
        store.update('task', task.id, () => ({}), 'user_instruction', { command: name, messageID });
        session.ledger.reserve(session.options.caseID, { sessionID, kind: 'primary', model: session.model });
        store.close();
      },
      switchAgent: async ({ sessionID, agent }) => { this.sessions.get(sessionID).agent = agent; },
      interrupt: async ({ sessionID }) => { this.calls.push(['interrupt', sessionID]); },
      wait: async () => {},
    };
    this.plugin = { list: async ({ location }) => {
      const config = JSON.parse(fs.readFileSync(path.join(location.directory, 'opencode.json')));
      return { data: config.plugins.map(p => ({ id: p.package.endsWith('/meter') ? 'prometheus-qualification-meter' : 'prometheus',
        source: { type: 'local', path: path.join(p.package, 'index.mjs') }, state: { status: 'active' } })) };
    } };
    this.command = { list: async () => ({ data: [
      { name: 'spike', description: 'Investigate technical unknowns.' }, { name: 'grill-me', description: 'Resolve consequential user decisions.' },
      { name: 'goal', description: 'Infer the goal from this conversation. Prepare in Plan. Execute in Build.' },
    ] }) };
    this.message = { list: async ({ sessionID }) => ({ data: this.sessions.get(sessionID).messages, cursor: {} }) };
  }
  close() { for (const ledger of this.ledgers) ledger.close(); }
}
const makeRunner = () => ({ run: async ({ cwd, argv }) => ({ code: fs.readFileSync(path.join(cwd, 'greeting.txt'), 'utf8') === 'hello' ? 0 : 1,
  interrupted: false, output: '', argv }) });

test('approval binds fixture bytes and independent check bytes', async t => {
  const f = await setup(t);
  verifyAdmission(f.admission);
  fs.writeFileSync(path.join(f.fixture, 'greeting.txt'), 'changed');
  assert.throws(() => verifyAdmission(f.admission), /changed after approval/);
  const changed = loadManifest(f.file);
  assert.notEqual(changed.fingerprint, f.admission.fingerprint);
  fs.writeFileSync(path.join(f.fixture, 'check.mjs'), 'Weakened check.');
  assert.notEqual(loadManifest(f.file).fingerprint, changed.fingerprint);
});

test('admission rejects fixture credentials, ambient configuration, and symlinks', async t => {
  const f = await setup(t);
  for (const name of ['.env', 'opencode.json', '.opencode']) {
    fs.writeFileSync(path.join(f.fixture, name), 'not permitted');
    assert.throws(() => loadManifest(f.file), /private or ambient/);
    fs.unlinkSync(path.join(f.fixture, name));
  }
  fs.symlinkSync('greeting.txt', path.join(f.fixture, 'alias'));
  assert.throws(() => loadManifest(f.file), /symlinks/);
});

test('paired comparisons require equal inputs, authority, checks, and allowances', async t => {
  const f = await setup(t);
  const common = { fixture: 'fixture', agreement: 'Write hello.', prompt: 'Write hello.', pair: 'greeting', maxRequests: 5, timeoutMs: 5000, oracles: [['node', '{oracle}/check.mjs']] };
  const input = { ...f.input, cases: [{ ...common, name: 'prometheus' }, { ...common, name: 'build', arm: 'build' }] };
  fs.writeFileSync(f.file, JSON.stringify(input));
  assert.equal(loadManifest(f.file).input.cases.length, 2);
  input.cases[1].maxRequests = 6;
  fs.writeFileSync(f.file, JSON.stringify(input));
  assert.throws(() => loadManifest(f.file), /must share/);
});

test('invalid steps, vague permission grants, and ordinary-Build commands fail admission', async t => {
  const f = await setup(t);
  for (const steps of [[{ type: 'unknown' }], [{ type: 'check' }], [{ type: 'permission', action: 'shell', resources: ['*'], decision: 'always' }],
    [{ type: 'command', name: 'goal' }], [{ type: 'mutate', path: '../outside', content: 'x', reason: 'A fault.' }]]) {
    fs.writeFileSync(f.file, JSON.stringify({ ...f.input, cases: [{ ...f.input.cases[0], steps }] }));
    assert.throws(() => loadManifest(f.file));
  }
});

test('checkpoints distinguish missing values and support saved identities and file paths', () => {
  const snapshot = { workerID: 'same', count: 2, checkpoints: { started: { workerID: 'same' } }, files: { 'greeting.txt': { text: 'hello' } } };
  assert.ok(compare([{ path: 'workerID', sameAs: 'checkpoints.started.workerID' }, { path: '/files/greeting.txt/text', equals: 'hello' }, { path: 'count', min: 1 }], snapshot).every(c => c.pass));
  assert.equal(compare([{ path: 'missing', equals: null }], snapshot)[0].pass, false);
  assert.equal(compare([{ path: 'missing', sameAs: 'alsoMissing' }], snapshot)[0].pass, false);
  assert.equal(compare([{ path: 'count', contains: 2 }], snapshot)[0].pass, false);
});

test('campaign request reservations share one durable allowance across sessions and connections', async t => {
  const f = await setup(t, { maxRequests: 3 });
  const directory = path.join(f.base, 'ledger');
  const first = new Ledger(directory); const second = new Ledger(directory);
  t.after(() => { first.close(); second.close(); });
  first.initialize(f.admission);
  first.beginCase({ name: 'a', arm: 'build', maxRequests: 3 }, f.fixture);
  first.beginCase({ name: 'b', arm: 'prometheus', maxRequests: 3 }, f.fixture);
  for (const [sessionID, caseID] of [['origin', 'a'], ['worker', 'b'], ['evaluator', 'b']]) first.session(caseID, { id: sessionID, location: { directory: f.fixture } });
  first.reserve('a', { sessionID: 'origin', kind: 'primary', model: f.input.model });
  second.reserve('b', { sessionID: 'worker', kind: 'compaction', model: f.input.model });
  first.reserve('b', { sessionID: 'evaluator', kind: 'generate', model: f.input.model });
  assert.throws(() => second.reserve('a', { sessionID: 'origin', kind: 'primary', model: f.input.model }), /exhausted/);
  assert.equal(second.get().requests, 3);
  assert.equal(first.summary().reservations.length, 3);
  assert.throws(() => second.initialize(f.admission), /cannot reset/);
});

test('metering refuses model drift, lost owners, and exhausted deadlines before dispatch', async t => {
  const f = await setup(t);
  let now = Date.now(); let alive = true;
  const ledger = new Ledger(path.join(f.base, 'ledger'), { now: () => now, ownerAlive: () => alive });
  t.after(() => ledger.close()); ledger.initialize(f.admission);
  ledger.beginCase(f.admission.input.cases[0], f.fixture);
  ledger.session('ordinary', { id: 'origin', location: { directory: f.fixture } });
  assert.throws(() => ledger.reserve('ordinary', { sessionID: 'origin', model: { providerID: 'other', id: 'other' } }), /unapproved model/);
  alive = false;
  assert.throws(() => ledger.reserve('ordinary', { sessionID: 'origin', model: f.input.model }), /owner is absent/);
  alive = true; now += f.input.timeoutMs;
  assert.throws(() => ledger.reserve('ordinary', { sessionID: 'origin', model: f.input.model }), /duration expired/);
  assert.equal(ledger.get().requests, 0);
});

test('cost observations never decrease, double-count, or become a billing guarantee', async t => {
  const f = await setup(t, { maxUSD: 0.02 });
  const ledger = new Ledger(path.join(f.base, 'ledger'));
  t.after(() => ledger.close()); ledger.initialize(f.admission); ledger.beginCase(f.admission.input.cases[0], f.fixture);
  ledger.session('ordinary', { id: 'origin', location: { directory: f.fixture } });
  ledger.usage('origin', 0.02); ledger.usage('origin', 0.01);
  assert.equal(ledger.get().observedCostUSD, 0.02);
  assert.equal(ledger.get().costLimitIsEstimate, true);
  assert.throws(() => ledger.reserve('ordinary', { sessionID: 'origin', model: f.input.model }), /estimate limit/);
});

test('ordinary-Build campaigns retain independent checks, usage, and comparison-ready outcomes', async t => {
  const f = await setup(t);
  const client = new ScriptedClient(); t.after(() => client.close());
  const report = await runCampaign(f.admission, { client, output: f.output, makeRunner });
  assert.equal(report.complete, true, JSON.stringify(report));
  assert.equal(report.releaseQualified, false);
  assert.equal(report.requests, 1);
  assert.equal(report.observedCostUSD, 0.01);
  assert.equal(report.cases[0].acceptedCompletion, true);
  assert.equal(report.cases[0].falseAcceptance, false);
  assert.equal(report.cases[0].stop.confirmed, true);
  assert.equal(fs.readFileSync(path.join(f.fixture, 'greeting.txt'), 'utf8'), 'wrong');
  await assert.rejects(runCampaign(f.admission, { client, output: f.output, makeRunner }), /new output/);
});

test('Plan checkpoints and expected Draft outcomes do not require product acceptance', async t => {
  const steps = [{ type: 'prompt', text: 'Prepare a greeting.', resume: false }, { type: 'command', name: 'goal' },
    { type: 'wait', idle: true, checks: [{ path: 'state', equals: 'Draft' }, { path: 'changedFiles', equals: [] }, { path: 'counts.workers', equals: 0 }], save: 'prepared' },
    { type: 'agent', agent: 'build' }, { type: 'wait', stableMs: 100, checks: [{ path: 'counts.workers', equals: 0 }, { path: 'specificationID', sameAs: 'checkpoints.prepared.specificationID' }] }];
  // The fixture has no selected specification. Use a concrete saved native fact instead.
  steps[4].checks[1] = { path: 'native.agent', equals: 'build' };
  const f = await setup(t, { cases: [{ name: 'prepare', fixture: 'fixture', agent: 'plan', steps, oracles: [['node', '{oracle}/check.mjs']], expect: { states: ['Draft'] } }] });
  const client = new ScriptedClient(); t.after(() => client.close());
  const report = await runCampaign(f.admission, { client, output: f.output, makeRunner: () => ({ run: async () => ({ code: 0, interrupted: false }) }) });
  assert.equal(report.complete, true, JSON.stringify(report));
  assert.equal(report.cases[0].snapshot.state, 'Draft');
  assert.equal(report.cases[0].acceptedCompletion, false);
});

test('unexpected human rescue prevents unattended success', async t => {
  const f = await setup(t);
  const client = new ScriptedClient({ unexpected: true }); t.after(() => client.close());
  const report = await runCampaign(f.admission, { client, output: f.output, makeRunner });
  assert.equal(report.complete, false);
  assert.equal(report.cases[0].interventions[0].type, 'unexpected-user-message');
});

test('false completion stops the campaign and retains the failed candidate', async t => {
  const f = await setup(t);
  const client = new ScriptedClient({ wrong: true }); t.after(() => client.close());
  const report = await runCampaign(f.admission, { client, output: f.output, makeRunner });
  assert.equal(report.complete, false);
  assert.equal(report.cases[0].falseAcceptance, true);
  assert.equal(report.usage.campaign.state, 'Paused');
  assert.equal(report.requests, 1);
  assert.equal(fs.readFileSync(path.join(f.output, 'workspaces/ordinary/greeting.txt'), 'utf8'), 'wrong');
});

test('lost model transport preserves reservations and a partial report', async t => {
  const f = await setup(t);
  const client = new ScriptedClient({ failure: true }); t.after(() => client.close());
  const report = await runCampaign(f.admission, { client, output: f.output, makeRunner });
  assert.equal(report.complete, false);
  assert.equal(report.requests, 1);
  assert.match(report.cases[0].error, /Lost model transport/);
  assert.equal(report.usage.reservations[0].state, 'reserved');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.output, 'report.json'))).requests, 1);
});

test('independent checks must pass controlled readiness examples before model work', async t => {
  const f = await setup(t);
  f.input.cases[0].readiness = [{ fixture: 'fixture', exitCode: 0 }];
  fs.writeFileSync(f.file, JSON.stringify(f.input));
  const client = new ScriptedClient(); t.after(() => client.close());
  const report = await runCampaign(loadManifest(f.file), { client, output: f.output, makeRunner });
  assert.equal(report.requests, 0);
  assert.equal(client.sessions.size, 0);
  assert.equal(report.cases[0].errorCode, 'oracle_readiness');
});

test('independent checks cannot change candidate inputs and still establish acceptance', async t => {
  const f = await setup(t);
  const client = new ScriptedClient(); t.after(() => client.close());
  const report = await runCampaign(f.admission, { client, output: f.output, makeRunner: () => ({ run: async ({ cwd }) => {
    fs.writeFileSync(path.join(cwd, 'greeting.txt'), 'tampered'); return { code: 0, interrupted: false };
  } }) });
  assert.equal(report.complete, false);
  assert.equal(report.cases[0].errorCode, 'oracle_changed_candidate');
});

test('inspection reads retained evidence without starting a service or resuming', async t => {
  const f = await setup(t);
  const client = new ScriptedClient(); t.after(() => client.close());
  await runCampaign(f.admission, { client, output: f.output, makeRunner });
  const { stdout } = await exec(process.execPath, ['qualification/run.mjs', '--inspect', f.output], { cwd: runtimeRoot });
  assert.equal(JSON.parse(stdout).complete, true);
  assert.match(JSON.parse(stdout).note, /No service access/);
});

test('ordinary-Build preflight rejects Prometheus continuation in the baseline', async () => {
  const client = { plugin: { list: async () => ({ data: [{ id: 'prometheus', source: { type: 'local', path: path.join(runtimeRoot, 'index.mjs') }, state: { status: 'active' } }] }) } };
  await assert.rejects(preflight(client, { root: '/unused', packageRoot: runtimeRoot, arm: 'build' }), /unexpectedly loaded/);
});

test('native file guards preserve governing files and qualification configuration', async t => {
  const f = await setup(t);
  for (const file of ['SPEC.md', 'opencode.json', '../outside.txt']) assert.throws(() => nativeFileBoundary({ tool: 'write', input: { filePath: file } }, f.fixture));
  assert.throws(() => nativeFileBoundary({ tool: 'patch', input: { patchText: '*** Begin Patch\n*** Add File: ../outside.txt\n+x\n*** End Patch' } }, f.fixture));
  assert.doesNotThrow(() => nativeFileBoundary({ tool: 'write', input: { filePath: 'greeting.txt' } }, f.fixture));
});

test('native shell boundaries quote the original program and remove inherited credentials', async t => {
  const f = await setup(t);
  const scratch = path.join(f.base, 'scratch'); fs.mkdirSync(scratch, { mode: 0o700 });
  const event = { cwd: f.fixture, shell: '/bin/zsh', command: "printf '%s' \"a'b\" > quoted.txt", env: { OPENAI_API_KEY: 'not-a-real-key' } };
  nativeShellBoundary(event, { root: f.fixture, scratch, protectedPaths: [f.base] });
  assert.match(event.command, /env -i/);
  assert.match(event.command, /sandbox-exec/);
  assert.equal(event.env.OPENAI_API_KEY, undefined);
});

test('independent export and validator checks discriminate controlled examples inside the real boundary', { skip: !sandboxAvailable(), timeout: 30000 }, async t => {
  const f = await setup(t);
  const good = path.join(f.base, 'good'); const bad = path.join(f.base, 'bad'); const oracle = path.join(f.base, 'oracle');
  copyAsset(tree(path.join(runtimeRoot, 'qualification/fixtures/export-cli-good'), { fixture: true }), good);
  copyAsset(tree(path.join(runtimeRoot, 'qualification/fixtures/export-cli'), { fixture: true }), bad);
  copyAsset(tree(path.join(runtimeRoot, 'qualification/oracles/export-cli'), { fixture: true }), oracle);
  const scratch = path.join(f.base, 'oracle-scratch'); fs.mkdirSync(scratch, { mode: 0o700 });
  const runner = new Runner({ scratchRoot: scratch, protectedPaths: [runtimeRoot] });
  const run = (cwd, argv) => runner.run({ cwd, argv: [process.execPath, ...argv], readRoots: [oracle, good, bad], timeoutMs: 20000 });
  let result = await run(good, [path.join(oracle, 'check.mjs')]);
  assert.equal(result.code, 0, result.output);
  result = await run(bad, [path.join(oracle, 'check.mjs')]);
  assert.notEqual(result.code, 0);
  result = await run(good, [path.join(oracle, 'validators.mjs'), good, bad]);
  assert.equal(result.code, 0, result.output);
  result = await run(good, [path.join(oracle, 'validator-only.mjs'), good, bad, bad]);
  assert.notEqual(result.code, 0, 'Product implementation must not pass validator-only acceptance.');
  fs.copyFileSync(path.join(good, 'validate.mjs'), path.join(bad, 'validate.mjs'));
  result = await run(bad, [path.join(oracle, 'validator-only.mjs'), good, bad, path.join(runtimeRoot, 'qualification/fixtures/export-cli')]);
  // The source checkout is deliberately unreadable to the process. Use an owned baseline copy.
  assert.notEqual(result.code, 0);
  const baseline = path.join(f.base, 'baseline');
  copyAsset(tree(path.join(runtimeRoot, 'qualification/fixtures/export-cli'), { fixture: true }), baseline);
  result = await runner.run({ cwd: bad, argv: [process.execPath, path.join(oracle, 'validator-only.mjs'), good, bad, baseline],
    readRoots: [oracle, good, bad, baseline], timeoutMs: 20000 });
  assert.equal(result.code, 0, result.output);
  fs.chmodSync(path.join(bad, 'validate.mjs'), 0o600);
  fs.writeFileSync(path.join(bad, 'validate.mjs'), 'process.exit(0);');
  result = await run(bad, [path.join(oracle, 'validators.mjs'), good, bad]);
  assert.notEqual(result.code, 0, 'An always-passing validator must fail qualification.');
});

test('an unfunded comparison does not spend on the first arm and disadvantage the second', async t => {
  const f = await setup(t);
  const common = { fixture: 'fixture', agreement: 'Write hello.', prompt: 'Write hello.', pair: 'greeting', maxRequests: 15,
    timeoutMs: 5000, oracles: [['node', '{oracle}/check.mjs']] };
  fs.writeFileSync(f.file, JSON.stringify({ ...f.input, maxRequests: 20, cases: [{ ...common, name: 'prometheus' }, { ...common, name: 'build', arm: 'build' }] }));
  const client = new ScriptedClient(); t.after(() => client.close());
  const report = await runCampaign(loadManifest(f.file), { client, output: f.output, makeRunner });
  assert.equal(report.requests, 0);
  assert.equal(client.sessions.size, 0);
  assert.match(report.error, /fund equal request allowances/);
});

test('a reviewed follow-up carries prior consumption instead of resetting a repaired campaign', async t => {
  const f = await setup(t, { maxRequests: 2 });
  const first = new ScriptedClient({ wrong: true }); const second = new ScriptedClient();
  t.after(() => { first.close(); second.close(); });
  const failed = await runCampaign(f.admission, { client: first, output: f.output, makeRunner });
  const originalReport = fs.readFileSync(path.join(f.output, 'report.json'));
  assert.equal(failed.requests, 1);
  fs.writeFileSync(f.file, JSON.stringify({ ...f.input, previousCampaign: 'output' }));
  const continuation = loadManifest(f.file);
  assert.equal(continuation.previous.requests, 1);
  const report = await runCampaign(continuation, { client: second, output: path.join(f.base, 'follow-up'), makeRunner });
  assert.equal(report.complete, true, JSON.stringify(report));
  assert.equal(report.requests, 2);
  assert.equal(report.cases[0].requests, 1);
  assert.equal(report.cases[0].allocatedRequests, 1);
  assert.equal(report.observedCostUSD, 0.02);
  assert.ok(report.activeElapsedMs >= failed.activeElapsedMs);
  assert.deepEqual(fs.readFileSync(path.join(f.output, 'report.json')), originalReport);
});

test('unknown prior effects block a follow-up rather than becoming a fresh replay', async t => {
  const f = await setup(t);
  const client = new ScriptedClient({ wrong: true }); t.after(() => client.close());
  await runCampaign(f.admission, { client, output: f.output, makeRunner });
  const file = path.join(f.output, 'report.json'); const report = JSON.parse(fs.readFileSync(file));
  report.cases[0].uncertainActions = [{ id: 'unknown', state: 'unknown' }];
  fs.writeFileSync(file, JSON.stringify(report));
  fs.writeFileSync(f.file, JSON.stringify({ ...f.input, previousCampaign: 'output' }));
  assert.throws(() => loadManifest(f.file), /Reconcile/);
});

test('an oracle infrastructure error is unresolved, not evidence of false acceptance', async t => {
  const f = await setup(t);
  const client = new ScriptedClient(); t.after(() => client.close());
  const report = await runCampaign(f.admission, { client, output: f.output, makeRunner: () => ({ run: async () => ({ code: 127, interrupted: false, output: 'Toolchain unavailable.' }) }) });
  assert.equal(report.cases[0].status, 'Unresolved');
  assert.equal(report.cases[0].falseAcceptance, false);
  assert.equal(report.cases[0].externalInfrastructureFailure, true);
  assert.equal(report.complete, false);
});

test('each execution loads a fresh bound runtime rather than cached checkout modules', async t => {
  const f = await setup(t);
  const client = new ScriptedClient(); t.after(() => client.close());
  const report = await runCampaign(f.admission, { client, output: f.output, makeRunner });
  assert.equal(report.installedRuntime.id, f.admission.binding.runtime.id);
  assert.notEqual(report.installedRuntime.directory, runtimeRoot);
  assert.equal(fs.readFileSync(path.join(report.installedRuntime.directory, 'index.mjs'), 'utf8'), fs.readFileSync(path.join(runtimeRoot, 'index.mjs'), 'utf8'));
  assert.equal(fs.lstatSync(path.join(report.installedRuntime.directory, 'src/controller.mjs')).isSymbolicLink(), false);
});

test('approval rejects changed runtime bytes without modifying the source checkout', async t => {
  const f = await setup(t);
  const runtime = installRuntime(f.admission, path.join(f.base, 'runtime-copy'));
  const admission = loadManifest(f.file, { runtimeRoot: runtime });
  const file = path.join(runtime, 'src/prompts.mjs');
  const source = fs.readFileSync(path.join(runtimeRoot, 'src/prompts.mjs'));
  fs.chmodSync(file, 0o600); fs.appendFileSync(file, '\n// Controlled source change.\n');
  assert.throws(() => verifyAdmission(admission), /changed after approval/);
  assert.deepEqual(fs.readFileSync(path.join(runtimeRoot, 'src/prompts.mjs')), source);
});

test('an unanticipated interaction is unresolved rather than a product failure', async t => {
  const f = await setup(t, { cases: [{ name: 'question', arm: 'build', agent: 'plan', fixture: 'fixture',
    steps: [{ type: 'prompt', text: 'Ask about the preference.', resume: false },
      { type: 'answer', title: 'Expected title', answer: { preference: 'hello' }, timeoutMs: 25 }],
    oracles: [['node', '{oracle}/check.mjs']] }] });
  const client = new ScriptedClient(); t.after(() => client.close());
  client.session.form = { list: async () => [{ id: 'different', title: 'Another title' }] };
  const report = await runCampaign(f.admission, { client, output: f.output, makeRunner });
  assert.equal(report.requests, 0);
  assert.equal(report.cases[0].status, 'Unresolved');
  assert.equal(report.cases[0].errorCode, 'interaction_mismatch');
});

test('a cancellation before admission creates no output and starts no service work', async t => {
  const f = await setup(t);
  const client = new ScriptedClient(); t.after(() => client.close());
  const stop = new AbortController(); stop.abort(new Error('The user cancelled.'));
  await assert.rejects(runCampaign(f.admission, { client, output: f.output, signal: stop.signal, makeRunner }), /cancelled/);
  assert.equal(client.sessions.size, 0);
  assert.equal(fs.existsSync(f.output), false);
});

test('admission rejects ignored step fields and unsafe controlled faults', async t => {
  const f = await setup(t);
  fs.writeFileSync(f.file, JSON.stringify({ ...f.input, cases: [{ ...f.input.cases[0], steps: [{ type: 'wait', idle: true, typo: true }] }] }));
  assert.throws(() => loadManifest(f.file), /unknown or ignored/);
  for (const target of ['SPEC.md', 'opencode.json', '.env', '../outside']) {
    fs.writeFileSync(f.file, JSON.stringify({ ...f.input, cases: [{ ...f.input.cases[0], arm: 'prometheus', candidateFault: { path: target, content: 'bad', reason: 'Controlled test.' } }] }));
    assert.throws(() => loadManifest(f.file), /candidate fault/);
  }
});

test('a live PID with a different process identity cannot own qualification dispatch', async t => {
  const f = await setup(t);
  const ledger = new Ledger(path.join(f.base, 'identity-ledger'));
  t.after(() => ledger.close()); ledger.initialize(f.admission);
  ledger.beginCase(f.admission.input.cases[0], f.fixture);
  ledger.session('ordinary', { id: 'origin', location: { directory: f.fixture } });
  ledger.store.update('campaign', 'campaign', campaign => ({ owner: { ...campaign.owner, identity: 'a-different-process' } }), 'controlled_owner_fault');
  assert.throws(() => ledger.reserve('ordinary', { sessionID: 'origin', kind: 'primary', model: f.input.model }), /owner is absent/);
  assert.equal(ledger.get().requests, 0);
});

test('published campaign examples admit only after explicit model and allowance selection', async t => {
  const f = await setup(t);
  const qualification = path.join(runtimeRoot, 'qualification');
  for (const name of ['example.json', 'campaign.example.json', 'discovery.example.json']) {
    const input = JSON.parse(fs.readFileSync(path.join(qualification, name)));
    input.model = { providerID: 'fixture', id: 'fixture' };
    input.maxRequests = 200; input.timeoutMs = 120000;
    for (const item of input.cases) {
      item.fixture = path.join(qualification, item.fixture);
      if (item.oracleFixture) item.oracleFixture = path.join(qualification, item.oracleFixture);
      if (typeof item.maxRequests === 'string') item.maxRequests = 30;
      if (typeof item.timeoutMs === 'string') item.timeoutMs = 10000;
      for (const example of item.readiness ?? []) example.fixture = path.join(qualification, example.fixture);
      for (const key of Object.keys(item.references ?? {})) item.references[key] = path.join(qualification, item.references[key]);
    }
    fs.writeFileSync(f.file, JSON.stringify(input));
    const admission = loadManifest(f.file);
    assert.equal(admission.input.cases.length, input.cases.length);
    assert.equal(fs.existsSync(f.output), false);
  }
});

test('cancellation after dispatch retains consumption and interrupts only owned sessions', async t => {
  const f = await setup(t);
  const client = new ScriptedClient(); t.after(() => client.close());
  const stop = new AbortController();
  const prompt = client.session.prompt;
  client.session.prompt = async input => { const message = await prompt(input); stop.abort(new Error('The user cancelled.')); return message; };
  const report = await runCampaign(f.admission, { client, output: f.output, signal: stop.signal, makeRunner });
  assert.equal(report.complete, false);
  assert.equal(report.requests, 1);
  assert.equal(report.cases[0].stop.confirmed, true);
  assert.deepEqual(client.calls, [['interrupt', report.cases[0].sessionID]]);
  assert.equal(report.usage.campaign.state, 'Paused');
});
