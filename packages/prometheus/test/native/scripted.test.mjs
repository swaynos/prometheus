import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolated, tool, promptText, until } from './helpers.mjs';

test('the packed project check-in loads through the native skill tool', { timeout: 90000 }, async t => {
  let step = 0;
  const h = await isolated(t, { packed: true, handler: input => {
    if (step++ === 0) {
      assert.match(promptText(input), /project-check-in/);
      return tool(input, 'skill', { id: 'project-check-in' });
    }
    const text = promptText(input);
    assert.match(text, /Now tell me, what is the goal\?/);
    assert.match(text, /Then tell me how to measure what remains\./);
    assert.match(text, /Never overwrite, truncate, or purge an earlier check-in/);
    return { text: 'The project check-in instructions loaded. No project work was started.' };
  } });
  const session = await h.create('build', [{ action: 'skill', resource: 'project-check-in', effect: 'allow' }]);
  await h.request(`/api/session/${session.id}/prompt`, { text: 'Load the project check-in skill only. Do not create a check-in or start project work.' });
  await h.wait(session.id);
  const context = (await h.request(`/api/session/${session.id}/context`)).data;
  const loads = context.filter(message => message.type === 'assistant').flatMap(message => message.content)
    .filter(part => part.type === 'tool' && part.name === 'skill');
  assert.equal(loads.length, 1);
  assert.equal(loads[0].state.status, 'completed');
  assert.ok(step >= 2);
  assert.equal((await h.request(`/api/session?parentID=${session.id}`)).data.length, 0);
});

test('a Plan check-in falls back to chat without attempting a write', { timeout: 90000 }, async t => {
  let step = 0;
  const h = await isolated(t, { packed: true, handler: input => {
    if (step++ === 0) return tool(input, 'skill', { id: 'project-check-in' });
    const text = promptText(input);
    assert.match(text, /Plan, read-only, or permission-denied contexts/);
    assert.match(text, /do not try another tool,\s+agent, path, or method/);
    assert.match(text, /say clearly that it was not saved/);
    assert.match(text, /Do not start `\/goal`, delegate to a\s+subagent/);
    return { text: [
      '## What is the goal?',
      'The goal is unknown from the available project context.',
      '',
      '## Where do we measure against that goal?',
      'No measurement source was verified.',
      '',
      '## What remains against the goal?',
      'The goal and current position are unknown.',
      '',
      '## How do we measure what remains?',
      'Clarify the goal and inspect its stated acceptance measures.',
      '',
      'Not saved: this Plan session is read-only.',
    ].join('\n') };
  } });
  const session = await h.create('plan', [{ action: 'skill', resource: 'project-check-in', effect: 'allow' }]);
  await h.request(`/api/session/${session.id}/prompt`, { text: 'Give me a project check-in and save it if permitted.' });
  await h.wait(session.id);
  const context = (await h.request(`/api/session/${session.id}/context`)).data;
  const toolCalls = context.filter(message => message.type === 'assistant').flatMap(message => message.content)
    .filter(part => part.type === 'tool');
  assert.deepEqual(toolCalls.map(part => part.name), ['skill']);
  const response = context.filter(message => message.type === 'assistant').flatMap(message => message.content)
    .filter(part => part.type === 'text').map(part => part.text).join('\n');
  for (const section of ['What is the goal?', 'Where do we measure against that goal?', 'What remains against the goal?', 'How do we measure what remains?']) {
    assert.ok(response.includes(section), `Missing check-in section: ${section}`);
  }
  assert.match(response, /Not saved: this Plan session is read-only/);
  assert.deepEqual(fs.readdirSync(h.root), []);
  assert.equal((await h.request(`/api/session?parentID=${session.id}`)).data.length, 0);
});

test('spike uses native shell and preserves normal editing tools', { timeout: 90000 }, async t => {
  let step = 0;
  const h = await isolated(t, { handler: input => {
    if (step++ === 0) {
      assert.ok(input.tools.some(item => /edit|write|patch/.test(item.function?.name)), `Native editing tools remain available: ${input.tools.map(item => item.function?.name)}`);
      return tool(input, 'shell', { command: 'printf observation > observation.txt', description: 'Write the authorized experiment observation.' });
    }
    return { text: 'The observation file was created with the native shell.' };
  } });
  const session = await h.create('build', [{ action: 'shell', resource: '*', effect: 'allow' }]);
  await h.request(`/api/session/${session.id}/command`, { name: 'spike', text: 'Run the authorized local file experiment.' });
  await h.wait(session.id);
  assert.equal(fs.existsSync(path.join(h.root, 'observation.txt')), true, JSON.stringify(await h.request(`/api/session/${session.id}/context`)));
  assert.equal(fs.readFileSync(path.join(h.root, 'observation.txt'), 'utf8'), 'observation');
  assert.equal((await h.request(`/api/session/${session.id}`)).data.agent, 'build');
  const children = await h.request(`/api/session?parentID=${session.id}`);
  assert.equal(children.data.length, 0);
});

test('Plan and native shell denial are not bypassed through a Prometheus runner', { timeout: 90000 }, async t => {
  let observed = false;
  const h = await isolated(t, { handler: input => {
    observed = true;
    assert.equal(input.tools.some(item => item.function?.name === 'shell'), false, 'OpenCode omits the denied shell tool.');
    assert.equal(input.tools.some(item => item.function?.name === 'prometheus_control'), false);
    return { text: 'The required action was denied.' };
  } });
  const session = await h.create('plan', [{ action: 'shell', resource: '*', effect: 'deny' }]);
  await h.request(`/api/session/${session.id}/command`, { name: 'spike', text: 'Investigate without changes.' });
  await h.wait(session.id);
  assert.equal(fs.existsSync(path.join(h.root, 'forbidden.txt')), false);
  assert.equal(observed, true);
  assert.equal((await h.request(`/api/session/${session.id}`)).data.agent, 'plan');
  assert.equal((await h.request(`/api/session?parentID=${session.id}`)).data.length, 0);
});

test('native goal owns review and continuation after a Prometheus command', { timeout: 90000 }, async t => {
  let primary = 0; let reviews = 0;
  const h = await isolated(t, { handler: input => {
    const text = promptText(input);
    if (text.includes('You are now the reviewer for the session')) {
      reviews++;
      return { text: JSON.stringify(reviews === 1 ? { verdict: 'continue', reason: 'The greeting file is missing.', next_step: 'Write the greeting.' }
        : { verdict: 'done', reason: 'The native shell result establishes the greeting.' }) };
    }
    if (primary++ === 2) return tool(input, 'shell', { command: 'printf hello > greeting.txt', description: 'Create the fixture greeting.' });
    return { text: 'The fixture turn is complete.' };
  } });
  const session = await h.create('build', [{ action: 'shell', resource: '*', effect: 'allow' }]);
  await h.request(`/api/session/${session.id}/command`, { name: 'grill-me', text: 'Record that the greeting must be plain text.' });
  await h.wait(session.id);
  await h.request(`/api/session/${session.id}/command`, { name: 'goal', text: 'Make greeting.txt contain hello.' });
  await h.wait(session.id);
  assert.equal(fs.readFileSync(path.join(h.root, 'greeting.txt'), 'utf8'), 'hello');
  assert.equal(reviews, 2);
  assert.equal((await h.request(`/api/session?parentID=${session.id}`)).data.length, 0);
  await h.request(`/api/session/${session.id}/command`, { name: 'goal', text: 'clear' });
});

test('native goal waits for fresh evaluator evidence without leaking worker context', { timeout: 90000 }, async t => {
  let origin = 0; let evaluator = 0; let goalReviews = 0;
  const h = await isolated(t, { handler: input => {
    const text = promptText(input);
    if (text.includes('You are now the reviewer for the session')) {
      assert.ok(evaluator >= 2, 'Native goal review must wait for independent evaluation.');
      goalReviews++;
      return { text: JSON.stringify({ verdict: 'done', reason: 'The independent native evaluator reported a pass with direct evidence.' }) };
    }
    if (text.includes('Independently evaluate the candidate')) {
      assert.equal(text.includes('ORIGIN_ONLY_CONTEXT_SENTINEL'), false);
      if (evaluator++ === 0) return tool(input, 'shell', { command: 'cat greeting.txt', description: 'Inspect the candidate greeting.' });
      if (evaluator === 2) {
        const refs = JSON.parse(text.match(/Completed native evidence references: (\[[^\n]*\])/)[1]);
        const verificationID = text.match(/Use verificationID (verification_[a-f0-9]+)/)[1];
        return tool(input, 'prometheus_verify', { action: 'report', data: { verificationID,
          results: [{ id: 'greeting', status: 'pass', explanation: 'The native shell output is hello.', evidence: refs.map(({ messageID, toolCallID }) => ({ messageID, toolCallID })) }] } });
      }
      return { text: 'Independent verification is complete.' };
    }
    if (origin++ === 0) return tool(input, 'prometheus_verify', { action: 'start', data: { criteria: [{ id: 'greeting', description: 'The greeting contains hello.' }] } });
    return { text: 'Verification was requested.' };
  } });
  fs.writeFileSync(path.join(h.root, 'greeting.txt'), 'hello');
  const session = await h.create('build', [{ action: 'shell', resource: '*', effect: 'allow' }, { action: 'subagent', resource: '*', effect: 'allow' }]);
  await h.request(`/api/session/${session.id}/command`, { name: 'goal', text: 'Independently verify the greeting. ORIGIN_ONLY_CONTEXT_SENTINEL' });
  await h.wait(session.id);
  const children = (await h.request(`/api/session?parentID=${session.id}`)).data;
  assert.equal(children.length, 1, JSON.stringify(await h.request(`/api/session/${session.id}/context`)));
  await h.wait(children[0].id);
  const context = await h.request(`/api/session/${session.id}/context`);
  assert.match(JSON.stringify(context), /accepted/, JSON.stringify(await h.request(`/api/session/${children[0].id}/context`)));
  assert.ok(evaluator >= 2);
  assert.ok(goalReviews >= 1);
});

for (const mode of ['interruption', 'reload']) test(`native evaluator ${mode === 'reload' ? 'reload after cancellation' : mode} preserves records without restarting work`, { timeout: 90000 }, async t => {
  let origin = 0; let evaluator = 0;
  const h = await isolated(t, { handler: input => {
    if (promptText(input).includes('Independently evaluate the candidate')) { evaluator++; return { hang: true }; }
    const step = origin++;
    if (step === 0) return tool(input, 'prometheus_verify', { action: 'start', data: { criteria: [{ id: 'check', description: 'Inspect the candidate.' }] } });
    if (step === 2) return tool(input, 'prometheus_verify', { action: 'status', data: {} });
    return { text: 'The fixture turn is complete.' };
  } });
  fs.writeFileSync(path.join(h.root, 'candidate.txt'), 'candidate');
  const session = await h.create('build', [{ action: 'subagent', resource: '*', effect: 'allow' }]);
  await h.request(`/api/session/${session.id}/prompt`, { text: 'Request independent verification.' });
  await until(() => evaluator === 1);
  const children = (await h.request(`/api/session?parentID=${session.id}`)).data;
  assert.equal(children.length, 1);
  // OpenCode reloads running sessions at step boundaries. A deliberately hung
  // provider has no boundary, so cancel that owned request before reloading.
  await h.request(`/api/session/${children[0].id}/interrupt`, { resume: false });
  await h.wait(children[0].id);
  await h.wait(session.id);
  if (mode === 'reload') await h.request('/api/location/reload', {});
  // The native event stream is asynchronous. Wait for its processing through an explicit status request.
  await h.request(`/api/session/${session.id}/prompt`, { text: 'Inspect verification status only. Do not resume work.' });
  await h.wait(session.id);
  const context = await h.request(`/api/session/${session.id}/context`);
  const statuses = context.data.filter(message => message.type === 'assistant').flatMap(message => message.content)
    .filter(part => part.type === 'tool' && part.name === 'prometheus_verify' && part.state.input?.action === 'status');
  assert.equal(statuses.length, 1);
  assert.match(JSON.stringify(statuses[0]), /interrupted/);
  assert.equal(evaluator, 1);
  assert.equal((await h.request(`/api/session?parentID=${session.id}`)).data.length, 1);
});
