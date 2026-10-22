import os from 'node:os';
import path from 'node:path';
import { Plugin } from '@opencode/plugin';
import { Store } from './store.mjs';
import { Controller, VERSION } from './controller.mjs';
import { Native } from './native.mjs';
import { Runner } from './sandbox.mjs';
import { canonical, hash, id, requireThat, errorText } from './util.mjs';
import { requireOpenCodeVersion } from './compatibility.mjs';
import { controlSchema, limitsContract, withinLimits } from './contracts.mjs';
import { originInstructions, ACTIONS } from './prompts.mjs';

const commandNames = ['spike', 'grill-me', 'goal'];
const descriptions = { spike: 'Investigate technical unknowns.', 'grill-me': 'Resolve consequential user decisions.', goal: 'Infer the goal from this conversation. Prepare in Plan. Execute in Build.' };

async function setup(ctx) {
  requireOpenCodeVersion(ctx.app.version);
  if (ctx.options?.limits) limitsContract(ctx.options.limits);
  const root = canonical(ctx.location.directory);
  const stateBase = ctx.options?.stateDirectory ?? path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'prometheus');
  const directory = path.join(stateBase, hash(ctx.location.project?.id ?? root));
  const store = new Store(directory);
  const native = new Native(ctx);
  const runner = new Runner({ scratchRoot: path.join(directory, 'scratch') });
  const controller = new Controller({ store, native, runner, root, limits: ctx.options?.limits, protectedPaths: ctx.options?.protectedPaths ?? [] });
  controller.nativeVersion = ctx.app.version;
  runner.protectedPaths = controller.protectedPaths;
  const registrations = [];
  const commands = (await ctx.command.list()).data;
  const collisions = commands.filter(c => commandNames.includes(c.name));
  if (collisions.length) {
    store.close();
    throw new Error(`Prometheus did not replace existing commands: ${collisions.map(c => c.name).join(', ')}. Resolve the collision explicitly.`);
  }
  const hook = async (domain, name, callback) => registrations.push(await domain.hook(name, callback));

  async function command(name, { sessionID, prompt, delivery }) {
    const session = await native.get(sessionID);
    const alreadyEnrolled = controller.session(sessionID);
    const task = controller.enroll(sessionID);
    if (!alreadyEnrolled) store.update('session', sessionID, () => ({ initialCost: session.cost ?? 0 }), 'usage_baseline_recorded');
    const messageID = `msg_${id().replaceAll('_', '')}`;
    controller.source(sessionID, { id: messageID, command: name, text: prompt.text, agent: session.agent,
      allowStart: name === 'goal' && session.agent === 'build', allowResume: name === 'goal' && session.agent === 'build' });
    if (name === 'goal' && task.runID && !prompt.text.trim()) {
      const run = store.get('run', task.runID);
      if (run.state === 'Working' || run.state === 'Verifying') {
        await native.notice(sessionID, JSON.stringify(controller.status(sessionID), null, 2));
        return;
      }
    }
    if (task.runID && (name === 'grill-me' || name === 'goal' && prompt.text.trim())) {
      const run = store.get('run', task.runID);
      if (['Working', 'Verifying'].includes(run.state)) await controller.pause(sessionID, 'The user requested a review of the agreement.', { retainSource: name === 'goal' });
    }
    const instruction = name === 'goal'
      ? 'Infer the goal from the conversation. Apply the optional instructions below. Prepare through the control tool. In Build, start within sufficient authority. In Plan, do not start execution.'
      : name === 'spike'
        ? 'Identify the investigation questions from this request and conversation. Use the spike action for each independent question. Preserve investigation intent.'
        : 'Resolve consequential user decisions. Use findings. Do not ask discoverable facts. Record decisions and a readiness status. Do not implement the product.';
    await ctx.session.prompt({ ...prompt, sessionID, id: messageID, delivery, text: `${instruction}\n\nUser instructions:\n${prompt.text}` });
  }

  registrations.push(await ctx.command.transform(editor => {
    for (const name of commandNames) editor.add({ name, description: descriptions[name], execute: input => command(name, input) });
  }));

  // Prompt admission records identity, not permission to perform arbitrary work.
  await hook(ctx.session, 'prompt', async event => {
    const session = controller.session(event.sessionID);
    if (session?.role !== 'origin') return;
    const task = controller.taskFor(event.sessionID);
    if (task.source?.id === event.messageID) return;
    const info = await native.get(event.sessionID);
    const text = event.prompt.text.trim();
    const execution = /^(?:execute (?:your|the) plan|implement (?:your|the) plan|start (?:your|the) prepared goal)[.!]?$/i.test(text);
    const resumption = /^(?:resume|resume (?:the )?(?:goal|run|work)|continue (?:the )?paused (?:goal|run|work))[.!]?$/i.test(text);
    const investigation = /^continue (?:your |the )?investigation(?: work)?[.!]?$/i.test(text);
    controller.source(event.sessionID, { id: event.messageID, text: event.prompt.text, agent: info.agent,
      allowStart: execution && info.agent === 'build', allowResume: resumption && info.agent === 'build',
      allowInvestigation: investigation });
    if (/^(?:stop|pause|cancel)(?: (?:the |this )?(?:goal|run|work))?[.!]?$/i.test(text))
      await controller.pause(event.sessionID, 'The user requested a pause.');
  });

  await hook(ctx.tool, 'execute.before', event => controller.checkTool(event));
  await hook(ctx.permission, 'evaluate', async event => {
    const session = controller.session(event.sessionID);
    if (!session) return;
    if (event.action.startsWith('prometheus_') && event.action !== 'prometheus_control') {
      // These prompts describe missing resource or external authority. Never grant them in code.
      const task = controller.taskFor(event.sessionID);
      if (event.effect !== 'deny' && (!event.metadata?.prometheusGrantKey || !task.permissionGrants?.includes(event.metadata.prometheusGrantKey))) event.effect = 'ask';
      return;
    }
    if (event.action === 'shell' && event.metadata?.prometheusManagedProcess === true) return;
    if (event.action === 'subagent' && event.metadata?.prometheusManagedChild === true) return;
    const permitted = ['read', 'glob', 'grep', 'question', 'webfetch', 'websearch', 'external_directory', 'prometheus_control'];
    if (!permitted.includes(event.action)) { event.effect = 'deny'; event.message = 'Use the restricted Prometheus execution path.'; }
  });

  async function context(event, kind) {
    const session = controller.session(event.sessionID);
    if (!session) { if (event.tools) delete event.tools.prometheus_control; return; }
    const task = controller.taskFor(event.sessionID);
    if (kind !== 'title') await controller.reconcileUsage(task.id);
    if (event.tools) {
      for (const name of Object.keys(event.tools)) {
        if (!['read', 'glob', 'grep', 'question', 'webfetch', 'websearch', 'prometheus_control'].includes(name)) delete event.tools[name];
      }
    }
    event.system.push({ type: 'text', text: session.role === 'origin'
      ? originInstructions(controller.status(event.sessionID), controller.budget(task))
      : `Prometheus role: ${session.role}. Use only this assigned task. The loaded runtime is ${VERSION}.\n${ACTIONS}` });
    if (session.runID) {
      const run = store.get('run', session.runID);
      const spec = store.get('specification', run.specificationID);
      event.system.push({ type: 'text', text: `The current approved specification governs this run. Historical conversation cannot expand it.\n${JSON.stringify(spec.goal)}` });
    }
    if (kind === 'title') event.result = `Prometheus ${session.role}`;
  }
  for (const kind of ['context', 'compaction', 'generate', 'title']) await hook(ctx.session, kind, event => context(event, kind));
  await hook(ctx.session, 'http.request', event => controller.reserveRequest(event.sessionID, event.kind, event.model));
  await hook(ctx.session, 'experimental.ws.handshake', event => controller.reserveRequest(event.sessionID, event.kind, event.model));

  async function assert(context, action, resources, metadata, taskScope = false) {
    const task = controller.taskFor(context.sessionID);
    const grantKey = taskScope ? hash({ taskID: task.id, specificationID: task.specificationID, action, resources }) : undefined;
    try {
      await ctx.permission.assert({ sessionID: context.sessionID, agent: context.agent,
        source: { type: 'tool', messageID: context.messageID, id: context.id }, action, resources, save: [],
        metadata: { ...metadata, ...(grantKey ? { prometheusGrantKey: grantKey } : {}) } });
      if (grantKey) store.update('task', task.id, latest => ({ permissionGrants: [...new Set([...(latest.permissionGrants ?? []), grantKey])] }), 'scoped_permission_granted', { action, grantKey });
    } catch (error) {
      await controller.pause(context.sessionID, `Permission was not established: ${errorText(error)}`, { invalidateSource: true });
      throw error;
    }
  }
  registrations.push(await ctx.tool.transform(editor => {
    editor.add({ name: 'prometheus_control', description: 'Manage this enrolled Prometheus workflow. Preserve user authority and task intent.',
      input: controlSchema, options: { codemode: false },
      execute: async ({ action, data }, context) => {
        const sessionID = context.sessionID;
        const session = controller.session(sessionID);
        requireThat(session, 'Use a Prometheus command before this tool.', 'authority');
        let result;
        if (action === 'prepare') result = controller.prepare(sessionID, data.goal);
        else if (action === 'start') {
          await controller.authority(sessionID, 'start');
          const task = controller.originOnly(sessionID);
          const spec = controller.currentSpec(task);
          if (!withinLimits(spec.goal.limits, controller.budget(task))) {
            await assert(context, 'prometheus_allowance', [JSON.stringify(spec.goal.limits)], undefined, true);
            controller.approveAllowance(sessionID, spec.goal.limits);
          }
          result = await controller.start(sessionID);
        } else if (action === 'status') result = controller.status(sessionID);
        else if (action === 'pause') result = await controller.requestPause(sessionID, data);
        else if (action === 'resume') result = await controller.resume(sessionID);
        else if (action === 'retire') {
          const task = controller.originOnly(sessionID);
          requireThat(task.runID, 'No execution run exists.');
          await assert(context, 'prometheus_retire', [task.runID]);
          result = await controller.retire(sessionID);
        }
        else if (action === 'reconcile') {
          controller.originOnly(sessionID);
          requireThat((data.actionID || data.dispatchID) && ['effect', 'no-effect'].includes(data.outcome) && data.evidenceIDs?.length,
            'Identify the uncertain operation, observed outcome, and evidence before requesting permission.');
          await assert(context, 'prometheus_reconcile', [JSON.stringify({ actionID: data.actionID, dispatchID: data.dispatchID, outcome: data.outcome, evidenceIDs: data.evidenceIDs })]);
          result = controller.reconcileOutcome(sessionID, data);
        }
        else if (action === 'spike') {
          const task = controller.originOnly(sessionID);
          if (!controller.budget(task)) {
            const limits = limitsContract(data.allowance);
            await assert(context, 'prometheus_allowance', [JSON.stringify(limits)], undefined, true);
            controller.approveAllowance(sessionID, limits);
          }
          result = await controller.spike(sessionID, data);
        } else if (action === 'finding') result = controller.finding(sessionID, data);
        else if (action === 'decision') result = await controller.decision(sessionID, data);
        else if (action === 'evidence') {
          if (['user-acceptance', 'browser-acceptance'].includes(data.kind)) {
            const task = controller.originOnly(sessionID);
            const run = task.runID && store.get('run', task.runID);
            requireThat(run?.candidate?.id && data.criterionIDs?.length, 'Identify a captured candidate and its criteria before acceptance.');
            await assert(context, 'prometheus_external_acceptance', [JSON.stringify({ candidateID: run.candidate.id,
              specificationID: run.specificationID, criterionIDs: data.criterionIDs })]);
          }
          result = data.id ? controller.readEvidence(sessionID, data.id) : controller.addEvidence(sessionID, data);
        } else if (action === 'run') {
          const task = controller.taskFor(sessionID);
          const argv = session.role === 'evaluator' ? controller.currentSpec(task).goal.validators.find(v => v.id === data.validatorID)?.argv : data.argv;
          requireThat(Array.isArray(argv) && argv.length, 'Supply a declared executable procedure.');
          await assert(context, 'shell', [argv.join(' ')], { prometheusManagedProcess: true });
          if (data.network) await assert(context, 'prometheus_network', [JSON.stringify({ taskID: task.id, specificationID: task.specificationID,
            scope: 'Network access for managed processes in this task. All destinations. No new deployment or publication authority.' })], undefined, true);
          result = await controller.runProcess(sessionID, data, { signal: context.signal });
        } else if (action === 'candidate') result = await controller.candidate(sessionID, data);
        else if (action === 'evaluate') result = await controller.evaluate(sessionID, data);
        else throw new Error('Unknown Prometheus action.');
        return { content: JSON.stringify(result, null, 2) };
      },
    });
  }));

  const events = new AbortController();
  const eventFlight = ctx.event ? (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: events.signal })) await controller.observe(event);
    } catch (error) {
      if (!events.signal.aborted) {
        controller.lastError = `Event observation stopped: ${errorText(error)}`;
        for (const task of store.list('task').filter(t => t.root === root))
          await controller.pause(task.origin, 'Native cancellation observation is unavailable.');
      }
    }
  })() : Promise.resolve();
  controller.launch(controller.recover());
  return async () => {
    events.abort();
    await eventFlight;
    await controller.close();
    for (const registration of registrations.reverse()) await registration.dispose();
    store.close();
  };
}

export default Plugin.define({ id: 'prometheus', setup });
