import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolated } from './helpers.mjs';

test('the packed plugin loads beside native goal, including at the home location', { timeout: 90000 }, async t => {
  const h = await isolated(t, { packed: true });
  const session = await h.create('plan');
  let plugins;
  const deadline = Date.now() + 15000;
  do {
    plugins = await h.request('/api/plugin');
    if (plugins.data.some(item => item.id === 'prometheus')) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.equal(plugins.data.find(item => item.id === 'prometheus')?.state.status, 'active', JSON.stringify(plugins));
  assert.equal(plugins.data.find(item => item.id === 'opencode.goal')?.source.type, 'builtin');
  const commands = (await h.request('/api/command')).data;
  assert.equal(commands.filter(command => command.name === 'goal').length, 1);
  assert.match(commands.find(command => command.name === 'goal').description, /pause\|resume\|clear/);
  for (const name of ['spike', 'grill-me']) assert.ok(commands.some(command => command.name === name));
  await h.request('/api/session', { agent: 'plan', location: { directory: h.home } });
  let home;
  do {
    home = await h.request(`/api/plugin?location[directory]=${encodeURIComponent(h.home)}`);
    if (home.data.some(item => item.id === 'prometheus')) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.equal(home.data.find(item => item.id === 'prometheus')?.state.status, 'active');
  // No provider is allowed, and no command was invoked. Loading must not start model work.
  const context = await h.request(`/api/session/${session.id}/context`);
  assert.equal(context.data.length, 0);
  assert.equal(fs.existsSync(path.join(h.runtime, 'src/sandbox.mjs')), false);
  assert.equal(fs.existsSync(path.join(h.runtime, 'src/controller.mjs')), false);
});
