import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import plugin from '../src/index.mjs';
import { fixture, callContext } from './helpers.mjs';
import { unsupportedVersions } from './versions.mjs';

test('native goal remains unchanged and Prometheus registers only preparation commands', async t => {
  const h = await fixture(t);
  const goal = h.commands[0];
  t.after(await plugin.setup(h.ctx));
  assert.deepEqual(h.commands.map(command => command.name), ['goal', 'spike', 'grill-me']);
  assert.equal(h.commands[0], goal);
  assert.deepEqual(h.tools.map(tool => tool.name), ['prometheus_record', 'prometheus_verify']);
  assert.equal(h.hooks.has('session.prompt'), false);
  assert.equal(h.hooks.has('session.http.request'), false);
  assert.equal(h.sessions.size, 1);
});

test('unsupported versions and preparation command collisions fail before registration', async t => {
  for (const version of [...unsupportedVersions, '2.1.2', '2.2.0']) {
    const h = await fixture(t); h.ctx.app.version = version;
    await assert.rejects(plugin.setup(h.ctx), /supports stable OpenCode/);
    assert.equal(h.tools.length, 0);
  }
  const h = await fixture(t, { commands: [{ name: 'spike' }] });
  await assert.rejects(plugin.setup(h.ctx), /did not replace existing commands: spike/);
  assert.equal(h.tools.length, 0);
});

test('commands preserve native session, attachments, delivery, agent, and model', async t => {
  const h = await fixture(t, { agent: 'plan' });
  t.after(await plugin.setup(h.ctx));
  const before = structuredClone(h.sessions.get('sesOrigin'));
  for (const name of ['spike', 'grill-me']) {
    const prompt = { text: 'Only investigate.', files: [{ uri: 'file:///fixture' }], agents: [{ name: 'plan' }], skills: [{ name: 'fixture' }] };
    await h.commands.find(command => command.name === name).execute({ sessionID: 'sesOrigin', prompt, delivery: 'queue' });
    const admitted = h.prompts.at(-1);
    assert.equal(admitted.sessionID, 'sesOrigin');
    assert.equal(admitted.delivery, 'queue');
    for (const field of ['files', 'agents', 'skills']) assert.deepEqual(admitted[field], prompt[field]);
    assert.match(admitted.text, /Do not start, replace, resume, or clear a native \/goal/);
    assert.match(admitted.text, /Only investigate/);
  }
  assert.deepEqual(h.sessions.get('sesOrigin'), before);
  assert.equal(h.sessions.size, 1);
  assert.equal(h.synthetics.length, 0);
  assert.equal(h.values.size, 0);
});

test('context hooks leave native tools and unrelated instructions unchanged', async t => {
  const h = await fixture(t);
  t.after(await plugin.setup(h.ctx));
  const event = { sessionID: 'sesOrigin', tools: { shell: {}, edit: {}, mcp_tool: {}, prometheus_verify: {} }, system: [] };
  const before = structuredClone(event);
  await h.hooks.get('session.context')(event);
  assert.deepEqual(event, before);
  assert.equal(h.assertions.length, 0);
});

test('findings and decisions use native storage without starting a goal', async t => {
  const h = await fixture(t, { agent: 'plan' });
  t.after(await plugin.setup(h.ctx));
  const execute = h.tools.find(tool => tool.name === 'prometheus_record').execute;
  await Promise.all(Array.from({ length: 4 }, (_, i) => execute({ action: 'decision', data: { decision: `Choice ${i}`, rationale: 'User preference.' } }, callContext())));
  await execute({ action: 'finding', data: { outcome: 'inconclusive', observations: 'No write experiment ran.', interpretation: 'Unknown.', limitations: 'Plan mode.' } }, callContext());
  const stored = JSON.parse((await execute({ action: 'status', data: {} }, callContext())).content);
  assert.equal(stored.decisions.length, 4);
  assert.equal(stored.findings[0].source, 'model-report');
  assert.equal(h.synthetics.length, 0);
  assert.equal(h.sessions.size, 1);
});

test('legacy state inside the project does not block loading or get changed', async t => {
  const h = await fixture(t);
  const legacy = path.join(h.root, 'legacy'); fs.mkdirSync(legacy);
  const file = path.join(legacy, 'prometheus.sqlite'); fs.writeFileSync(file, 'old records');
  h.ctx.options = { stateDirectory: legacy, limits: { maxRequests: 1 } };
  const cleanup = await plugin.setup(h.ctx);
  const tool = h.tools.find(tool => tool.name === 'prometheus_record');
  const status = JSON.parse((await tool.execute({ action: 'status', data: {} }, callContext())).content);
  assert.equal(status.legacy.configured, true);
  assert.match(status.legacy.message, /not imported, changed, or resumed/);
  await cleanup();
  assert.equal(fs.readFileSync(file, 'utf8'), 'old records');
  assert.equal(h.values.size, 0);
  assert.equal(h.interrupts.length, 0);
});
