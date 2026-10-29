import { canonical, id, requireThat } from './util.mjs';
import { manifest, candidatePaths } from './artifacts.mjs';
import { criteriaContract, text } from './contracts.mjs';
import { nativeEvidence, selectEvidence } from './native.mjs';
import { evaluatorInstructions } from './prompts.mjs';

// This is a bounded verification request, not an execution or repair controller.
export class Verification {
  constructor(ctx, records) {
    this.ctx = ctx;
    this.records = records;
    this.boot = id('boot');
    this.active = new Map();
    this.closed = false;
  }
  async get(verificationID) {
    const record = await this.ctx.storage.get(`v2/verification/${verificationID}`);
    requireThat(record, 'Unknown verification.');
    return record;
  }
  async save(record) {
    await this.ctx.storage.set(`v2/verification/${record.id}`, record);
    return record;
  }
  async identity(root, context) {
    const files = candidatePaths(root);
    if (files.length) await this.ctx.permission.assert({ sessionID: context.sessionID, agent: context.agent,
      source: { type: 'tool', messageID: context.messageID, id: context.id }, action: 'read', resources: files, save: [] });
    context.signal?.throwIfAborted();
    const permitted = new Set(files);
    return manifest(root, { beforeRead: file => requireThat(permitted.has(file), 'Candidate paths changed during permission admission. Request verification again.', 'candidate_changed') });
  }
  async execute(action, data, context) {
    if (action === 'start') return this.start(data, context);
    if (action === 'report') return this.report(data, context);
    requireThat(action === 'status', 'Unknown verification action.');
    const verificationID = data.verificationID ?? await this.ctx.storage.get(`v2/latest/${context.sessionID}`);
    if (!verificationID) return { status: 'none', legacy: this.records.legacy() };
    const record = await this.get(verificationID);
    requireThat([record.origin, record.evaluator].includes(context.sessionID), 'This verification belongs to another session.');
    requireThat(canonical(record.root) === canonical(this.ctx.location.directory), 'Return to the verification workspace before inspecting its candidate.');
    return this.records.serial(record.id, async () => {
      const current = await this.get(record.id);
      if (current.boot !== this.boot && ['starting', 'pending'].includes(current.status)) {
        current.status = 'interrupted';
        current.reason = 'The plugin reloaded or the service restarted. Request a new verification explicitly.';
        await this.save(current);
      }
      if (current.status === 'accepted' && (await this.identity(current.root, context)).id !== current.candidate.id)
        return { ...current, status: 'changed', reason: 'The current files differ from the accepted candidate.' };
      return current;
    });
  }
  async start(data, context) {
    requireThat(!this.closed, 'The verification service is stopping.');
    requireThat(!await this.ctx.storage.get(`v2/evaluator/${context.sessionID}`), 'An evaluator cannot start another verification. Return results to the origin.');
    const origin = await this.ctx.session.get({ sessionID: context.sessionID });
    requireThat(canonical(origin.location.directory) === canonical(this.ctx.location.directory), 'Return to the session’s location before requesting verification.');
    requireThat(origin.agent === 'build', 'Switch to Build before requesting independent verification. A Plan session cannot start a Build evaluator.', 'mode');
    const criteria = criteriaContract(data.criteria);
    context.signal?.throwIfAborted();
    // Use the same native permission action as normal delegation. Never grant it here.
    await this.ctx.permission.assert({ sessionID: origin.id, agent: origin.agent,
      source: { type: 'tool', messageID: context.messageID, id: context.id },
      action: 'subagent', resources: ['build'], save: [] });
    context.signal?.throwIfAborted();
    return this.records.serial(`origin/${origin.id}`, async () => {
      const latest = await this.ctx.storage.get(`v2/latest/${origin.id}`);
      if (latest) {
        const previous = await this.get(latest);
        requireThat(previous.boot !== this.boot || !['starting', 'pending'].includes(previous.status), 'A verification is already pending.');
      }
      requireThat(!this.closed, 'The verification service is stopping.');
      const root = canonical(this.ctx.location.directory);
      const record = { id: id('verification'), origin: origin.id, root, criteria,
        candidate: await this.identity(root, context), status: 'starting', boot: this.boot, created: Date.now() };
      await this.save(record);
      await this.ctx.storage.set(`v2/latest/${origin.id}`, record.id);
      this.active.set(record.id, record);
      try {
        context.signal?.throwIfAborted();
        const child = await this.ctx.session.create({ parentID: origin.id, location: origin.location, agent: 'build', model: origin.model,
          title: 'Prometheus: independent verification', permissions: origin.permissions ?? [] });
        record.evaluator = child.id;
        await this.ctx.storage.set(`v2/evaluator/${child.id}`, record.id);
        await this.ctx.storage.set(`v2/latest/${child.id}`, record.id);
        if (this.closed || !this.active.has(record.id)) {
          // Cancellation can arrive while native child creation is in flight.
          await this.ctx.session.interrupt({ sessionID: child.id, resume: false });
          throw new Error('Verification was interrupted.');
        }
        context.signal?.throwIfAborted();
        record.status = 'pending';
        await this.save(record);
        // One native admission. OpenCode runs the child; Prometheus does not drive it.
        await this.ctx.session.synthetic({ sessionID: child.id, text: evaluatorInstructions(record),
          metadata: { source: 'prometheus-verification', verificationID: record.id }, delivery: 'queue' });
        // Keep the originating tool pending through native evaluation, just as
        // ordinary delegation does. Native /goal must not review an unfinished
        // verification as if the origin had completed its work.
        await this.ctx.session.wait({ sessionID: child.id }, { signal: context.signal });
        return await this.get(record.id);
      } catch (error) {
        await this.interrupt(record, `Verification did not start reliably: ${error.message}`);
        throw error; // A lost receipt must not cause automatic replay.
      }
    });
  }
  async report(data, context) {
    const verificationID = text(data.verificationID, 'Verification identity');
    return this.records.serial(verificationID, async () => {
      const record = await this.get(verificationID);
      requireThat(!this.closed && record.boot === this.boot && this.active.has(record.id) && record.status === 'pending', 'This verification is interrupted, stale, or already reported.');
      requireThat(record.evaluator === context.sessionID, 'Only the assigned evaluator can report acceptance.', 'authority');
      requireThat(canonical(record.root) === canonical(this.ctx.location.directory), 'Return to the verification workspace before reporting.');
      requireThat((await this.identity(record.root, context)).id === record.candidate.id, 'The candidate changed. Request a new verification.', 'candidate_changed');
      requireThat(Array.isArray(data.results) && data.results.length === record.criteria.length, 'Report every criterion exactly once.');
      requireThat(new Set(data.results.map(result => result.id)).size === data.results.length, 'Duplicate criterion result.');
      const messages = await this.ctx.session.context({ sessionID: record.evaluator });
      const results = record.criteria.map(criterion => {
        const result = data.results.find(item => item.id === criterion.id);
        requireThat(result && ['pass', 'fail', 'unresolved'].includes(result.status), `Missing or invalid result for ${criterion.id}.`);
        const evidence = selectEvidence(messages, result.evidence ?? []);
        requireThat(result.status !== 'pass' || evidence.length, 'A pass requires completed native tool evidence.');
        return { id: criterion.id, status: result.status, explanation: text(result.explanation, 'Explanation'), evidence };
      });
      context.signal?.throwIfAborted();
      requireThat(this.active.has(record.id) && !this.closed, 'Verification was interrupted.');
      requireThat((await this.identity(record.root, context)).id === record.candidate.id, 'The candidate changed during evaluation.', 'candidate_changed');
      requireThat(this.active.has(record.id) && !this.closed, 'Verification was interrupted.');
      const status = results.every(result => result.status === 'pass') ? 'accepted' : results.some(result => result.status === 'fail') ? 'failed' : 'unresolved';
      const report = { ...record, status, results, reported: Date.now() };
      await this.save(report);
      if (!this.active.has(record.id) || this.closed) return { ...report, status: 'interrupted' };
      this.active.delete(record.id);
      // A notice is not permission to resume work or a goal. Persist the report before delivery.
      try {
        await this.ctx.session.synthetic({ sessionID: record.origin, resume: false,
          text: `Prometheus verification ${record.id}: ${status}.\n${JSON.stringify({ candidateID: record.candidate.id, results })}` });
      } catch (error) {
        report.noticeError = error.message;
        await this.save(report);
      }
      return report;
    });
  }
  async context(event) {
    const verificationID = await this.ctx.storage.get(`v2/evaluator/${event.sessionID}`);
    if (!verificationID) return;
    const record = await this.get(verificationID);
    if (record.boot !== this.boot || record.status !== 'pending') return;
    const evidence = nativeEvidence(await this.ctx.session.context({ sessionID: event.sessionID }));
    event.system.push({ type: 'text', text: `Independent Prometheus evaluator. Do not repair files. Report through prometheus_verify.\nVerification: ${record.id}\nCompleted native evidence references: ${JSON.stringify(evidence.map(({ messageID, toolCallID, tool, hash }) => ({ messageID, toolCallID, tool, hash })))}` });
  }
  async interrupt(record, reason, { waitForInterrupt = true } = {}) {
    if (!this.active.delete(record.id)) return;
    await this.records.serial(record.id, async () => {
      await this.save({ ...record, status: 'interrupted', reason });
    });
    if (!record.evaluator) return;
    const interrupting = this.ctx.session.interrupt({ sessionID: record.evaluator, resume: false }).catch(async error => {
      try { await this.save({ ...record, status: 'interrupted', reason, interruptError: error.message }); }
      catch { /* The host can close storage during shutdown. Never restart work. */ }
    });
    // The native execution can hold the location being unloaded. Do not join its
    // shutdown from that location's finalizer; let OpenCode finish cancellation.
    if (waitForInterrupt) await interrupting;
  }
  async observe(event) {
    for (const record of [...this.active.values()]) {
      if (event.type === 'session.execution.succeeded') {
        if (record.evaluator !== event.data.sessionID) continue;
        await this.records.serial(record.id, async () => {
          if (!this.active.delete(record.id)) return;
          const report = { ...record, status: 'unresolved', reason: 'The evaluator finished without a criterion report.' };
          await this.save(report);
          try {
            await this.ctx.session.synthetic({ sessionID: record.origin, resume: false,
              text: `Prometheus verification ${record.id}: unresolved. ${report.reason}` });
          } catch (error) { await this.save({ ...report, noticeError: error.message }); }
        });
        continue;
      }
      if ([record.origin, record.evaluator].includes(event.data.sessionID))
        await this.interrupt(record, event.type === 'session.deleted' ? 'A participating session was deleted.' : 'Native execution stopped. Request a new verification explicitly.');
    }
  }
  async stop(reason, options) {
    this.closed = true;
    await Promise.all([...this.active.values()].map(record => this.interrupt(record, reason, options)));
  }
}
