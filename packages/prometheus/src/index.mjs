import { Plugin } from '@opencode/plugin';
import { requireOpenCodeVersion } from './compatibility.mjs';
import { commandInstructions } from './prompts.mjs';
import { Records } from './records.mjs';
import { Verification } from './verification.mjs';
import { recordSchema, verificationSchema } from './contracts.mjs';

async function setup(ctx) {
  requireOpenCodeVersion(ctx.app.version);
  const records = new Records(ctx);
  const verification = new Verification(ctx, records);
  const registrations = [];
  const commands = ['spike', 'grill-me'];
  const existing = (await ctx.command.list()).data;
  const collisions = existing.filter(command => commands.includes(command.name));
  if (collisions.length) throw new Error(`Prometheus did not replace existing commands: ${collisions.map(c => c.name).join(', ')}.`);

  registrations.push(await ctx.command.transform(editor => {
    for (const name of commands) editor.add({
      name,
      description: name === 'spike' ? 'Investigate a technical question with native tools.' : 'Resolve consequential user decisions.',
      execute: async ({ sessionID, prompt, delivery }) => {
        // Do not enroll the session, change its agent, or start a native goal.
        await ctx.session.prompt({ ...prompt, sessionID, delivery,
          text: `${commandInstructions(name)}\n\nUser request:\n${prompt.text}` });
      },
    });
  }));

  registrations.push(await ctx.tool.transform(editor => {
    editor.add({ name: 'prometheus_record', description: 'Record findings and decisions, or read this session’s Prometheus records. Does not execute work.',
      input: recordSchema, options: { codemode: false },
      execute: async ({ action, data = {} }, context) => ({
        content: JSON.stringify(await records.execute(context.sessionID, action, data), null, 2),
      }),
    });
    editor.add({ name: 'prometheus_verify', description: 'Request independent candidate verification, report evaluator results, or inspect verification status. Does not start a goal or repair loop.',
      input: verificationSchema, options: { codemode: false },
      execute: async ({ action, data = {} }, context) => ({
        content: JSON.stringify(await verification.execute(action, data, context), null, 2),
      }),
    });
  }));

  // Supply evidence identities to the evaluator without hiding or replacing native tools.
  registrations.push(await ctx.session.hook('context', event => verification.context(event)));
  const events = new AbortController();
  const observing = (async () => {
    try {
      for await (const event of ctx.event.subscribe({
        types: ['session.execution.interrupted', 'session.execution.failed', 'session.execution.succeeded', 'session.deleted'], signal: events.signal,
      })) {
        if (events.signal.aborted) break;
        await verification.observe(event);
      }
    } catch (error) {
      if (!events.signal.aborted) await verification.stop(`Native event observation failed: ${error.message}`);
    }
  })();

  return async () => {
    events.abort();
    // The SDK owns the iterator's scope and closes it after user cleanup.
    // Joining a pending subscription here can block location reload.
    void observing;
    await verification.stop('The Prometheus plugin unloaded. Request a new verification explicitly.', { waitForInterrupt: false });
    for (const registration of registrations.reverse()) await registration.dispose();
  };
}

export default Plugin.define({ id: 'prometheus', setup });
