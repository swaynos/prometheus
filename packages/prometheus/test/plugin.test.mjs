import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import plugin from '../src/index.mjs';
import { fixture } from './helpers.mjs';
import { goal } from './helpers.mjs';
import { serviceVersion, unsupportedVersions } from './versions.mjs';
import { OPENCODE_VERSION_LABEL } from '../src/compatibility.mjs';

async function host(t, { collisions = [], version = serviceVersion } = {}) {
  const f = await fixture(t, { agent: 'plan' });
  const hooks = new Map();
  const commands = [];
  const tools = [];
  const prompts = [];
  const registration = { dispose: async () => {} };
  const register = domain => async (name, callback) => { hooks.set(`${domain}.${name}`, callback); return registration; };
  const ctx = {
    app: { version }, location: { directory: f.root }, options: { stateDirectory: path.join(f.base, 'plugin-state'), limits: { maxRequests: 100 } },
    command: { list: async () => ({ data: collisions }), transform: async callback => { callback({ add: c => commands.push(c) }); return registration; } },
    session: {
      get: ({ sessionID }) => f.native.get(sessionID), context: ({ sessionID }) => f.native.context(sessionID),
      create: input => f.native.create(input), synthetic: input => f.native.synthetic(input),
      wait: ({ sessionID }) => f.native.wait(sessionID), interrupt: ({ sessionID }) => f.native.interrupt(sessionID),
      hook: register('session'), prompt: async input => {
        const event = { sessionID: input.sessionID, messageID: input.id, prompt: { text: input.text, files: input.files } };
        await hooks.get('session.prompt')?.(event);
        f.native.messages.get(input.sessionID).push({ id: input.id, type: 'user', text: input.text });
        prompts.push(input); return input;
      },
    },
    tool: { hook: register('tool'), transform: async callback => { callback({ add: tool => tools.push(tool) }); return registration; } },
    permission: { hook: register('permission'), assert: async () => {} },
  };
  return { ...f, ctx, hooks, commands, tools, prompts };
}
test('unsupported OpenCode versions fail before commands are registered', async t => {
  for (const version of unsupportedVersions) {
    const h = await host(t);
    h.ctx.app.version = version;
    await assert.rejects(plugin.setup(h.ctx), error => error.message.includes(`supports stable OpenCode ${OPENCODE_VERSION_LABEL}`));
    assert.equal(h.commands.length, 0);
    assert.equal(h.tools.length, 0);
  }
});
test('bare goal preserves conversation-driven instructions and attachments', async t => {
  const h = await host(t);
  const cleanup = await plugin.setup(h.ctx);
  t.after(cleanup);
  await h.commands.find(c => c.name === 'goal').execute({ sessionID: 'sesOrigin', prompt: { text: '', files: [{ uri: 'file:///fixture' }] }, delivery: 'queue' });
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0].text, /Infer the goal from the conversation/);
  assert.deepEqual(h.prompts[0].files, [{ uri: 'file:///fixture' }]);
  assert.equal(h.prompts[0].delivery, 'queue');
  assert.deepEqual(h.commands.map(c => c.name), ['spike', 'grill-me', 'goal']);
});
test('unenrolled sessions retain native tools and receive no controller instructions', async t => {
  const h = await host(t);
  const cleanup = await plugin.setup(h.ctx);
  t.after(cleanup);
  const event = { sessionID: 'sesUnrelated', tools: { shell: {}, edit: {}, prometheus_control: {} }, system: [] };
  await h.hooks.get('session.context')(event);
  assert.deepEqual(event.tools, { shell: {}, edit: {} });
  assert.deepEqual(event.system, []);
});
test('command collisions are detected without replacement', async t => {
  const h = await host(t, { collisions: [{ name: 'goal' }] });
  await assert.rejects(plugin.setup(h.ctx), /did not replace existing commands/);
  assert.equal(h.commands.length, 0);
});
test('permission hooks tighten native decisions rather than granting authority', async t => {
  const h = await host(t);
  const cleanup = await plugin.setup(h.ctx);
  t.after(cleanup);
  await h.commands.find(c => c.name === 'goal').execute({ sessionID: 'sesOrigin', prompt: { text: '' }, delivery: 'queue' });
  const forbidden = { sessionID: 'sesOrigin', action: 'shell', effect: 'allow' };
  await h.hooks.get('permission.evaluate')(forbidden);
  assert.equal(forbidden.effect, 'deny');
  const extraAuthority = { sessionID: 'sesOrigin', action: 'prometheus_network', effect: 'allow' };
  await h.hooks.get('permission.evaluate')(extraAuthority);
  assert.equal(extraAuthority.effect, 'ask');
  const denied = { sessionID: 'sesOrigin', action: 'prometheus_network', effect: 'deny' };
  await h.hooks.get('permission.evaluate')(denied);
  assert.equal(denied.effect, 'deny');
});
test('an admission denial persists and cannot repeatedly prompt without a new instruction', async t => {
  const h = await host(t);
  h.native.sessions.get('sesOrigin').agent = 'build';
  let requests = 0;
  h.ctx.permission.assert = async () => { requests++; throw new Error('The user denied this allowance.'); };
  const cleanup = await plugin.setup(h.ctx);
  t.after(cleanup);
  await h.commands.find(c => c.name === 'goal').execute({ sessionID: 'sesOrigin', prompt: { text: '' }, delivery: 'queue' });
  const control = h.tools[0].execute;
  const context = { sessionID: 'sesOrigin', agent: 'build', messageID: 'msgAssistant', id: 'callAdmission' };
  await control({ action: 'prepare', data: { goal: goal({ limits: { maxRequests: 150 } }) } }, context);
  await assert.rejects(control({ action: 'start', data: {} }, context), /denied/);
  assert.equal(JSON.parse((await control({ action: 'status', data: {} }, context)).content).state, 'Paused');
  await assert.rejects(control({ action: 'start', data: {} }, context), /new explicit user instruction/);
  assert.equal(requests, 1);
});
