import { Plugin } from '@opencode/plugin';
import { Ledger } from './ledger.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { canonical, hash, localPath, requireThat, errorText } from '../src/util.mjs';
import { nativeFileBoundary, nativeShellBoundary } from './boundary.mjs';

const fixtureTools = new Set(['read', 'glob', 'grep', 'write', 'edit', 'patch', 'apply_patch', 'shell', 'bash', 'question', 'prometheus_control']);

// This plugin meters qualification only. It supplies no continuation or evaluator feedback.
export default Plugin.define({ id: 'prometheus-qualification-meter', async setup(ctx) {
  requireThat(ctx.app.version === '2.0.29', 'Qualification supports OpenCode 2.0.29.');
  const { directory, fingerprint, caseID, root, scratch, protectedPaths, runtimeState, candidateFault } = ctx.options ?? {};
  requireThat(directory && root && caseID && fingerprint, 'Qualification metering needs an approved campaign.');
  requireThat(canonical(ctx.location.directory) === canonical(root), 'The qualification meter loaded in another workspace.');
  const ledger = new Ledger(canonical(directory));
  try {
    requireThat(ledger.get()?.fingerprint === fingerprint, 'The qualification ledger does not identify the approved campaign.');
    requireThat(ledger.store.get('case', caseID)?.root === canonical(root), 'The qualification case is not admitted.');
  } catch (error) { ledger.close(); throw error; }
  const registrations = [];
  const events = new AbortController();
  let tracking;
  async function info(sessionID) {
    const session = await ctx.session.get({ sessionID });
    if (canonical(session.location.directory) !== canonical(root)) return;
    ledger.session(caseID, { ...session, location: { ...session.location, directory: canonical(session.location.directory) } });
    ledger.usage(sessionID, session.cost ?? 0);
    return session;
  }
  try {
    requireThat(scratch && Array.isArray(protectedPaths), 'Qualification needs owned scratch space and protected evidence.');
    registrations.push(await ctx.shell.hook('create.before', event => nativeShellBoundary(event, {
      root: canonical(root), scratch: canonical(scratch), protectedPaths,
    })));
    registrations.push(await ctx.tool.hook('execute.before', async event => {
      const native = await info(event.sessionID);
      if (!native) return;
      requireThat(fixtureTools.has(event.tool), 'This qualification fixture permits only bounded local tools. External tools and arbitrary delegation are not authorized.', 'boundary');
      nativeFileBoundary(event, canonical(root));
      if (!candidateFault || event.tool !== 'prometheus_control' || event.input?.action !== 'candidate') return;
      const state = new Store(path.join(runtimeState, hash(native.projectID)));
      let worker;
      try { worker = state.get('session', event.sessionID)?.role === 'worker'; } finally { state.close(); }
      if (!worker) return;
      const faultID = `candidate-fault-${caseID}`;
      const apply = ledger.store.transaction(() => {
        const prior = ledger.store.get('fault', faultID);
        requireThat(!prior || prior.state === 'applied', 'A candidate fault has an unknown outcome. Do not replay it.', 'unknown_effect');
        if (prior) return false;
        ledger.store.put('fault', { id: faultID, caseID, state: 'intended', path: candidateFault.path,
          reason: candidateFault.reason }, 'candidate_fault_intended');
        return true;
      });
      if (!apply) return;
      try {
        const file = localPath(canonical(root), candidateFault.path, { write: true });
        requireThat(fs.statSync(file).isFile() && fs.statSync(file).nlink === 1, 'The controlled fault needs an existing unaliased product file.');
        const before = hash(fs.readFileSync(file));
        fs.writeFileSync(file, candidateFault.content);
        ledger.store.update('fault', faultID, () => ({ state: 'applied', before, after: hash(fs.readFileSync(file)), sessionID: event.sessionID }), 'candidate_fault_applied');
      } catch (error) { ledger.stop('The controlled candidate fault has an unknown outcome.'); throw error; }
    }));
    registrations.push(await ctx.session.hook('context', async event => {
      if (!await info(event.sessionID)) return;
      for (const tool of Object.keys(event.tools ?? {})) if (!fixtureTools.has(tool)) delete event.tools[tool];
    }));
    for (const name of ['http.request', 'experimental.ws.handshake']) registrations.push(await ctx.session.hook(name, async event => {
      if (!await info(event.sessionID)) return;
      try { ledger.reserve(caseID, event); }
      catch (error) {
        ledger.event(caseID, 'dispatch_refused', { sessionID: event.sessionID, reason: errorText(error), code: error.code });
        if (['campaign_budget', 'model_mismatch', 'campaign_owner'].includes(error.code)) ledger.stop(errorText(error));
        throw error;
      }
    }));
    registrations.push(await ctx.session.hook('prompt', async event => {
      if (!await info(event.sessionID)) return;
      ledger.event(caseID, 'prompt_admitted', { sessionID: event.sessionID, messageID: event.messageID,
        textHash: hash(event.prompt.text), metadata: event.metadata ?? null });
    }));
    // Fixed native titles prevent an ambient auxiliary-model choice in either arm.
    registrations.push(await ctx.session.hook('title', async event => {
      if (await info(event.sessionID)) event.result = `Qualification ${caseID}`;
    }));
    requireThat(ctx.event, 'Qualification needs native participation observation.');
    tracking = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: events.signal })) {
          if (!['permission.replied', 'form.replied', 'form.cancelled'].includes(event.type) || !event.data?.sessionID) continue;
          if (!await info(event.data.sessionID)) continue;
          ledger.event(caseID, 'native_reply', { sessionID: event.data.sessionID, requestID: event.data.requestID ?? event.data.id,
            type: event.type, reply: event.data.reply, answerHash: event.data.answer ? hash(event.data.answer) : undefined });
        }
        if (!events.signal.aborted) {
          ledger.event(caseID, 'tracking_lost', { reason: 'The native event stream ended.' });
          ledger.stop('Native qualification participation observation ended.');
        }
      } catch (error) {
        if (!events.signal.aborted) {
          ledger.event(caseID, 'tracking_lost', { reason: errorText(error) });
          ledger.stop('Native qualification participation observation was lost.');
        }
      }
    })();
    return async () => {
      events.abort();
      await tracking;
      for (const registration of registrations.reverse()) await registration.dispose();
      ledger.close();
    };
  } catch (error) {
    events.abort();
    await tracking;
    for (const registration of registrations.reverse()) await registration.dispose();
    ledger.close();
    throw error;
  }
} });
