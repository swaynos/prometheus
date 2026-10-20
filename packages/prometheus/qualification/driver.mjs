import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.mjs';
import { Runner } from '../src/sandbox.mjs';
import { manifest as candidateManifest } from '../src/artifacts.mjs';
import { atomic, canonical, hash, id, inside, localPath, privateDirectory, requireThat, errorText } from '../src/util.mjs';
import { copyAsset, installRuntime, runtimeIdentity, verifyAdmission } from './manifest.mjs';
import { compare, Ledger } from './ledger.mjs';
import { preflight } from './preflight.mjs';
import { coverage } from './scenarios.mjs';

const requestOptions = (deadline, signal) => ({ signal: AbortSignal.any([
  AbortSignal.timeout(Math.min(15000, Math.max(1, deadline - Date.now()))), ...(signal ? [signal] : []),
]) });
const checksPass = checks => checks.every(check => check.pass);
const messageText = message => typeof message.text === 'string' ? message.text :
  (message.content ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('\n');

export function comparisons(cases, evidenceClass) {
  return [...new Set(cases.map(c => c.pair).filter(Boolean))].map(pair => ({ pair, kind: cases.find(c => c.pair === pair).comparison ?? 'execution',
    comparable: evidenceClass === 'real-model' && cases.filter(c => c.pair === pair).length === 2 &&
      cases.filter(c => c.pair === pair).every(c => c.status === 'Pass' && c.allocatedDurationMs === c.requestedDurationMs && !c.controlledFaults?.length),
    arms: cases.filter(c => c.pair === pair).map(c => ({
    arm: c.arm, name: c.name, status: c.status, acceptedCompletion: c.acceptedCompletion, falseAcceptance: c.falseAcceptance ?? null,
    requests: c.requests, observedCostUSD: c.observedCostUSD, elapsedMs: c.finished && c.started ? c.finished - c.started : null,
    interventions: c.interventions, participation: c.participation,
  })) }));
}

class Scenario {
  constructor(options) { Object.assign(this, options); this.checkpoints = {}; this.expectedMessages = new Set(); this.expectedReplies = new Map(); }
  openStore() {
    if (this.item.arm === 'build' || this.store) return;
    const directory = path.join(this.runtimeState, hash(this.origin.projectID));
    if (fs.existsSync(path.join(directory, 'prometheus.sqlite'))) this.store = new Store(directory);
  }
  records() {
    this.openStore();
    const task = this.store?.list('task').find(t => t.origin === this.origin.id);
    const list = kind => task ? this.store.list(kind).filter(r => r.taskID === task.id ||
      r.runID && this.store.get('run', r.runID)?.taskID === task.id) : [];
    const run = task?.runID && this.store.get('run', task.runID);
    return { task, run, list };
  }
  sessionIDs() {
    const { list } = this.records();
    return [...new Set([this.origin.id, ...list('session').map(s => s.id),
      ...this.ledger.store.list('meter-session').filter(s => s.caseID === this.item.name).map(s => s.id)])];
  }
  target(target = 'origin') {
    if (target === 'origin') return this.origin.id;
    const { run } = this.records();
    const sessionID = target === 'worker' ? run?.worker : run?.evaluator;
    requireThat(sessionID, `The ${target} session does not exist.`, 'checkpoint');
    return sessionID;
  }
  async snapshot(deadline = this.deadline) {
    const { task, run, list } = this.records();
    const options = requestOptions(deadline, this.signal);
    const [native, active, context] = await Promise.all([
      this.client.session.get({ sessionID: this.origin.id }, options),
      this.client.session.active(options),
      this.client.session.context({ sessionID: this.origin.id }, options),
    ]);
    const manifest = candidateManifest(this.root);
    const baseline = new Map(this.baseline.files.map(f => [f.path, hash(f)]));
    const current = new Map(manifest.files.map(f => [f.path, hash(f)]));
    const changedFiles = [...new Set([...baseline.keys(), ...current.keys()])].filter(file => baseline.get(file) !== current.get(file)).sort();
    const files = {};
    for (const file of this.item.observeFiles) {
      const target = localPath(this.root, file);
      if (!fs.existsSync(target)) { files[file] = null; continue; }
      requireThat(fs.statSync(target).isFile(), 'An observed path must be a regular file.');
      const bytes = fs.readFileSync(target);
      files[file] = { hash: hash(bytes), bytes: bytes.length, ...(bytes.length <= 16384 ? { text: bytes.toString('utf8') } : {}) };
    }
    const prepared = task?.specificationID && this.store.get('specification', task.specificationID);
    const currentAcceptance = run?.state === 'Accepted' && run.specificationID === task.specificationID && run.candidate?.id === manifest.id;
    const sessions = list('session');
    const evaluations = list('evaluation');
    const lastAssistant = context.filter(m => m.type === 'assistant').at(-1);
    return { state: !task ? 'Unenrolled' : run?.state === 'Accepted' && !currentAcceptance ? 'Draft' : run?.state ?? (task.preparationPaused ? 'Paused' : 'Draft'),
      intent: prepared?.goal.intent ?? null, specificationID: task?.specificationID ?? null, candidateID: run?.candidate?.id ?? null,
      acceptanceCurrent: !!currentAcceptance, readiness: task?.readiness ?? null, workerID: run?.worker ?? null, evaluatorID: run?.evaluator ?? null,
      reason: run?.reason ?? task?.preparationPauseReason ?? null, requests: task?.requests ?? 0,
      native: { agent: native.agent, outcome: native.outcome ?? null, idle: !Object.hasOwn(active, this.origin.id),
        lastAssistantText: messageText(lastAssistant ?? {}).slice(-4096), userMessageIDs: context.filter(m => m.type === 'user').map(m => m.id) },
      idle: this.sessionIDs().every(sessionID => !Object.hasOwn(active, sessionID)),
      counts: { workers: sessions.filter(s => s.role === 'worker').length, evaluators: sessions.filter(s => s.role === 'evaluator').length,
        findings: list('finding').length, decisions: list('decision').length, spikes: list('spike').length, evaluations: evaluations.length,
        rejections: evaluations.filter(e => e.results?.some(r => r.status !== 'pass')).length,
        uncertainActions: list('action').filter(a => ['intended', 'unknown'].includes(a.state)).length },
      findings: list('finding'), decisions: list('decision'), spikes: list('spike'), evaluations,
      stop: run?.stopID ? this.store.get('stop', run.stopID) : null,
      goal: prepared?.goal ?? null, changedFiles, files, manifestID: manifest.id };
  }
  async poll(step, callback) {
    const until = Math.min(this.deadline, Date.now() + (step.timeoutMs ?? Math.max(1, this.deadline - Date.now())));
    let stableSince;
    let last;
    while (Date.now() < until) {
      this.signal?.throwIfAborted();
      requireThat(this.ledger.get().state === 'Working', this.ledger.get().reason ?? 'The qualification campaign stopped.', 'campaign_stopped');
      last = await callback(until);
      if (last.pass) {
        stableSince ??= Date.now();
        if (Date.now() - stableSince >= (step.stableMs ?? 0)) return last;
      } else stableSince = undefined;
      await delay(Math.min(100, Math.max(1, until - Date.now())), undefined, { signal: this.signal });
    }
    throw Object.assign(new Error('The scenario checkpoint did not become true before its deadline.'), { code: 'checkpoint_timeout', evidence: last });
  }
  async step(step, index) {
    requireThat(this.ledger.get().state === 'Working', this.ledger.get().reason ?? 'The qualification campaign stopped.', 'campaign_stopped');
    const result = { index, type: step.type, started: Date.now() };
    this.result.steps.push(result);
    const participation = step.participation ?? (['permission', 'answer', 'human'].includes(step.type) ? 'decision' : 'stimulus');
    const options = requestOptions(Math.min(this.deadline, Date.now() + (step.timeoutMs ?? Math.max(1, this.deadline - Date.now()))), this.signal);
    try {
      const target = this.target(step.target);
      this.ledger.event(this.item.name, 'step_intended', { index, type: step.type, participation });
      if (step.type === 'prompt') {
        const messageID = `msg_${id().replaceAll('_', '')}`;
        this.expectedMessages.add(messageID);
        await this.client.session.prompt({ sessionID: target, id: messageID, text: step.text, resume: step.resume ?? true,
          metadata: { prometheusQualification: { fingerprint: this.admission.fingerprint, caseID: this.item.name, step: index } } }, options);
        result.messageID = messageID;
      } else if (step.type === 'command') {
        const prior = new Set(this.ledger.store.list('participation').filter(e => e.event === 'prompt_admitted').map(e => e.messageID));
        await this.client.session.command({ sessionID: target, name: step.name, text: step.text ?? '' }, options);
        const { task } = this.records();
        const events = task ? this.store.events('task', task.id).filter(e => e.event === 'user_instruction' && e.data.command === step.name && !prior.has(e.data.messageID)) : [];
        requireThat(events.length === 1, 'The command admission cannot be uniquely attributed.', 'intervention_uncertain');
        this.expectedMessages.add(events[0].data.messageID);
        result.messageID = events[0].data.messageID;
      } else if (step.type === 'agent') await this.client.session.switchAgent({ sessionID: target, agent: step.agent }, options);
      else if (step.type === 'interrupt') await this.client.session.interrupt({ sessionID: target, continue: false }, options);
      else if (step.type === 'mutate') {
        const file = localPath(this.root, step.path);
        requireThat(!step.path.split(/[\\/]/).some(p => ['.git', '.opencode', 'opencode.json', 'opencode.jsonc', 'AGENTS.md'].includes(p)), 'A test stimulus cannot alter qualification controls.');
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        if (fs.existsSync(file)) requireThat(fs.lstatSync(file).isFile() && fs.statSync(file).nlink === 1, 'A test stimulus cannot replace an aliased or special file.');
        fs.writeFileSync(file, step.content, { mode: 0o600 });
        result.mutation = { path: step.path, hash: hash(step.content), reason: step.reason };
      } else if (['permission', 'answer', 'human'].includes(step.type)) {
        const manual = step.type === 'human';
        const permission = step.type === 'permission' || manual && step.request === 'permission';
        let found;
        try {
          found = await this.poll(step, async () => {
            const pending = permission ? await this.client.permission.list({ sessionID: target }, options) : await this.client.session.form.list({ sessionID: target }, options);
            const matches = pending.filter(p => permission ? p.action === step.action && (!step.resources || hash(p.resources) === hash(step.resources)) : !step.title || p.title === step.title);
            requireThat(matches.length <= 1, 'The declared human response matches more than one pending request.', 'interaction_mismatch');
            return { pass: matches.length === 1, request: matches[0], pending: pending.map(p => ({ id: p.id, title: p.title, action: p.action })) };
          });
        } catch (error) { if (error.code === 'checkpoint_timeout') error.code = 'interaction_mismatch'; throw error; }
        const request = found.request;
        const replyID = request.id;
        this.expectedReplies.set(replyID, manual ? { type: permission ? 'permission.replied' : 'form.replied' } : permission ?
          { type: 'permission.replied', reply: step.decision } : { type: 'form.replied', answerHash: hash(step.answer) });
        this.ledger.event(this.item.name, 'reply_intended', { requestID: replyID, type: step.type, participation, manual, index });
        if (manual) await this.progress({ name: this.item.name, type: 'awaiting-response', requestKind: step.request, sessionID: target,
          requestID: replyID, title: request.title, action: request.action, instructions: step.instructions });
        else if (permission) await this.client.permission.reply({ sessionID: target, requestID: request.id, decision: step.decision }, options);
        else await this.client.session.form.reply({ sessionID: target, formID: request.id, answer: step.answer }, options);
        await this.poll(manual ? step : { timeoutMs: 5000 }, async () => ({ pass: this.ledger.store.list('participation').some(e =>
          e.caseID === this.item.name && e.event === 'native_reply' && e.requestID === replyID) }));
        result.requestID = replyID;
      } else {
        const observe = async (until = Math.min(this.deadline, Date.now() + (step.timeoutMs ?? Math.max(1, this.deadline - Date.now())))) => {
          const snapshot = await this.snapshot(until);
          const checks = compare(step.checks, { ...snapshot, checkpoints: this.checkpoints });
          if (step.type === 'wait' && snapshot.state === 'Paused' && !checksPass(checks) &&
            !step.checks?.some(c => c.path === 'state' && c.equals === 'Paused')) {
            throw Object.assign(new Error(`The product paused before the expected checkpoint: ${snapshot.reason ?? 'No reason supplied.'}`), {
              code: 'checkpoint', evidence: { snapshot, checks },
            });
          }
          return { pass: checksPass(checks) && (!step.idle || (step.target ? step.target === 'origin' ? snapshot.native.idle :
            !Object.hasOwn(await this.client.session.active(options), target) : snapshot.idle)), snapshot, checks };
        };
        const observation = step.type === 'wait' ? await this.poll(step, observe) : await observe();
        result.snapshot = observation.snapshot;
        result.checks = observation.checks;
        requireThat(observation.pass, 'A scenario checkpoint failed.', 'checkpoint');
        if (step.save) this.checkpoints[step.save] = observation.snapshot;
      }
      result.status = participation === 'rescue' ? 'Rescued' : 'Pass';
      if (participation === 'rescue') this.result.interventions.push({ index, type: 'declared-rescue' });
      this.result.participation.push({ index, type: step.type, classification: participation });
      this.ledger.event(this.item.name, 'step_completed', { index, type: step.type, participation, messageID: result.messageID });
    } catch (error) {
      result.status = 'Fail'; result.error = errorText(error); result.evidence = error.evidence;
      throw error;
    } finally { result.finished = Date.now(); this.save(); }
  }
  async audit() {
    for (const sessionID of this.sessionIDs()) {
      let cursor;
      const seen = new Set();
      do {
        const page = await this.client.message.list({ sessionID, ...(cursor ? { cursor } : { order: 'asc' }) }, requestOptions(Date.now() + 10000));
        for (const message of page.data) {
          if (message.type === 'user' && !this.expectedMessages.has(message.id)) this.result.interventions.push({ type: 'unexpected-user-message', sessionID, messageID: message.id });
        }
        const next = page.cursor?.next;
        requireThat(!next || !seen.has(next), 'Native message pagination repeated a cursor.');
        if (next) seen.add(next);
        cursor = next;
      } while (cursor);
      const native = await this.client.session.get({ sessionID }, requestOptions(Date.now() + 10000));
      this.ledger.session(this.item.name, native);
      this.ledger.usage(sessionID, native.cost ?? 0);
    }
    const { task } = this.records();
    if (task && this.store.events('task', task.id).some(e => e.event === 'operator_resource_grant')) this.result.interventions.push({ type: 'operator-resource-grant' });
    for (const event of this.ledger.store.list('participation').filter(e => e.caseID === this.item.name && e.event === 'native_reply')) {
      const expected = this.expectedReplies.get(event.requestID);
      if (!expected || Object.entries(expected).some(([key, value]) => event[key] !== value)) this.result.interventions.push({ type: 'unexpected-native-reply', requestID: event.requestID });
      if (event.type === 'permission.replied' && event.reply === 'always') this.result.interventions.push({ type: 'persistent-permission-grant', requestID: event.requestID });
    }
    requireThat(!this.ledger.store.list('participation').some(e => e.caseID === this.item.name && e.event === 'tracking_lost'),
      'Native participation observation was incomplete.', 'intervention_uncertain');
  }
  async stop() {
    const stopDeadline = Date.now() + 10000;
    this.ledger.store.update('case', this.item.name, () => ({ state: 'Stopping' }), 'case_stopping');
    const ids = this.sessionIDs();
    const results = await Promise.allSettled(ids.map(async sessionID => {
      await this.client.session.interrupt({ sessionID, continue: false }, requestOptions(stopDeadline));
      await this.client.session.wait({ sessionID }, requestOptions(stopDeadline));
    }));
    let active;
    let recordedProcessesConfirmed;
    while (Date.now() < stopDeadline) {
      active = await this.client.session.active(requestOptions(stopDeadline));
      const { run, list } = this.records();
      const stop = run?.stopID ? this.store.get('stop', run.stopID) : null;
      recordedProcessesConfirmed = this.item.arm === 'build' ? null : !run ||
        ['Accepted', 'Paused'].includes(run.state) && (!stop || stop.state === 'confirmed') &&
        list('action').every(a => a.completionReceived || ['settled', 'no-effect'].includes(a.state));
      if (this.sessionIDs().every(sessionID => !Object.hasOwn(active, sessionID)) && recordedProcessesConfirmed !== false) break;
      await delay(25);
    }
    const nativeIdleConfirmed = !!active && results.every(r => r.status === 'fulfilled') && this.sessionIDs().every(sessionID => !Object.hasOwn(active, sessionID));
    this.result.stop = { requested: ids, confirmed: nativeIdleConfirmed && recordedProcessesConfirmed !== false,
      nativeIdleConfirmed, recordedProcessesConfirmed,
      scope: this.item.arm === 'build' ? 'Native session cessation. This does not certify detached descendants or remote effects.' :
        'Native sessions and controller-recorded local processes. This does not certify remote cessation.',
      errors: results.filter(r => r.status === 'rejected').map(r => errorText(r.reason)) };
    const { list } = this.records();
    this.result.uncertainActions = list('action').filter(action => ['intended', 'unknown'].includes(action.state)).map(action => ({
      id: action.id, state: action.state, completionReceived: action.completionReceived ?? false,
    }));
    this.result.uncertainDispatches = list('dispatch').filter(dispatch => dispatch.state === 'unknown').map(dispatch => ({ id: dispatch.id, state: dispatch.state }));
    if (!this.result.stop.confirmed) this.ledger.stop('Owned qualification activity has an unconfirmed stop outcome.');
    this.ledger.store.update('case', this.item.name, () => ({ state: this.result.stop.confirmed ? 'Finished' : 'Paused', finished: Date.now() }), 'case_stopped');
  }
}

export async function runCampaign(admission, { client, output, signal, progress = () => {}, makeRunner = options => new Runner(options) }) {
  signal?.throwIfAborted();
  verifyAdmission(admission);
  output = canonical(output);
  requireThat(!fs.existsSync(output), 'Choose a new output directory. Existing campaigns cannot reset or replay.');
  requireThat(!inside(admission.runtimeRoot, output), 'Keep campaign output outside the installed package.');
  const service = await client.server.info({ signal: AbortSignal.timeout(15000) });
  requireThat(service.version === '2.0.29', `Qualification supports OpenCode 2.0.29. The service reports ${service.version}.`);
  signal?.throwIfAborted();
  privateDirectory(output);
  const installedRoot = installRuntime(admission, path.join(output, 'installation'));
  const privateRoot = privateDirectory(path.join(output, 'private'));
  const runtimeState = privateDirectory(path.join(privateRoot, 'runtime'));
  const meterDirectory = privateDirectory(path.join(privateRoot, 'campaign'));
  const scratch = privateDirectory(path.join(output, 'oracle-scratch'));
  const nativeScratch = privateDirectory(path.join(output, 'native-scratch'));
  const oracleBase = privateDirectory(path.join(output, 'oracles'));
  const workspaceBase = privateDirectory(path.join(output, 'workspaces'));
  const readinessBase = privateDirectory(path.join(output, 'readiness'));
  const referenceBase = privateDirectory(path.join(output, 'references'));
  const ledger = new Ledger(meterDirectory);
  ledger.initialize(admission);
  const deadline = ledger.get().deadline;
  const report = { fingerprint: admission.fingerprint, source: admission.binding, model: admission.input.model,
    maxRequests: admission.input.maxRequests, installedRuntime: { directory: installedRoot, id: admission.binding.runtime.id },
    started: Date.now(), environment: { platform: process.platform, release: os.release(), node: process.version, loadedOpenCode: service.version },
    evidenceClass: admission.input.evidenceClass,
    complete: false, releaseQualified: false, cases: [], comparisons: [], limitations: [
      'Observed USD amounts are estimates, not billing guarantees.',
      'Both arms use bounded local file, search, question, and shell tools. External tools, unrestricted Code Mode, and arbitrary delegation are not authorized.',
      'Ordinary Build receives no Prometheus continuation or evaluator feedback. Its native shells share the declared macOS filesystem boundary.',
      'Native reply auditing depends on uninterrupted event observation. Observed tracking loss blocks a complete report.',
      'Native audits cannot identify every off-channel filesystem edit. The operator must declare manual file repairs and other interventions.',
      'A completed campaign is not full-release qualification without the requirement and fault evidence review.',
      'No automatic replay or resume is provided after a campaign interruption.',
    ] };
  const save = () => {
    report.usage = ledger.summary();
    report.requests = report.usage.campaign.requests;
    report.observedCostUSD = report.usage.campaign.observedCostUSD;
    report.comparisons = comparisons(report.cases, report.evidenceClass);
    report.unrunCases = admission.input.cases.filter(item => !report.cases.some(c => c.name === item.name)).map(item => ({ name: item.name, scenarios: item.scenarios }));
    report.coverage = coverage([...report.cases, ...report.unrunCases], report.evidenceClass);
    report.activeElapsedMs = (admission.previous?.elapsedMs ?? 0) + (report.finished ?? Date.now()) - report.started;
    atomic(path.join(output, 'report.json'), JSON.stringify(report, null, 2), { replace: true });
  };
  atomic(path.join(output, 'manifest.json'), admission.bytes);
  atomic(path.join(output, 'admission.json'), JSON.stringify(admission.binding, null, 2));
  const aborted = () => { ledger.stop('The qualification operator interrupted the campaign.'); save(); };
  signal?.addEventListener('abort', aborted, { once: true });
  const runner = makeRunner({ scratchRoot: scratch, protectedPaths: [privateRoot, admission.runtimeRoot, installedRoot] });
  async function oracles(item, root, oracleRoot, references, until) {
    const results = [];
    for (const argv of item.oracles) {
      signal?.throwIfAborted();
      requireThat(Date.now() < until, 'The qualification duration expired.', 'campaign_budget');
      const before = candidateManifest(root).id;
      const result = await runner.run({ argv: argv.map(a => {
        let argument = a.replaceAll('{oracle}', oracleRoot).replaceAll('{baseline}', references.baseline);
        for (const [key, directory] of Object.entries(references)) argument = argument.replaceAll(`{reference:${key}}`, directory);
        return argument;
      }), cwd: root, readRoots: [oracleRoot, ...Object.values(references)],
        timeoutMs: Math.min(120000, Math.max(1, until - Date.now())), signal });
      requireThat(candidateManifest(root).id === before, 'An independent check changed candidate inputs.', 'oracle_changed_candidate');
      results.push(result);
    }
    return results;
  }
  try {
    save();
    for (const item of admission.input.cases) {
      signal?.throwIfAborted();
      requireThat(ledger.get().state === 'Working' && Date.now() < deadline && ledger.get().requests < admission.input.maxRequests,
        'The campaign has no remaining dispatch authority.', 'campaign_budget');
      verifyAdmission(admission);
      if (item.pair && !report.cases.some(c => c.pair === item.pair)) {
        const pair = admission.input.cases.filter(c => c.pair === item.pair);
        requireThat(admission.input.maxRequests - ledger.get().requests >= pair.reduce((sum, c) => sum + c.maxRequests, 0),
          'The campaign cannot fund equal request allowances for both comparison arms.', 'campaign_budget');
        requireThat(deadline - Date.now() >= pair.reduce((sum, c) => sum + c.timeoutMs, 0),
          'The campaign cannot allocate the declared duration to both comparison arms.', 'campaign_budget');
      }
      const started = Date.now();
      const caseDeadline = Math.min(deadline, started + item.timeoutMs);
      const result = { name: item.name, arm: item.arm, pair: item.pair, comparison: item.comparison, scenarios: item.scenarios, status: 'Not run', started,
        requestedDurationMs: item.timeoutMs, allocatedDurationMs: caseDeadline - started, steps: [], participation: [], interventions: [] };
      report.cases.push(result);
      const root = path.join(workspaceBase, item.name);
      const oracleRoot = path.join(oracleBase, item.name);
      let scenario;
      try {
        copyAsset(item.fixtureAsset, root, { writable: true });
        copyAsset(item.oracleAsset, oracleRoot);
        const references = {};
        const caseReferences = privateDirectory(path.join(referenceBase, item.name));
        for (const [key, asset] of Object.entries({ baseline: item.fixtureAsset, ...item.referenceAssets })) {
          const directory = path.join(caseReferences, id('reference'));
          copyAsset(asset, directory);
          references[key] = directory;
        }
        result.referenceSources = Object.fromEntries(Object.entries({ baseline: item.fixtureAsset, ...item.referenceAssets }).map(([key, asset]) => [key, asset.id]));
        result.startingCandidate = item.fixtureAsset.id;
        result.oracleSource = item.oracleAsset.id;
        result.readiness = [];
        for (const [index, example] of item.readiness.entries()) {
          const exampleRoot = path.join(readinessBase, `${item.name}-${index}`);
          copyAsset(example.asset, exampleRoot);
          const checks = await oracles(item, exampleRoot, oracleRoot, references, caseDeadline);
          const pass = checks.length === item.oracles.length && checks.every(check => check.code === example.exitCode && !check.interrupted);
          result.readiness.push({ fixture: example.asset.id, expectedExitCode: example.exitCode, pass, checks });
          requireThat(pass, 'An independent check failed its controlled readiness example.', 'oracle_readiness');
        }
        const caseScratch = privateDirectory(path.join(nativeScratch, item.name));
        const protectedPaths = [privateRoot, admission.runtimeRoot, installedRoot, oracleBase, readinessBase, referenceBase];
        result.allocatedRequests = Math.min(item.maxRequests, admission.input.maxRequests - ledger.get().requests);
        ledger.beginCase({ ...item, maxRequests: result.allocatedRequests }, root, { deadline: caseDeadline });
        fs.writeFileSync(path.join(root, 'opencode.json'), JSON.stringify({ plugins: [
          ...(item.arm === 'prometheus' ? [{ package: installedRoot, options: { stateDirectory: runtimeState,
            limits: { maxRequests: result.allocatedRequests, deadline: caseDeadline, ...(admission.input.maxUSD ? { maxUSD: admission.input.maxUSD } : {}) }, protectedPaths } }] : []),
          { package: path.join(installedRoot, 'qualification', 'meter'), options: { directory: meterDirectory,
            fingerprint: admission.fingerprint, caseID: item.name, root, scratch: caseScratch, protectedPaths, runtimeState, candidateFault: item.candidateFault } },
        ], policies: [{ action: 'tool.use', resource: 'prometheus_allowance:*', effect: 'deny' }] }, null, 2), { flag: 'wx', mode: 0o600 });
        const origin = await client.session.create({ agent: item.agent, model: admission.input.model, title: `Qualification: ${item.name}`,
          location: { directory: root }, permissions: item.permissions }, requestOptions(caseDeadline, signal));
        result.sessionID = origin.id;
        ledger.session(item.name, origin);
        scenario = new Scenario({ admission, item, root, origin, client, ledger, runtimeState, deadline: caseDeadline, signal, result, progress,
          baseline: candidateManifest(root), save });
        await preflight(client, { root, packageRoot: installedRoot, meter: true, arm: item.arm, model: admission.input.model,
          signal: requestOptions(caseDeadline, signal).signal });
        progress({ name: item.name, sessionID: origin.id });
        result.status = 'Working';
        for (const [index, step] of item.steps.entries()) {
          verifyAdmission(admission);
          await scenario.step(step, index);
        }
        const snapshot = await scenario.snapshot();
        result.snapshot = snapshot;
        result.finalChecks = compare(item.expect.checks, { ...snapshot, checkpoints: scenario.checkpoints });
        result.expectedState = item.expect.states.includes(snapshot.state);
        // Stop model activity before independent checks. Checks examine the final delivered bytes.
        await scenario.stop();
        requireThat(result.stop.confirmed, 'Owned activity did not confirm cessation.', 'stop_uncertain');
        result.oracles = await oracles(item, root, oracleRoot, references, caseDeadline);
        result.controlledFaults = ledger.store.list('fault').filter(fault => fault.caseID === item.name);
        result.externalChecksPass = result.oracles.length === item.oracles.length && result.oracles.every(r => r.code === 0 && !r.interrupted);
        result.externalProductFailure = result.oracles.some(r => !r.interrupted && item.failureCodes.includes(r.code));
        result.externalInfrastructureFailure = result.oracles.some(r => r.interrupted || r.code !== 0 && !item.failureCodes.includes(r.code));
        result.deliveredCandidate = candidateManifest(root).id;
        const claimedCompletion = item.arm === 'prometheus' ? snapshot.state === 'Accepted' : item.expect.completionClaim ?
          checksPass(compare(item.expect.completionClaim, { ...snapshot, checkpoints: scenario.checkpoints })) : null;
        result.claimedCompletion = claimedCompletion;
        result.acceptedCompletion = result.externalChecksPass && (item.arm === 'build' || snapshot.state === 'Accepted' && snapshot.candidateID === result.deliveredCandidate);
        result.falseAcceptance = claimedCompletion === null ? null : claimedCompletion && (result.externalProductFailure || item.arm === 'prometheus' && snapshot.candidateID !== result.deliveredCandidate);
        await scenario.audit();
        verifyAdmission(admission);
        requireThat(runtimeIdentity(installedRoot).id === admission.binding.runtime.id, 'The installed runtime changed during qualification.', 'admission_changed');
        result.status = result.externalInfrastructureFailure ? 'Unresolved' : result.expectedState && checksPass(result.finalChecks) && result.externalChecksPass && !result.falseAcceptance && !result.interventions.length ? 'Pass' : 'Fail';
        if (result.falseAcceptance) ledger.stop('An accepted candidate failed independent qualification checks.');
        else if (result.status !== 'Pass') ledger.stop(`Qualification case ${item.name} needs review: ${result.status}.`);
      } catch (error) {
        result.error = errorText(error); result.errorCode = error.code ?? 'infrastructure';
        result.status = ['checkpoint', 'checkpoint_timeout', 'model_mismatch'].includes(error.code) ? 'Fail' : 'Unresolved';
        if (scenario && !result.stop) {
          try { await scenario.stop(); } catch (stopError) { result.stop = { confirmed: false, error: errorText(stopError) }; ledger.stop('Qualification stop is uncertain.'); }
        }
        if (scenario) {
          try { await scenario.audit(); } catch (auditError) { result.interventionTrackingUncertain = true; result.auditError = errorText(auditError); }
        }
        ledger.stop(`Qualification case ${item.name} did not complete: ${result.error}`);
      } finally {
        if (scenario?.store) scenario.store.close();
        result.controlledFaults = ledger.store.list('fault').filter(fault => fault.caseID === item.name);
        const usage = ledger.store.get('case', item.name);
        result.requests = usage?.requests ?? 0;
        result.observedCostUSD = usage?.observedCostUSD ?? 0;
        result.finished = Date.now();
        save();
      }
      if (result.status !== 'Pass' || ledger.get().state !== 'Working') break;
    }
    report.complete = report.cases.length === admission.input.cases.length && report.cases.every(c => c.status === 'Pass' && c.stop?.confirmed && !c.interventionTrackingUncertain);
    if (report.complete) ledger.store.update('campaign', 'campaign', () => ({ state: 'Finished', finished: Date.now() }), 'campaign_finished');
  } catch (error) {
    report.error = errorText(error);
    ledger.stop(report.error);
  } finally {
    report.finished = Date.now();
    save();
    signal?.removeEventListener('abort', aborted);
    ledger.close();
  }
  return report;
}
