import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { canonical, hash, id, inside, localPath, requireThat, atomic, errorText } from './util.mjs';
import { goalContract, renderSpec, specIdentity, evaluationContract, limitsContract, withinLimits, spikeContract, findingContract, decisionContract, argumentsContract } from './contracts.mjs';
import { capture, manifest, evidenceFile, checkEvidence, validatorIdentity } from './artifacts.mjs';
import { workerInstructions, evaluatorInstructions } from './prompts.mjs';

export const VERSION = '0.1.0';
const nativeID = prefix => `${prefix}_${id().replaceAll('_', '')}`;

export class Controller {
  constructor({ store, native, runner, root, limits, protectedPaths = [], now = Date.now }) {
    this.store = store;
    this.native = native;
    this.runner = runner;
    this.root = canonical(root);
    requireThat(!inside(this.root, store.directory), 'Keep controller state outside the project.');
    this.limits = limits;
    this.now = now;
    this.owner = `${os.hostname()}:${process.pid}:${id('owner')}`;
    const runtimeRoot = canonical(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
    requireThat(!inside(this.root, runtimeRoot) && !inside(runtimeRoot, this.root),
      'Install the active controller outside the worker project before enrollment.', 'boundary');
    this.protectedPaths = [runtimeRoot, store.directory, ...protectedPaths.map(canonical)];
    this.background = new Set();
    this.driving = new Set();
    this.pendingDrive = new Set();
    this.deadlines = new Map();
    this.stopFlights = new Map();
    this.closed = false;
    for (const name of ['evidence', 'candidates', 'scratch']) fs.mkdirSync(path.join(store.directory, name), { recursive: true, mode: 0o700 });
  }
  launch(promise) {
    const safe = promise.catch(error => { this.lastError = errorText(error); });
    this.background.add(safe);
    safe.finally(() => this.background.delete(safe));
    return safe;
  }
  enroll(origin) {
    let session = this.store.get('session', origin);
    if (session) {
      const task = this.store.get('task', session.taskID);
      requireThat(task.root === this.root, 'This conversation belongs to another workspace. Return there or start a new conversation.', 'boundary');
      return task;
    }
    return this.store.transaction(() => {
      const task = this.store.put('task', { id: id('task'), origin, root: this.root, requests: 0, findings: [], decisions: [], approvedLimits: this.limits, created: this.now() }, 'created');
      this.store.put('session', { id: origin, taskID: task.id, role: 'origin' }, 'enrolled');
      return task;
    });
  }
  session(key) {
    const session = this.store.get('session', key);
    return session && this.store.get('task', session.taskID)?.root === this.root ? session : undefined;
  }
  taskFor(sessionID) {
    const session = this.session(sessionID);
    requireThat(session, 'This session is not enrolled.', 'authority');
    return this.store.get('task', session.taskID);
  }
  originOnly(sessionID) {
    requireThat(this.session(sessionID)?.role === 'origin', 'Only the originating conversation can change the agreement.', 'authority');
    return this.taskFor(sessionID);
  }
  source(sessionID, source) {
    const task = this.originOnly(sessionID);
    return this.store.update('task', task.id, () => ({ source: { ...source, recorded: this.now() } }), 'user_instruction', { messageID: source.id, command: source.command });
  }
  async authority(sessionID, kind) {
    const task = this.originOnly(sessionID);
    const current = await this.native.get(sessionID);
    requireThat(current.agent === 'build', 'Switch to Build before execution.', 'mode');
    const source = task.source;
    requireThat(source && source.agent === 'build', 'A mode switch does not authorize execution.', 'authority');
    requireThat(!task.revokedSourceID || task.revokedSourceID !== source.id, 'A new explicit user instruction is required after permission denial.', 'authority');
    requireThat(!task.preparationPaused || source.id !== task.pausedSourceID, 'A new explicit user instruction is required after this pause.', 'authority');
    const paused = task.runID && this.store.get('run', task.runID);
    requireThat(paused?.state !== 'Paused' || !paused.pausedSourceID || paused.pausedSourceID !== source.id,
      'A new explicit user instruction is required after this pause.', 'authority');
    const context = await this.native.context(sessionID);
    requireThat(context.some(m => m.type === 'user' && m.id === source.id), 'The user instruction is absent from native context.', 'authority');
    const allowed = kind === 'resume' ? source.allowResume : source.allowStart;
    requireThat(allowed, `An explicit user ${kind} instruction is required.`, 'authority');
    return { task, source, model: current.model };
  }
  prepare(sessionID, input) {
    const task = this.originOnly(sessionID);
    const oldRun = task.runID && this.store.get('run', task.runID);
    requireThat(!oldRun || ['Paused', 'Accepted'].includes(oldRun.state), 'Pause active execution before changing the agreement.', 'state');
    const goal = goalContract({ ...input, limits: { ...this.budget(task), ...input?.limits } });
    const specification = { id: specIdentity(goal), goal, document: renderSpec(goal), created: this.now() };
    return this.store.transaction(() => {
      if (!this.store.get('specification', specification.id)) this.store.put('specification', specification, 'prepared');
      return this.store.update('task', task.id, () => ({ specificationID: specification.id }), 'goal_prepared', { specificationID: specification.id });
    });
  }
  currentSpec(task) {
    const spec = this.store.get('specification', task.specificationID);
    requireThat(spec, 'Prepare the goal from the conversation first.', 'state');
    return spec;
  }
  publish(spec, previous) {
    const file = path.join(this.root, 'SPEC.md');
    if (fs.existsSync(file)) {
      requireThat(!fs.lstatSync(file).isSymbolicLink(), 'The specification path is a symlink.', 'boundary');
      const bytes = fs.readFileSync(file);
      if (bytes.toString('utf8') !== spec.document) {
        requireThat(previous && hash(bytes) === previous.hash,
          'An existing SPEC.md differs. Preserve it. Resolve publication with the user.', 'specification_conflict');
        atomic(file, spec.document, { replace: true });
      }
    } else atomic(file, spec.document);
    return { file, hash: hash(fs.readFileSync(file)) };
  }
  budget(task) {
    return task.resourceGrant?.limits ?? task.approvedLimits ?? this.limits;
  }
  approveAllowance(sessionID, limits) {
    const task = this.originOnly(sessionID);
    return this.store.update('task', task.id, () => ({ approvedLimits: limitsContract(limits), resourceGrant: null }),
      'native_allowance_approved', { sourceMessageID: task.source?.id, limits });
  }
  selectLimits(taskID, limits) {
    const task = this.store.get('task', taskID);
    requireThat(withinLimits(limits, this.budget(task)), 'The proposed allowance lacks user authority.', 'authority');
    this.available({ ...task, approvedLimits: limits, resourceGrant: null }, { child: true });
    return this.store.update('task', taskID, () => ({ approvedLimits: limits, resourceGrant: null }), 'execution_limits_selected');
  }
  available(task, { child = false } = {}) {
    requireThat(!task.revokedSourceID || task.revokedSourceID !== task.source?.id, 'A new user instruction is required after permission denial.', 'authority');
    const newInstruction = task.source && task.source.id !== task.pausedSourceID &&
      (task.source.allowStart || task.source.command === 'spike' || task.source.allowInvestigation);
    requireThat(!child || !task.preparationPaused || newInstruction, 'The workflow is paused. Obtain explicit continuation authority.', 'state');
    const budget = this.budget(task);
    requireThat(!child || budget, 'Obtain an aggregate model-request allowance before child work.', 'budget');
    if (budget) {
      requireThat(task.requests < budget.maxRequests, 'The aggregate model-request allowance is exhausted.', 'budget');
      requireThat(!budget.deadline || this.now() < budget.deadline, 'The task deadline expired.', 'budget');
      requireThat(!budget.maxUSD || (task.costUSD ?? 0) < budget.maxUSD, 'The observed cost reached its estimate limit.', 'budget');
    }
  }
  armDeadline(taskID) {
    clearTimeout(this.deadlines.get(taskID));
    const task = this.store.get('task', taskID);
    const deadline = this.budget(task)?.deadline;
    if (!deadline || this.closed) return;
    const timer = setTimeout(() => {
      if (this.closed) return;
      const current = this.budget(this.store.get('task', taskID))?.deadline;
      if (current && this.now() >= current) this.launch(this.pause(task.origin, 'The task deadline expired.'));
      else this.armDeadline(taskID);
    }, Math.min(Math.max(1, deadline - this.now()), 2147483647));
    timer.unref?.();
    this.deadlines.set(taskID, timer);
  }
  reserveRequest(sessionID, kind, model) {
    const record = this.session(sessionID);
    if (!record) return;
    try {
      return this.store.transaction(() => {
        const task = this.taskFor(sessionID);
        const run = record.runID && this.store.get('run', record.runID);
        if (record.role !== 'origin') {
          if (record.runID) requireThat(task.runID === record.runID && !run.retired, 'This session belongs to a retired or superseded run.', 'state');
          if (run && record.role !== 'spike') requireThat(run.owner === this.owner, 'A stale controller cannot authorize model work.', 'ownership');
          if (run && record.role !== 'spike') requireThat(!run.cancelled && ['Working', 'Verifying'].includes(run.state), 'The run does not permit model dispatch.', 'state');
          if (record.role === 'worker') requireThat(run.state === 'Working', 'The worker must remain quiescent during evaluation.', 'state');
          if (record.role === 'evaluator') requireThat(run.state === 'Verifying' && run.evaluator === sessionID, 'This evaluator is stale.', 'state');
          if (record.role === 'spike') requireThat(record.owner === this.owner && !record.completed && !record.paused, 'The spike does not permit model dispatch.', 'state');
        }
        if (record.role === 'spike') {
          const spike = this.store.get('spike', record.spikeID);
          const allowance = spike.allowance;
          requireThat(!allowance || (spike.requests ?? 0) < allowance.maxRequests &&
            (!allowance.deadline || this.now() < allowance.deadline) &&
            (!allowance.maxUSD || (record.observedCostUSD ?? 0) < allowance.maxUSD), 'The spike allowance is exhausted.', 'spike_budget');
          this.store.update('spike', spike.id, () => ({ requests: (spike.requests ?? 0) + 1 }), 'spike_request_reserved');
        }
        this.available(task, { child: record.role !== 'origin' });
        this.store.update('task', task.id, () => ({ requests: task.requests + 1 }), 'request_reserved', { sessionID, kind, model });
        return task.requests + 1;
      });
    } catch (error) {
      const task = this.taskFor(sessionID);
      if (error.code === 'spike_budget') this.finding(sessionID, { outcome: 'inconclusive',
        observations: 'The spike allowance ended before a conclusive finding arrived.', interpretation: 'The question remains unresolved.',
        limitations: 'No feasibility conclusion follows from resource exhaustion.', evidenceIDs: this.store.list('evidence').filter(e => e.sessionID === sessionID).map(e => e.id), source: 'controller-resource-boundary' });
      if (error.code === 'budget') this.launch(this.pause(task.origin, error.message));
      throw error;
    }
  }
  async reconcileUsage(taskID) {
    let costUSD = 0;
    let costUncertain = false;
    for (const session of this.store.list('session').filter(s => s.taskID === taskID)) {
      if (await this.native.exists?.(session.id) === false) {
        costUSD += session.observedCostUSD ?? 0;
        costUncertain ||= !this.neverStarted(session);
        continue;
      }
      const native = await this.native.get(session.id);
      const observedCostUSD = Math.max(session.observedCostUSD ?? 0, (native.cost ?? 0) - (session.initialCost ?? 0));
      costUSD += observedCostUSD;
      if (session.observedCostUSD !== observedCostUSD) this.store.update('session', session.id, () => ({ observedCostUSD }), 'session_cost_observed');
    }
    return this.store.update('task', taskID, () => ({ costUSD, costUncertain }), 'usage_observed');
  }
  claim(runID, { recover = false } = {}) {
    return this.store.update('run', runID, run => {
      if (run.owner && run.owner !== this.owner) {
        const [host, pid] = run.owner.split(':');
        let live = true;
        if (host === os.hostname()) { try { process.kill(Number(pid), 0); } catch (error) { if (error.code === 'ESRCH') live = false; } }
        requireThat(recover && !live, 'Another controller owns this run.', 'ownership');
      }
      return { owner: this.owner, generation: (run.generation ?? 0) + 1 };
    }, 'owner_claimed');
  }
  owned(runID) {
    const run = this.store.get('run', runID);
    requireThat(run?.owner === this.owner, 'This controller no longer owns the run.', 'ownership');
    return run;
  }
  checkSpec(run) {
    const task = this.store.get('task', run.taskID);
    requireThat(task.specificationID === run.specificationID, 'The prepared specification changed. Obtain authority for the new version.', 'specification_changed');
    requireThat(hash(fs.readFileSync(run.publication.file)) === run.publication.hash, 'SPEC.md changed during execution.', 'specification_changed');
    return this.store.get('specification', run.specificationID);
  }
  async start(sessionID) {
    const { task, source } = await this.authority(sessionID, 'start');
    const spec = this.currentSpec(task);
    if (spec.goal.intent !== 'investigation' || spec.goal.validators.some(v => v.argv))
      requireThat(this.runner.available(), 'The required process boundary is unavailable. Execution did not start.', 'isolation');
    const overlaps = run => {
      const other = this.store.get('task', run.taskID)?.root;
      return other && (inside(this.root, other) || inside(other, this.root));
    };
    const competing = this.store.list('run').find(r => r.taskID !== task.id && r.state !== 'Accepted' && !r.retired && overlaps(r));
    requireThat(!competing, `Another goal owns this workspace. Use its originating conversation: ${competing ? this.store.get('task', competing.taskID).origin : ''}`, 'conflict');
    if (task.runID) {
      const run = this.store.get('run', task.runID);
      const unchangedAcceptance = run.state === 'Accepted' && manifest(this.root).id === run.candidate?.id;
      if (!run.retired && run.specificationID === spec.id && (run.state !== 'Accepted' || unchangedAcceptance))
        return run.state === 'Paused' && source.allowResume ? this.resume(sessionID) : this.status(sessionID);
      if (run.state === 'Paused' && !run.retired) {
        this.owned(run.id);
        await this.stopFlights.get(run.id);
        await this.reconcile(run.id);
        const latestAuthority = await this.authority(sessionID, 'start');
        requireThat(latestAuthority.source.id === source.id && latestAuthority.task.specificationID === spec.id,
          'The execution instruction changed during reconciliation.', 'authority');
        requireThat(!this.store.list('action').some(a => a.runID === run.id && a.state === 'unknown') &&
          !this.store.list('dispatch').some(d => d.taskID === task.id && ['unknown', 'intended'].includes(d.state)),
        'Reconcile uncertain effects before revising the active goal.', 'unknown_effect');
        this.available(this.store.get('task', task.id), { child: true });
        requireThat(withinLimits(spec.goal.limits, this.budget(this.store.get('task', task.id))), 'The proposed allowance lacks user authority.', 'authority');
        const publication = this.publish(spec, run.publication);
        this.store.transaction(() => {
          const current = this.owned(run.id);
          requireThat(current.generation === run.generation && current.state === 'Paused' && !current.retired,
            'The run changed during reconciliation.', 'state');
          this.selectLimits(task.id, spec.goal.limits);
          this.store.update('run', run.id, () => ({ specificationID: spec.id, publication, state: 'Working', cancelled: false,
            reason: null, authority: source, candidate: null, evaluator: null }), 'goal_revised');
        });
        this.armDeadline(task.id);
        await this.dispatch(run.worker, workerInstructions(spec.goal, this.findings(this.store.get('task', task.id))), 'pivot');
        this.launch(this.drive(run.worker));
        return this.status(sessionID);
      }
      requireThat(run.state === 'Accepted' || run.retired, 'Pause active work before changing its agreement.', 'state');
    }
    try { await this.native.authorizeChild?.({ origin: sessionID, agent: 'build', target: 'build' }); }
    catch (error) { await this.pause(sessionID, `Child permission was not established: ${errorText(error)}`, { invalidateSource: true }); throw error; }
    const currentAuthority = await this.authority(sessionID, 'start');
    requireThat(currentAuthority.task.specificationID === task.specificationID && currentAuthority.source.id === source.id &&
      currentAuthority.task.runID === task.runID, 'The agreement changed before publication.', 'conflict');
    this.available(currentAuthority.task, { child: true });
    requireThat(withinLimits(spec.goal.limits, this.budget(currentAuthority.task)), 'The proposed allowance lacks user authority.', 'authority');
    this.available({ ...currentAuthority.task, approvedLimits: spec.goal.limits, resourceGrant: null }, { child: true });
    requireThat(!this.store.list('action').some(a => a.taskID === task.id && a.state === 'unknown'), 'Reconcile uncertain task effects before execution.', 'unknown_effect');
    const priorRun = task.runID ? this.store.get('run', task.runID) : this.store.list('run').findLast(r =>
      (r.state === 'Accepted' || r.retired) && r.publication.file === path.join(this.root, 'SPEC.md'));
    const previous = priorRun?.publication;
    const publication = this.publish(spec, previous);
    const baseline = manifest(this.root);
    const run = this.store.transaction(() => {
      const latest = this.store.get('task', task.id);
      requireThat(latest.specificationID === task.specificationID && latest.source?.id === source.id && latest.runID === task.runID,
        'The agreement changed before admission.', 'conflict');
      requireThat(hash(this.budget(latest)) === hash(this.budget(currentAuthority.task)), 'Resource authority changed before admission.', 'conflict');
      this.available(latest, { child: true });
      requireThat(!this.store.list('run').some(r => r.taskID !== task.id && r.state !== 'Accepted' && !r.retired && overlaps(r)), 'Another goal acquired this workspace.', 'conflict');
      const created = this.store.put('run', { id: id('run'), taskID: task.id, specificationID: spec.id, state: 'Working',
        owner: this.owner, generation: 1, publication, baseline, authority: source, model: currentAuthority.model, created: this.now(), worker: nativeID('ses') }, 'admitted');
      this.store.update('task', task.id, () => ({ runID: created.id, preparationPaused: false, preparationPauseReason: null }), 'execution_admitted', { runID: created.id });
      this.selectLimits(task.id, spec.goal.limits);
      this.store.put('session', { id: created.worker, taskID: task.id, runID: created.id, role: 'worker', created: false }, 'worker_intended');
      return created;
    });
    try {
      this.armDeadline(task.id);
      await this.native.create({ id: run.worker, parentID: sessionID, agent: 'build', model: run.model, title: `Prometheus: ${spec.goal.outcome}`, permissions: this.permissions('worker') });
      this.store.update('session', run.worker, () => ({ created: true }), 'worker_created');
      await this.dispatch(run.worker, workerInstructions(spec.goal, this.findings(task)), 'initial');
      this.launch(this.drive(run.worker));
    } catch (error) { this.pauseRecord(run.id, `Execution start requires reconciliation: ${errorText(error)}`); throw error; }
    return this.status(sessionID);
  }
  permissions(role) {
    // Tighten native rules. Do not replace user denials with broad allow rules.
    const rules = ['execute', 'subagent', 'edit'].map(action => ({ action, resource: '*', effect: 'deny' }));
    return rules;
  }
  async dispatch(sessionID, text, label) {
    const session = this.session(sessionID);
    const task = this.taskFor(sessionID);
    this.available(task, { child: true });
    if (session.runID) {
      const run = this.owned(session.runID);
      requireThat(!run.cancelled && ['Working', 'Verifying'].includes(run.state), 'Dispatch is prohibited.', 'state');
      this.checkSpec(run);
    }
    const key = nativeID('msg');
    this.store.transaction(() => {
      if (session.runID) {
        const current = this.owned(session.runID);
        requireThat(!current.cancelled && ['Working', 'Verifying'].includes(current.state), 'Dispatch is prohibited.', 'state');
      }
      requireThat(!this.store.list('dispatch').some(d => d.sessionID === sessionID && ['intended', 'admitted', 'unknown'].includes(d.state)), 'A dispatch already needs reconciliation.', 'duplicate');
      this.store.put('dispatch', { id: key, sessionID, taskID: task.id, label, state: 'intended', created: this.now() }, 'dispatch_intended');
    });
    try {
      await this.native.synthetic({ sessionID, id: key, text, delivery: 'queue' });
      this.store.update('dispatch', key, () => ({ state: 'admitted' }), 'dispatch_admitted');
    } catch (error) {
      this.store.update('dispatch', key, () => ({ state: 'unknown' }), 'dispatch_unknown');
      throw error;
    }
    return key;
  }
  async drive(sessionID) {
    if (this.driving.has(sessionID)) { this.pendingDrive.add(sessionID); return; }
    this.driving.add(sessionID);
    const ownedSession = this.session(sessionID);
    const generation = ownedSession.runID ? this.store.get('run', ownedSession.runID).generation : undefined;
    try {
      while (!this.closed) {
        await this.native.wait(sessionID);
        if (this.closed) return;
        const session = this.session(sessionID);
        if (session.runID && this.store.get('run', session.runID).generation !== generation) return;
        const task = this.taskFor(sessionID);
        await this.reconcileUsage(task.id);
        for (const d of this.store.list('dispatch').filter(d => d.sessionID === sessionID && d.state === 'admitted'))
          this.store.update('dispatch', d.id, () => ({ state: 'settled' }), 'dispatch_settled');
        const info = await this.native.get(sessionID);
        if (info.outcome === 'interrupted') {
          if (session.runID) this.pauseRecord(session.runID, 'The native session was interrupted.');
          else this.store.update('session', sessionID, () => ({ paused: true }), 'spike_interrupted');
          return;
        }
        if (session.role === 'spike') {
          if (session.completed || session.paused) return;
          await this.dispatch(sessionID, 'Continue the same investigation. Diagnose the previous result. Report a supported, disproved, or inconclusive finding within the allowance.', 'spike_continue');
          continue;
        }
        const run = this.owned(session.runID);
        if (run.state === 'Paused' || run.state === 'Accepted') return;
        if (session.role === 'worker' && run.state === 'Verifying') return;
        if (session.role === 'evaluator' && run.evaluator !== sessionID) return;
        if (session.role === 'worker') await this.dispatch(sessionID,
          'The selected goal remains incomplete. Continue in this worker. Explain the next useful attempt. Repair failures or submit the candidate. Do not expand scope.', 'worker_continue');
        else await this.dispatch(sessionID, 'Complete the assigned evaluation. Collect missing evidence. Report every criterion through evaluate. Use unresolved where evidence is unavailable.', 'evaluation_continue');
      }
    } catch (error) {
      const session = this.session(sessionID);
      const run = session?.runID && this.store.get('run', session.runID);
      const stale = run && (run.owner !== this.owner || run.generation !== generation ||
        session.role === 'evaluator' && (run.evaluator !== sessionID || run.state !== 'Verifying') ||
        session.role === 'worker' && run.state === 'Verifying');
      if (run && !this.closed && !stale) this.pauseRecord(session.runID, `Continuation stopped: ${errorText(error)}`);
      else if (session?.role === 'spike' && !this.closed) this.store.update('session', sessionID, () => ({ paused: true, reason: errorText(error) }), 'spike_paused');
    } finally {
      this.driving.delete(sessionID);
      if (this.pendingDrive.delete(sessionID) && !this.closed) this.launch(this.drive(sessionID));
    }
  }
  pauseRecord(runID, reason, { retainSource = false } = {}) {
    const run = this.store.get('run', runID);
    if (!run || ['Accepted', 'Paused'].includes(run.state) || run.owner !== this.owner) return run;
    const stopID = id('stop');
    const sessionIDs = this.store.list('session').filter(s => s.runID === runID && s.role !== 'origin').map(s => s.id);
    const paused = this.store.transaction(() => {
      this.store.put('stop', { id: stopID, runID, requestedAt: this.now(), state: 'requested', sessionIDs }, 'stop_requested');
      return this.store.update('run', runID, () => ({ state: 'Paused', reason, cancelled: true, stopID,
        pausedSourceID: retainSource ? undefined : this.store.get('task', run.taskID).source?.id,
        generation: run.generation + 1 }), 'paused', { reason });
    });
    this.requestStop(stopID);
    return paused;
  }
  requestStop(stopID) {
    const stop = this.store.get('stop', stopID);
    if (this.stopFlights.has(stop.runID)) return this.stopFlights.get(stop.runID);
    this.runner.stop(stop.runID);
    const flight = (async () => {
      try {
        await Promise.all(stop.sessionIDs.map(async sessionID => {
          if (await this.native.exists?.(sessionID) === false) return;
          await this.native.interrupt(sessionID);
          await this.native.wait(sessionID);
        }));
        await this.runner.quiesce?.(stop.runID);
        const pending = this.store.list('action').some(a => a.runID === stop.runID && ['intended', 'unknown'].includes(a.state) && !a.completionReceived);
        this.store.update('stop', stopID, () => ({ state: pending ? 'unresolved' : 'confirmed', nativeStopped: true,
          processesStopped: !pending, observedAt: this.now() }), 'stop_observed');
      } catch (error) {
        this.store.update('stop', stopID, () => ({ state: 'unresolved', reason: errorText(error), observedAt: this.now() }), 'stop_unresolved');
      }
    })();
    this.stopFlights.set(stop.runID, flight);
    this.launch(flight.finally(() => this.stopFlights.delete(stop.runID)));
    return flight;
  }
  async observe(event) {
    if (event.type !== 'session.execution.interrupted' || event.data?.reason !== 'user') return;
    const sessionID = event.data?.sessionID;
    const session = this.session(sessionID);
    if (session?.role === 'origin') await this.pause(sessionID, 'The user interrupted the originating session.');
  }
  async pause(sessionID, reason = 'The user requested a pause.', options) {
    const task = this.taskFor(sessionID);
    if (options?.invalidateSource) this.store.update('task', task.id, () => ({ revokedSourceID: task.source?.id }), 'source_authority_revoked');
    const run = task.runID && this.store.get('run', task.runID);
    if (run && run.state !== 'Accepted' && !run.retired) this.pauseRecord(task.runID, reason, options);
    else this.store.update('task', task.id, () => ({ preparationPaused: true, preparationPauseReason: reason, pausedSourceID: task.source?.id }), 'preparation_paused');
    for (const s of this.store.list('session').filter(s => s.taskID === task.id && s.role === 'spike' && !s.completed)) {
      this.store.update('session', s.id, () => ({ paused: true }), 'spike_paused');
      this.runner.stop(s.id);
      await this.native.interrupt(s.id);
    }
    return this.status(sessionID);
  }
  async requestPause(sessionID, input) {
    const session = this.session(sessionID);
    if (session.role !== 'origin') {
      requireThat(typeof input.decisionRequired === 'string' && input.decisionRequired.trim() && input.evidenceIDs?.length,
        'A blocker needs evidence and a consequential user decision. Continue ordinary repair otherwise.', 'blocker');
      for (const key of input.evidenceIDs) {
        const evidence = checkEvidence(this.store.get('evidence', key));
        requireThat(evidence.taskID === session.taskID, 'The blocker evidence belongs to another task.');
      }
    }
    return this.pause(sessionID, input.reason);
  }
  reconcileOutcome(sessionID, input) {
    const task = this.originOnly(sessionID);
    requireThat(['effect', 'no-effect'].includes(input.outcome) && input.evidenceIDs?.length, 'Supply an observed outcome and evidence.');
    const kind = input.dispatchID ? 'dispatch' : 'action';
    const key = input.dispatchID ?? input.actionID;
    const record = this.store.get(kind, key);
    requireThat(record?.taskID === task.id && ['unknown', 'intended'].includes(record.state), 'The uncertain operation does not belong to this task.');
    for (const evidenceID of input.evidenceIDs) {
      const evidence = checkEvidence(this.store.get('evidence', evidenceID));
      requireThat(evidence.taskID === task.id && evidence.sessionID === sessionID, 'Reconciliation needs origin-bound evidence.');
    }
    return this.store.update(kind, key, () => ({ state: 'settled', observedOutcome: input.outcome, reconciliationEvidence: input.evidenceIDs,
      sourceMessageID: task.source?.id }), 'outcome_reconciled');
  }
  async resume(sessionID) {
    const { task, source } = await this.authority(sessionID, 'resume');
    requireThat(task.runID, 'No execution run exists.', 'state');
    const run = this.owned(task.runID);
    requireThat(run.state === 'Paused' && !run.retired, 'The run is not resumable. Prepare a new execution after retirement.', 'state');
    requireThat(task.specificationID === run.specificationID, 'A changed agreement requires explicit readmission. It cannot silently resume.', 'specification_changed');
    this.available(task, { child: true });
    this.checkSpec(run);
    await this.stopFlights.get(run.id);
    await this.reconcile(run.id);
    requireThat(!this.store.list('dispatch').some(d => d.taskID === task.id && ['unknown', 'intended', 'admitted'].includes(d.state)), 'A dispatch outcome remains uncertain.', 'unknown_effect');
    requireThat(!this.store.list('action').some(a => a.runID === run.id && a.state === 'unknown'), 'A process outcome remains uncertain.', 'unknown_effect');
    const worker = this.session(run.worker);
    if (await this.native.exists?.(run.worker) === false) {
      requireThat(this.neverStarted(worker), 'The used worker conversation is unavailable. Do not replace it silently.', 'missing');
      try { await this.native.authorizeChild?.({ origin: sessionID, agent: 'build', target: 'build' }); }
      catch (error) { await this.pause(sessionID, `Child permission was not established: ${errorText(error)}`, { invalidateSource: true }); throw error; }
      await this.native.create({ id: worker.id, parentID: sessionID, model: run.model, agent: 'build', title: 'Prometheus: authorized execution', permissions: this.permissions('worker') });
      this.store.update('session', worker.id, () => ({ created: true }), 'worker_creation_completed');
    }
    const currentAuthority = await this.authority(sessionID, 'resume');
    requireThat(currentAuthority.source.id === source.id && currentAuthority.task.specificationID === run.specificationID,
      'The resumption instruction changed during reconciliation.', 'authority');
    this.store.transaction(() => {
      const current = this.owned(run.id);
      requireThat(current.generation === run.generation && current.state === 'Paused' && !current.retired,
        'The run changed during reconciliation.', 'state');
      this.store.update('run', run.id, () => ({ state: 'Working', cancelled: false, reason: null, authority: source }), 'resumed');
    });
    this.armDeadline(task.id);
    await this.dispatch(run.worker, `The user authorized continuation in this worker. Current authorized limits: ${JSON.stringify(this.budget(task))}\n${workerInstructions(this.currentSpec(task).goal, this.findings(task))}`, 'resume');
    this.launch(this.drive(run.worker));
    return this.status(sessionID);
  }
  async reconcile(runID) {
    const run = this.owned(runID);
    for (const s of this.store.list('session').filter(s => s.runID === runID)) {
      if (await this.native.exists?.(s.id) === false) {
        if (this.neverStarted(s)) continue;
        for (const d of this.store.list('dispatch').filter(d => d.sessionID === s.id && d.state === 'admitted'))
          this.store.update('dispatch', d.id, () => ({ state: 'unknown' }), 'missing_session_dispatch_unknown');
        throw Object.assign(new Error('A used native conversation is unavailable. Reconcile its effects before retiring the run.'), { code: 'missing' });
      }
      if (s.created === false) this.store.update('session', s.id, () => ({ created: true }), 'session_creation_observed');
      await this.native.wait(s.id);
      const messages = await this.native.context(s.id);
      for (const d of this.store.list('dispatch').filter(d => d.sessionID === s.id && ['intended', 'admitted', 'unknown'].includes(d.state))) {
        if (messages.some(m => m.id === d.id)) this.store.update('dispatch', d.id, () => ({ state: 'settled' }), 'dispatch_reconciled');
        // Absence after compaction is not evidence of no effect.
      }
    }
    for (const a of this.store.list('action').filter(a => a.runID === runID && a.state === 'intended'))
      this.store.update('action', a.id, () => ({ state: 'unknown' }), 'process_outcome_unknown');
    await this.reconcileUsage(run.taskID);
  }
  neverStarted(session) {
    return session?.created === false && !this.store.list('dispatch').some(d => d.sessionID === session.id) &&
      !this.store.events('task', session.taskID).some(e => e.event === 'request_reserved' && e.data.sessionID === session.id);
  }
  async retire(sessionID) {
    const task = this.originOnly(sessionID);
    requireThat(task.runID, 'No execution run exists.');
    await this.pause(sessionID, 'The user requested retirement.');
    await this.stopFlights.get(task.runID);
    for (const session of this.store.list('session').filter(s => s.runID === task.runID)) {
      if (await this.native.exists?.(session.id) === false) continue;
      await this.native.wait(session.id);
      for (const d of this.store.list('dispatch').filter(d => d.sessionID === session.id && d.state === 'admitted'))
        this.store.update('dispatch', d.id, () => ({ state: 'settled' }), 'retired_native_drain_stopped');
    }
    requireThat(!this.store.list('action').some(a => a.taskID === task.id && ['intended', 'unknown'].includes(a.state)) &&
      !this.store.list('dispatch').some(d => d.taskID === task.id && ['intended', 'unknown'].includes(d.state)),
    'Reconcile uncertain outcomes before releasing this workspace.', 'unknown_effect');
    this.store.update('run', task.runID, run => ({ retired: true, retiredAt: this.now(), state: 'Paused', cancelled: true,
      generation: run.generation + 1, reason: 'The user retired this run.' }), 'run_retired');
    return this.status(sessionID);
  }
  async recover() {
    for (const notice of this.store.list('notification').filter(n => n.state !== 'delivered' && this.store.get('task', this.store.get('run', n.runID)?.taskID)?.root === this.root)) {
      try { await this.sendNotification(notice); } catch (error) { this.lastError = errorText(error); }
    }
    for (const run of this.store.list('run').filter(r => !r.retired && ['Working', 'Verifying', 'Paused'].includes(r.state) && this.store.get('task', r.taskID)?.root === this.root)) {
      try {
        this.claim(run.id, { recover: true });
        this.armDeadline(run.taskID);
        if (run.state === 'Paused' && run.stopID && this.store.get('stop', run.stopID)?.state !== 'confirmed')
          await this.requestStop(run.stopID);
        await this.reconcile(run.id);
        const uncertain = this.store.list('dispatch').some(d => d.taskID === run.taskID && ['unknown', 'intended'].includes(d.state)) ||
          this.store.list('action').some(a => a.runID === run.id && a.state === 'unknown');
        if (uncertain) { this.pauseRecord(run.id, 'Recovery found an uncertain consequential outcome.'); continue; }
        if (run.state === 'Paused') continue;
        const sessionID = run.state === 'Verifying' ? run.evaluator : run.worker;
        requireThat(sessionID, 'The native session identity is missing.');
        this.launch(this.drive(sessionID));
      } catch (error) {
        this.lastError = errorText(error);
        if (this.store.get('run', run.id)?.owner === this.owner) this.pauseRecord(run.id, `Recovery needs a decision: ${errorText(error)}`);
      }
    }
    for (const session of this.store.list('session').filter(s => s.role === 'spike' && !s.completed && this.store.get('task', s.taskID)?.root === this.root)) {
      const [host, pid] = (session.owner ?? '').split(':');
      let live = !!session.owner;
      if (host === os.hostname()) { try { process.kill(Number(pid), 0); } catch (error) { if (error.code === 'ESRCH') live = false; } }
      if (live && session.owner !== this.owner) continue;
      this.store.update('session', session.id, () => ({ paused: true, owner: this.owner }), 'spike_recovered_paused');
      for (const action of this.store.list('action').filter(a => a.sessionID === session.id && a.state === 'intended'))
        this.store.update('action', action.id, () => ({ state: 'unknown' }), 'spike_action_unknown');
    }
  }
  findings(task) { return task.findings.map(key => this.store.get('finding', key)); }
  async spike(sessionID, input) {
    const task = this.originOnly(sessionID);
    input = spikeContract(input);
    for (const key of input.evidenceIDs) requireThat(checkEvidence(this.store.get('evidence', key)).taskID === task.id, 'Spike evidence belongs to another task.');
    const parent = await this.native.get(sessionID);
    const existing = this.store.list('spike').find(s => s.taskID === task.id && s.question === input.question && s.state === 'working');
    if (existing) {
      const child = this.session(existing.sessionID);
      requireThat(child.owner === this.owner, 'Another controller owns this investigation.', 'ownership');
      if (!child.paused) return existing;
      this.available(task, { child: true });
      requireThat(task.source?.command === 'spike' || task.source?.allowInvestigation, 'Explicit investigation continuation is required.', 'authority');
      requireThat(!child.writable || parent.agent === 'build' && task.source.agent === 'build', 'Switch to Build and authorize investigation continuation.', 'mode');
      if (await this.native.exists?.(child.id) === false) {
        requireThat(this.neverStarted(child), 'The used investigation conversation is unavailable. Do not replace it silently.', 'missing');
        try { await this.native.authorizeChild?.({ origin: sessionID, agent: parent.agent, target: child.nativeAgent }); }
        catch (error) { await this.pause(sessionID, `Child permission was not established: ${errorText(error)}`, { invalidateSource: true }); throw error; }
        await this.native.create({ id: child.id, parentID: sessionID, agent: child.nativeAgent, model: parent.model,
          title: `Spike: ${input.question}`, permissions: this.permissions('spike') });
        this.store.update('session', child.id, () => ({ created: true }), 'spike_creation_completed');
      }
      await this.native.wait(child.id);
      const messages = await this.native.context(child.id);
      for (const dispatch of this.store.list('dispatch').filter(d => d.sessionID === child.id && ['intended', 'admitted', 'unknown'].includes(d.state))) {
        if (messages.some(m => m.id === dispatch.id)) this.store.update('dispatch', dispatch.id, () => ({ state: 'settled' }), 'spike_dispatch_reconciled');
      }
      requireThat(!this.store.list('dispatch').some(d => d.sessionID === child.id && d.state !== 'settled') &&
        !this.store.list('action').some(a => a.sessionID === child.id && a.state === 'unknown'), 'An investigation outcome remains uncertain.', 'unknown_effect');
      this.store.update('session', child.id, () => ({ paused: false, owner: this.owner }), 'spike_resumed');
      await this.dispatch(child.id, 'The user authorized investigation continuation. Reconcile prior observations. Continue this same question without product implementation.', 'spike_resume');
      this.launch(this.drive(child.id));
      return existing;
    }
    const pending = this.store.list('spike').find(s => s.taskID === task.id && s.question === input.question && s.state === 'pending');
    if (input.writable && parent.agent !== 'build') {
      return pending ?? this.store.put('spike', { id: id('spike'), taskID: task.id, ...input, state: 'pending', source: task.source }, 'write_experiment_pending');
    }
    if (input.writable) {
      requireThat(task.source?.agent === 'build' && (task.source.command === 'spike' || task.source.allowInvestigation),
        'A mode switch does not authorize a write experiment.', 'authority');
      requireThat(this.runner.available(), 'The write experiment requires the supported process boundary.', 'isolation');
    }
    this.available(task, { child: true });
    this.armDeadline(task.id);
    const childAgent = input.writable ? 'build' : 'plan';
    try { await this.native.authorizeChild?.({ origin: sessionID, agent: parent.agent, target: childAgent }); }
    catch (error) { await this.pause(sessionID, `Child permission was not established: ${errorText(error)}`, { invalidateSource: true }); throw error; }
    const latestTask = this.store.get('task', task.id);
    requireThat(latestTask.source?.id === task.source?.id, 'The investigation instruction changed before dispatch.', 'authority');
    this.available(latestTask, { child: true });
    const child = nativeID('ses');
    const record = this.store.put('spike', { ...(pending ?? { id: id('spike') }), taskID: task.id, ...input, sessionID: child,
      sourceIdentity: manifest(this.root).id, state: 'working' }, 'investigation_started');
    const experimentDirectory = path.join(this.store.directory, 'scratch', id('experiment'));
    fs.mkdirSync(experimentDirectory, { mode: 0o700 });
    this.store.put('session', { id: child, taskID: task.id, role: 'spike', spikeID: record.id, writable: !!input.writable,
      root: this.root, experimentDirectory, owner: this.owner, created: false, nativeAgent: childAgent }, 'spike_intended');
    try {
      await this.native.create({ id: child, parentID: sessionID, model: parent.model, title: `Spike: ${input.question}`, agent: childAgent, permissions: this.permissions(input.writable ? 'worker' : 'spike') });
      this.store.update('session', child, () => ({ created: true }), 'spike_created');
    } catch (error) { this.store.update('session', child, () => ({ paused: true, reason: errorText(error) }), 'spike_creation_uncertain'); throw error; }
    await this.dispatch(child, `Investigate this question only: ${JSON.stringify(input)}. Preserve investigation intent. Do not implement the product. Use the managed run action for experiments. Report observations separately from interpretation through finding. Use inconclusive when evidence is insufficient.\n${workerInstructions({ intent: 'investigation', outcome: input.question }, this.findings(task))}`, 'spike');
    this.launch(this.drive(child));
    return record;
  }
  finding(sessionID, input) {
    const session = this.session(sessionID);
    requireThat(session?.role === 'spike' && session.owner === this.owner && !session.completed, 'Only the assigned spike can report a new finding.', 'authority');
    input = findingContract(input);
    const task = this.taskFor(sessionID);
    const references = input.evidenceIDs ?? [];
    for (const key of references) requireThat(this.store.get('evidence', key)?.sessionID === sessionID, 'The finding references foreign evidence.');
    return this.store.transaction(() => {
      const sourceIdentity = manifest(this.root).id;
      const sourceAtStart = this.store.get('spike', session.spikeID).sourceIdentity;
      const finding = this.store.put('finding', { id: id('finding'), taskID: task.id, spikeID: session.spikeID, ...input,
        environment: { hostRuntime: process.version, platform: process.platform }, time: this.now(), sourceIdentity, sourceAtStart,
        sourceChanged: sourceIdentity !== sourceAtStart }, 'finding_reported');
      this.store.update('task', task.id, () => ({ findings: [...task.findings, finding.id] }), 'finding_added');
      this.store.update('session', sessionID, () => ({ completed: true }), 'spike_completed');
      this.store.update('spike', session.spikeID, () => ({ state: 'completed', findingID: finding.id }), 'spike_completed');
      this.launch(this.native.notice(task.origin, `Spike ${input.outcome}: ${input.observations}\nLimitations: ${input.limitations}\nEvidence: ${finding.id}`));
      return finding;
    });
  }
  async decision(sessionID, input) {
    const task = this.originOnly(sessionID);
    input = decisionContract(input);
    const context = await this.native.context(sessionID);
    const source = task.source;
    requireThat(source && context.some(m => m.type === 'user' && m.id === source.id), 'A user decision needs an identifiable source.');
    return this.store.transaction(() => {
      const decision = this.store.put('decision', { id: id('decision'), taskID: task.id, ...input, sourceMessageID: source.id }, 'decision_recorded');
      this.store.update('task', task.id, () => ({ decisions: [...task.decisions, decision.id], readiness: input.status }), 'readiness_changed');
      return decision;
    });
  }
  addEvidence(sessionID, input) {
    const session = this.session(sessionID);
    requireThat(session && input.content !== undefined, 'Evidence content is required.');
    const task = this.taskFor(sessionID);
    const run = (session.runID ?? task.runID) && this.store.get('run', session.runID ?? task.runID);
    const file = evidenceFile(path.join(this.store.directory, 'evidence'), input.content);
    return this.store.put('evidence', { ...file, taskID: task.id, sessionID, runID: run?.id, candidateID: run?.candidate?.id,
      specificationID: run?.specificationID ?? task.specificationID, criterionIDs: input.criterionIDs ?? [], kind: input.kind ?? 'observation', time: this.now() }, 'evidence_collected');
  }
  readEvidence(sessionID, key) {
    const task = this.taskFor(sessionID);
    const evidence = checkEvidence(this.store.get('evidence', key));
    requireThat(evidence.taskID === task.id, 'Evidence belongs to another workflow.', 'authority');
    return { ...evidence, content: fs.readFileSync(evidence.file, 'utf8'), file: undefined };
  }
  async runProcess(sessionID, input, { signal } = {}) {
    const session = this.session(sessionID);
    requireThat(session && ['worker', 'evaluator', 'spike'].includes(session.role), 'Only an assigned child can execute a process.', 'authority');
    const native = await this.native.get(sessionID);
    requireThat(['plan', 'build'].includes(native.agent), 'The assigned process needs an identifiable native Plan or Build capability.', 'mode');
    const readOnlyMode = native.agent === 'plan';
    requireThat(!readOnlyMode || !input.network, 'A Plan session cannot start a network process.', 'mode');
    const task = this.taskFor(sessionID);
    const run = session.runID && this.owned(session.runID);
    if (run) { requireThat(!run.cancelled && ['Working', 'Verifying'].includes(run.state), 'The run is paused.', 'state'); this.checkSpec(run); }
    if (session.role === 'worker') requireThat(run.state === 'Working', 'The worker cannot mutate a candidate during evaluation.', 'state');
    if (session.role === 'worker') manifest(this.root); // Reject pre-existing aliases before writable process dispatch.
    let argv = input.argv;
    let cwd = session.role === 'spike' ? session.experimentDirectory : this.root;
    const validator = input.validatorID && task.specificationID ? this.currentSpec(task).goal.validators.find(v => v.id === input.validatorID) : undefined;
    if (input.validatorID) requireThat(validator, 'The specification does not declare this validator.');
    if (session.role === 'evaluator') {
      requireThat(run.state === 'Verifying' && run.evaluator === sessionID, 'This evaluator is stale.', 'authority');
      requireThat(validator?.argv?.length, 'Use a declared executable validator.', 'authority');
      argv = validator.argv;
      cwd = run.candidate.directory;
    }
    argv = argumentsContract(argv);
    requireThat(session.role !== 'spike' || session.owner === this.owner && !session.completed && !session.paused, 'The spike is not active.', 'state');
    const validatorVersionBefore = validator ? validatorIdentity(cwd, validator) : undefined;
    signal?.throwIfAborted();
    const writable = !readOnlyMode && (session.role === 'worker' || !!session.writable);
    const action = this.store.put('action', { id: id('action'), sessionID, runID: session.runID, taskID: task.id, state: 'intended',
      nativeAgent: native.agent, writable, argvHash: hash(argv), time: this.now() }, 'process_intended');
    try {
      const remaining = this.budget(task)?.deadline ? this.budget(task).deadline - this.now() : Infinity;
      const timeoutMs = Math.min(input.timeoutMs ?? 120000, remaining);
      const result = await this.runner.run({ argv, cwd, project: this.root, readRoots: session.role === 'spike' ? [this.root] : [], writable,
        network: !!input.network, signal, owner: session.runID ?? sessionID, timeoutMs,
        onSpawn: identity => this.store.update('action', action.id, () => ({ process: identity }), 'process_identity_recorded') });
      const criterionIDs = input.validatorID && task.specificationID ? this.currentSpec(task).goal.criteria.filter(c => c.validatorIDs.includes(input.validatorID)).map(c => c.id) : [];
      const evidence = this.addEvidence(sessionID, { content: result, criterionIDs, kind: input.validatorID ? 'validator-execution' : 'process' });
      this.store.update('evidence', evidence.id, () => ({ validatorID: input.validatorID, validatorVersionBefore,
        validatorVersionAfter: validator ? validatorIdentity(cwd, validator) : undefined,
        result: { code: result.code, interrupted: result.interrupted } }), 'execution_associated');
      // Local interrupted work is inspectable inside the enforced file boundary.
      // Network work can leave an external effect that a process receipt cannot settle.
      const uncertain = !!input.network && (result.interrupted || result.code !== 0);
      this.store.update('action', action.id, () => ({ state: uncertain ? 'unknown' : 'settled', evidenceID: evidence.id, completionReceived: true }), 'process_received');
      const stopID = run && this.store.get('run', run.id).stopID;
      const stop = stopID && this.store.get('stop', stopID);
      if (stop?.nativeStopped && !this.store.list('action').some(a => a.runID === run.id && ['intended', 'unknown'].includes(a.state) && !a.completionReceived))
        this.store.update('stop', stop.id, () => ({ state: 'confirmed', processesStopped: true, observedAt: this.now() }), 'process_stop_confirmed');
      if (uncertain && run) this.pauseRecord(run.id, 'A process stopped with an uncertain effect.');
      if (uncertain && session.role === 'spike') this.store.update('session', sessionID, () => ({ paused: true }), 'spike_effect_unknown');
      return { ...result, evidenceID: evidence.id };
    } catch (error) {
      this.store.update('action', action.id, () => ({ state: error.code === 'isolation' ? 'no-effect' : 'unknown' }), 'process_failed');
      if (run) this.pauseRecord(run.id, `Process execution stopped: ${errorText(error)}`);
      if (session.role === 'spike') this.store.update('session', sessionID, () => ({ paused: true, reason: errorText(error) }), 'spike_process_stopped');
      throw error;
    }
  }
  async candidate(sessionID, input) {
    const session = this.session(sessionID);
    requireThat(session?.role === 'worker', 'Only the assigned worker can submit a candidate.', 'authority');
    let run = this.owned(session.runID);
    requireThat(run.state === 'Working' && !run.cancelled, 'The run is not working.', 'state');
    const spec = this.checkSpec(run);
    for (const validator of spec.goal.validators) {
      const refs = input.readiness?.[validator.id];
      requireThat(Array.isArray(refs) && refs.length, `Missing readiness evidence for ${validator.id}.`, 'readiness');
      const records = [];
      const version = validatorIdentity(this.root, validator);
      for (const key of refs) {
        const evidence = checkEvidence(this.store.get('evidence', key));
        requireThat(evidence.runID === run.id && evidence.sessionID === sessionID && evidence.specificationID === spec.id, 'Readiness evidence belongs to another run or specification.');
        records.push(evidence);
      }
      if (validator.argv) requireThat(records.some(e => e.validatorID === validator.id && e.validatorVersionBefore === version &&
        e.validatorVersionAfter === version && e.result && !e.result.interrupted),
        `Readiness for ${validator.id} needs actual procedure execution for its current version.`, 'readiness');
    }
    run = this.store.update('run', run.id, () => ({ state: 'Verifying' }), 'candidate_capture_started');
    try {
      this.runner.stop(run.id);
      requireThat(!this.store.list('action').some(a => a.runID === run.id && ['intended', 'unknown'].includes(a.state)), 'An action outcome needs reconciliation.', 'unknown_effect');
      const candidate = capture(this.root, path.join(this.store.directory, 'candidates', id('candidate')));
      const evaluator = nativeID('ses');
      const validatorVersions = Object.fromEntries(spec.goal.validators.map(v => [v.id, validatorIdentity(candidate.directory, v)]));
      this.store.update('run', run.id, () => ({ candidate, evaluator, readiness: input.readiness ?? {}, validatorVersions,
        validatorVersion: hash(validatorVersions) }), 'candidate_captured');
      this.store.put('session', { id: evaluator, taskID: run.taskID, runID: run.id, role: 'evaluator', root: candidate.directory, created: false }, 'evaluator_intended');
      await this.native.authorizeChild?.({ origin: this.store.get('task', run.taskID).origin, agent: 'build', target: 'build' });
      // Keep the location-scoped plugin active. The evaluator's file boundary is the captured candidate.
      await this.native.create({ id: evaluator, parentID: this.store.get('task', run.taskID).origin, model: run.model, agent: 'build', title: 'Prometheus: independent evaluation', permissions: this.permissions('evaluator') });
      this.store.update('session', evaluator, () => ({ created: true }), 'evaluator_created');
      await this.dispatch(evaluator, evaluatorInstructions(spec.goal, candidate, input.readiness), 'evaluation');
      this.launch(this.drive(evaluator));
      return { candidateID: candidate.id, evaluator, state: 'Verifying' };
    } catch (error) { this.pauseRecord(run.id, `Candidate evaluation stopped: ${errorText(error)}`); throw error; }
  }
  async evaluate(sessionID, input) {
    const session = this.session(sessionID);
    requireThat(session?.role === 'evaluator', 'Only an independent evaluator can report acceptance.', 'authority');
    const run = this.owned(session.runID);
    requireThat(run.state === 'Verifying' && run.evaluator === sessionID && !run.cancelled, 'This evaluation is stale or paused.', 'state');
    const spec = this.checkSpec(run);
    requireThat(manifest(run.candidate.directory).id === run.candidate.id, 'The captured candidate changed.', 'candidate_changed');
    const results = evaluationContract(spec.goal, input.results);
    for (const result of results) {
      const criterion = spec.goal.criteria.find(c => c.id === result.id);
      for (const key of result.evidenceIDs) {
        const evidence = checkEvidence(this.store.get('evidence', key));
        requireThat(evidence.runID === run.id && evidence.candidateID === run.candidate.id, 'Evidence does not identify this candidate.', 'evidence');
        requireThat(evidence.specificationID === spec.id && evidence.criterionIDs.includes(criterion.id), 'Evidence does not identify this criterion and specification.', 'evidence');
        if (criterion.owner === 'evaluator') requireThat(evidence.sessionID === sessionID, 'Worker assertions cannot establish acceptance.', 'evidence');
        else requireThat(evidence.kind === `${criterion.owner}-acceptance` && this.session(evidence.sessionID)?.role === 'origin', 'External acceptance is not established.', 'evidence');
      }
      if (result.status === 'pass') {
        requireThat(result.evidenceIDs.length, 'A pass requires evidence.', 'evidence');
        for (const key of criterion.validatorIDs) {
          const validator = spec.goal.validators.find(v => v.id === key);
          if (validator.argv) requireThat(result.evidenceIDs.some(e => {
            const record = this.store.get('evidence', e);
            return record.validatorID === key && record.validatorVersionBefore === run.validatorVersions[key] &&
              record.validatorVersionAfter === run.validatorVersions[key] && record.result?.code === 0 && !record.result.interrupted;
          }), `A passing execution of ${key} is required.`, 'evidence');
        }
      }
    }
    const accepted = results.every(r => r.status === 'pass');
    const needsExternal = results.some(r => r.status === 'unresolved' && spec.goal.criteria.find(c => c.id === r.id).owner !== 'evaluator');
    if (accepted) requireThat(manifest(this.root).id === run.candidate.id, 'Delivered artifacts differ from the accepted candidate.', 'candidate_changed');
    let notification;
    this.store.transaction(() => {
      const current = this.owned(run.id);
      requireThat(current.state === 'Verifying' && !current.cancelled && current.generation === run.generation &&
        current.evaluator === sessionID && current.specificationID === spec.id && current.candidate?.id === run.candidate.id,
      'The evaluation no longer owns this candidate.', 'state');
      this.store.put('evaluation', { id: id('evaluation'), runID: run.id, evaluator: sessionID, candidateID: run.candidate.id,
        specificationID: spec.id, validatorVersion: run.validatorVersion, results, time: this.now() }, 'evaluation_reported');
      if (accepted) {
        this.store.update('run', run.id, () => ({ state: 'Accepted', accepted: this.now(), delivery: this.root }), 'accepted');
        notification = this.store.put('notification', { id: nativeID('msg'), runID: run.id, state: 'intended',
          sessionID: this.store.get('task', run.taskID).origin,
          text: `Accepted: ${spec.goal.outcome}\nCandidate: ${run.candidate.id}\nDelivery: ${this.root}\nEvery required criterion passed. No deployment or publication was implied.` }, 'acceptance_notification_intended');
      } else if (!needsExternal) this.store.update('run', run.id, () => ({ state: 'Working' }), 'repair_requested');
    });
    if (accepted) {
      await this.sendNotification(notification);
    } else if (needsExternal) {
      this.pauseRecord(run.id, `Evaluation needs evidence: ${results.filter(r => r.status === 'unresolved').map(r => r.id).join(', ')}`);
    } else {
      await this.dispatch(run.worker, `Independent evaluation rejected acceptance. Repair failures or collect missing evidence in this same worker. Preserve acceptance meaning.\n${JSON.stringify(results)}`, 'repair');
      this.launch(this.drive(run.worker));
    }
    return { state: this.store.get('run', run.id).state, results };
  }
  async sendNotification(notice) {
    await this.native.notice(notice.sessionID, notice.text, notice.id);
    return this.store.update('notification', notice.id, () => ({ state: 'delivered' }), 'acceptance_notification_delivered');
  }
  status(sessionID) {
    const task = this.taskFor(sessionID);
    const run = task.runID && this.store.get('run', task.runID);
    const current = run?.specificationID === task.specificationID;
    const preparation = !run || !current && (run.state === 'Accepted' || run.retired);
    let acceptanceCurrent;
    if (run?.state === 'Accepted' && current) {
      try { acceptanceCurrent = manifest(this.root).id === run.candidate?.id; } catch { acceptanceCurrent = false; }
    }
    return { version: VERSION, nativeVersion: this.nativeVersion, runtimeDirectory: this.store.directory, processBoundaryAvailable: this.runner.available(), taskID: task.id, intent: task.specificationID ? this.currentSpec(task).goal.intent : 'preparation',
      specificationID: task.specificationID, state: acceptanceCurrent === false ? 'Draft' : preparation ? task.preparationPaused ? 'Paused' : 'Draft' : run.state,
      acceptanceCurrent, stop: run?.stopID ? this.store.get('stop', run.stopID) : undefined,
      retired: current && !!run?.retired,
      reason: acceptanceCurrent === false ? 'Artifacts changed after acceptance. A new evaluation is required.' : preparation ? task.preparationPauseReason : run?.reason,
      worker: preparation ? undefined : run?.worker,
      evaluator: preparation ? undefined : run?.evaluator, candidateID: current ? run?.candidate?.id : undefined,
      lastRun: run ? { id: run.id, state: run.state, retired: !!run.retired, specificationID: run.specificationID } : undefined,
      requests: task.requests, limits: this.budget(task), costUSD: task.costUSD, costUncertain: task.costUncertain,
      costLimitIsEstimate: true, findings: this.findings(task),
      decisions: task.decisions.map(key => this.store.get('decision', key)),
      preparedGoal: task.specificationID ? this.currentSpec(task).goal : undefined,
      spikes: this.store.list('spike').filter(s => s.taskID === task.id),
      uncertainActions: this.store.list('action').filter(a => a.taskID === task.id && ['unknown', 'intended'].includes(a.state)),
      uncertainDispatches: this.store.list('dispatch').filter(d => d.taskID === task.id && ['unknown', 'intended'].includes(d.state)), lastError: this.lastError };
  }
  rootFor(sessionID) { return this.session(sessionID)?.root ?? this.root; }
  checkTool(event) {
    const session = this.session(event.sessionID);
    if (!session) return;
    if (event.tool === 'prometheus_control') return;
    const write = ['patch', 'edit', 'write'].includes(event.tool);
    requireThat(!write, 'Use the managed process action for file mutations.', 'boundary');
    requireThat(['read', 'glob', 'grep', 'question', 'webfetch', 'websearch'].includes(event.tool), 'Use a permitted native tool or the managed Prometheus process action.', 'boundary');
    if (['webfetch', 'websearch'].includes(event.tool)) return;
    const input = event.input ?? {};
    if (event.tool === 'glob') requireThat(typeof input.pattern === 'string' && !path.isAbsolute(input.pattern) &&
      !input.pattern.split(/[\\/]/).includes('..'), 'The glob pattern leaves the authorized directory.', 'boundary');
    let paths = [input.path, input.filePath].filter(v => typeof v === 'string');
    if (!paths.length && ['glob', 'grep'].includes(event.tool)) paths = ['.'];
    requireThat(event.tool === 'question' || paths.length, 'The tool path cannot be assessed.', 'boundary');
    const resolved = paths.map(value => localPath(this.rootFor(event.sessionID), value));
    if (event.tool === 'grep') requireThat(resolved.every(file => fs.statSync(file).isFile()),
      'Use a managed read-only process for recursive content searches. Native grep requires one assessed file.', 'boundary');
    if (session.role === 'evaluator') {
      // Native relative paths otherwise resolve against the originating project's location.
      if (typeof input.path === 'string' || ['glob', 'grep'].includes(event.tool)) input.path = resolved[0];
      if (typeof input.filePath === 'string') input.filePath = resolved[0];
    }
  }
  async close() {
    this.closed = true;
    for (const timer of this.deadlines.values()) clearTimeout(timer);
    for (const run of this.store.list('run').filter(r => r.owner === this.owner && ['Working', 'Verifying'].includes(r.state)))
      this.pauseRecord(run.id, 'The plugin unloaded. Reconcile activity before resuming.');
    for (const session of this.store.list('session').filter(s => s.role === 'spike' && s.owner === this.owner && !s.completed)) {
      this.store.update('session', session.id, () => ({ paused: true, owner: null }), 'spike_unloaded');
      this.runner.stop(session.id);
    }
    await Promise.allSettled([...this.driving].map(key => this.native.interrupt(key)));
    await Promise.allSettled([...this.background]);
    for (const run of this.store.list('run').filter(r => r.owner === this.owner))
      this.store.update('run', run.id, () => ({ owner: null }), 'owner_released');
  }
}
