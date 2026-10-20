import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { OpenCode } from '@opencode/client';
import { loadManifest } from '../../qualification/manifest.mjs';
import { runCampaign } from '../../qualification/driver.mjs';
import { sandboxAvailable } from '../../src/sandbox.mjs';
import { goal } from '../helpers.mjs';

const packageRoot = path.resolve(import.meta.dirname, '../..');

for (const mode of ['complete', 'budget', 'rescue', 'human', 'unenrolled']) test(`installed qualification: ${mode}`, { timeout: 120000, skip: !sandboxAvailable() }, async t => {
  const temporary = path.join(fs.realpathSync(os.tmpdir()), 'opencode');
  fs.mkdirSync(temporary, { recursive: true, mode: 0o700 });
  const base = fs.mkdtempSync(path.join(temporary, 'prometheus-campaign-native-'));
  const bootstrap = path.join(base, 'bootstrap');
  const home = path.join(base, 'home');
  const probe = path.join(base, 'provider');
  const fixture = path.join(base, 'fixture');
  for (const directory of [bootstrap, home, path.join(home, 'config'), probe, fixture]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let service; let closed;
  t.after(async () => {
    if (service) {
      try { process.kill(-service.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await closed;
    }
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
    fs.rmSync(base, { recursive: true, force: true });
  });
  const calls = [];
  const steps = { origin: 0, worker: 0, evaluator: 0, baseline: 0 };
  let negative;
  const declared = goal({ limits: { maxRequests: 60 }, criteria: [{ id: 'greeting', description: 'The greeting says hello.', pass: 'The check returns zero.', owner: 'evaluator', validatorIDs: ['greeting'] }],
    validators: [{ id: 'greeting', method: 'Read greeting.txt.', argv: ['/bin/sh', '-c', 'test "$(cat greeting.txt)" = hello'], environment: 'macOS.', limitations: 'One file.', negative: 'A wrong greeting fails.' }] });
  const provider = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const text = JSON.stringify(input);
    const role = text.includes('Prometheus role: evaluator.') ? 'evaluator' : text.includes('Prometheus role: worker.') ? 'worker' :
      !text.includes('Prometheus is active for this workflow.') ? 'baseline' : 'origin';
    const step = steps[role]++;
    calls.push({ role, step, tools: input.tools?.map(tool => tool.function?.name ?? tool.name) });
    const evidence = [...new Set([...text.matchAll(/evidence_[a-f0-9]{32}/g)].map(match => match[0]))];
    let action; let native;
    if (role === 'origin' && step === 0) action = { action: 'prepare', data: { goal: declared } };
    else if (role === 'origin' && step === 2) action = { action: 'start', data: {} };
    else if (role === 'worker' && step === 0) action = { action: 'run', data: { validatorID: 'greeting', argv: ['/bin/sh', '-c',
      'printf wrong > greeting.txt; ! test "$(cat greeting.txt)" = hello; printf hello > greeting.txt; test "$(cat greeting.txt)" = hello'] } };
    else if (role === 'worker' && step === 1) { negative = evidence.at(-1); action = { action: 'candidate', data: { readiness: { greeting: [negative] } } }; }
    else if (role === 'worker' && step === 2) action = { action: 'run', data: { validatorID: 'greeting', argv: ['/bin/sh', '-c', 'printf hello > greeting.txt; test "$(cat greeting.txt)" = hello'] } };
    else if (role === 'worker' && step === 3) action = { action: 'candidate', data: { readiness: { greeting: [negative, evidence.at(-1)] } } };
    else if (role === 'evaluator' && step % 2 === 0) action = { action: 'run', data: { validatorID: 'greeting' } };
    else if (role === 'evaluator') action = { action: 'evaluate', data: { results: [{ id: 'greeting', status: step === 1 ? 'fail' : 'pass',
      explanation: step === 1 ? 'The independent procedure rejected the defect.' : 'The current candidate passed.', evidenceIDs: evidence.slice(-1) }] } };
    else if (role === 'baseline' && step % 2 === 0) {
      const shell = input.tools?.find(tool => ['shell', 'bash'].includes(tool.function?.name));
      native = shell ? { name: shell.function.name, arguments: JSON.stringify({ command:
        'test -z "$OPENAI_API_KEY" || exit 40; if (printf bad > ../outside.txt) 2>/dev/null; then exit 41; fi; if (printf bad > opencode.json) 2>/dev/null; then exit 42; fi; printf hello > greeting.txt',
        description: 'Check the declared native boundary and write the greeting.' }) } : undefined;
    }
    const delta = action || native ? { role: 'assistant', tool_calls: [{ index: 0, id: `call_${role}_${step}`, type: 'function',
      function: native ?? { name: 'prometheus_control', arguments: JSON.stringify(action) } }] } : { role: 'assistant', content: 'Implementation complete.' };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = object => response.write(`data: ${JSON.stringify(object)}\n\n`);
    emit({ id: `chatcmpl-${role}-${step}`, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] });
    emit({ id: `chatcmpl-${role}-${step}`, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: action || native ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${provider.address().port}/v1`;
  fs.writeFileSync(path.join(probe, 'package.json'), JSON.stringify({ name: 'prometheus-campaign-provider', type: 'module', exports: './index.mjs' }));
  fs.symlinkSync(path.join(packageRoot, 'node_modules'), path.join(probe, 'node_modules'));
  fs.writeFileSync(path.join(probe, 'index.mjs'), `import { Model, Provider } from '@opencode/plugin';
export default { id: 'prometheus-campaign-provider', async setup(ctx) {
  const providerID = Provider.ID.make('fixture');
  await ctx.provider.transform(editor => editor.add({ info: { ...Provider.Info.empty(providerID), activation: 'enabled',
    package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: ${JSON.stringify(url)}, apiKey: 'fixture-only' } },
    models: [Model.Info.default(providerID, Model.ID.make('fixture'))] }));
} };`);
  fs.writeFileSync(path.join(home, 'config', 'opencode.json'), JSON.stringify({ plugins: [probe],
    policies: [{ action: 'provider.use', resource: '*', effect: 'deny' }, { action: 'provider.use', resource: 'fixture', effect: 'allow' }] }));
  fs.writeFileSync(path.join(fixture, 'greeting.txt'), 'wrong');
  fs.writeFileSync(path.join(fixture, 'validator.mjs'), "import assert from 'node:assert/strict'; import fs from 'node:fs'; assert.equal(fs.readFileSync('greeting.txt', 'utf8'), 'hello');\n");
  const agreement = 'Make greeting.txt contain exactly hello. Use the existing check. Do not deploy or publish.';
  const permissions = [{ action: 'shell', resource: '*', effect: 'allow' }, { action: 'subagent', resource: 'build', effect: 'allow' },
    { action: 'fixture-decision', resource: 'greeting', effect: 'ask' }, { action: 'fixture-rescue', resource: 'greeting', effect: 'ask' }];
  const common = { fixture: 'fixture', pair: mode === 'unenrolled' ? 'greeting' : undefined, comparison: 'discovery', agreement, permissions,
    timeoutMs: 15000, maxRequests: mode === 'budget' ? 1 : 60, oracles: [['node', '{oracle}/validator.mjs']] };
  const manifestFile = path.join(base, 'manifest.json');
  const cases = [
    { ...common, name: 'prometheus', agent: 'plan', scenarios: ['W07', 'W11', 'W13'],
      candidateFault: { path: 'greeting.txt', content: 'controlled defect', reason: 'Exercise independent rejection before candidate capture, without changing the agreement or validator.' }, steps: [
      { type: 'prompt', text: agreement, resume: false }, { type: 'command', name: 'goal' },
      { type: 'wait', idle: true, checks: [{ path: 'state', equals: 'Draft' }, { path: 'changedFiles', equals: [] }, { path: 'counts.workers', equals: 0 }], save: 'prepared' },
      { type: 'agent', agent: 'build' },
      { type: 'wait', stableMs: 100, checks: [{ path: 'counts.workers', equals: 0 }, { path: 'specificationID', sameAs: 'checkpoints.prepared.specificationID' }] },
      { type: 'prompt', text: 'Execute your plan.' },
      { type: 'wait', checks: [{ path: 'counts.workers', equals: 1 }, { path: 'workerID', exists: true }], save: 'started' },
      { type: 'wait', timeoutMs: 15000, checks: [{ path: 'state', equals: 'Accepted' }, { path: 'counts.workers', equals: 1 }, { path: 'counts.rejections', equals: 1 },
        { path: 'counts.evaluators', equals: 2 }, { path: 'workerID', sameAs: 'checkpoints.started.workerID' }] },
    ] },
    { ...common, name: 'ordinary', arm: 'build', agent: 'plan', steps: [
      { type: 'prompt', text: agreement, resume: false },
      { type: 'permission', action: 'fixture-decision', resources: ['greeting'], decision: 'once' },
      mode === 'human' ? { type: 'human', request: 'form', instructions: 'Select hello for this controlled scenario. Supply no implementation advice.' } :
        { type: 'answer', title: 'Greeting preference', answer: { greeting: 'hello' } },
      { type: 'agent', agent: 'build' },
      { type: 'prompt', text: 'Execute your plan.' }, { type: 'wait', idle: true },
    ], expect: { completionClaim: [{ path: 'native.lastAssistantText', contains: 'Implementation complete.' }] } },
  ];
  if (mode === 'unenrolled') {
    delete cases[0].candidateFault;
    cases[0].scenarios = ['W17'];
    cases[0].steps = [{ type: 'prompt', text: agreement, resume: false }, { type: 'agent', agent: 'build' },
      { type: 'prompt', text: 'Execute your plan.' }, { type: 'wait', idle: true }];
    cases[0].expect = { states: ['Unenrolled'], checks: [{ path: 'counts.workers', equals: 0 }] };
    cases[1].steps = [...cases[0].steps];
  }
  fs.writeFileSync(manifestFile, JSON.stringify({ version: 2, evidenceClass: 'scripted-native', model: { providerID: 'fixture', id: 'fixture' },
    maxRequests: mode === 'budget' ? 1 : 120, timeoutMs: 60000, cases }));
  const env = { ...process.env, HOME: home, OPENCODE_TEST_HOME: home, OPENCODE_CONFIG_DIR: path.join(home, 'config'),
    XDG_CONFIG_HOME: path.join(home, 'config-root'), XDG_DATA_HOME: path.join(home, 'data'), XDG_STATE_HOME: path.join(home, 'state'),
    XDG_CACHE_HOME: path.join(home, 'cache'), OPENCODE_DB: path.join(home, 'native.sqlite'), OPENCODE_SERVER_PASSWORD: 'prometheus-campaign-test-only', OPENAI_API_KEY: 'fixture-do-not-inherit' };
  service = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: bootstrap, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  closed = new Promise(resolve => service.once('close', resolve));
  let logs = '';
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Owned qualification service did not start: ${logs}`)), 15000);
    for (const stream of [service.stdout, service.stderr]) stream.on('data', chunk => {
      logs += chunk;
      const match = logs.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    service.once('error', error => { clearTimeout(timer); reject(error); });
    service.once('exit', code => { clearTimeout(timer); reject(new Error(`Owned service exited: ${code}: ${logs}`)); });
  });
  const client = OpenCode.make({ baseUrl: endpoint, headers: { Authorization: `Basic ${Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}` } });
  const driverClient = { ...client, session: { ...client.session, prompt: async (input, options) => {
    const admitted = await client.session.prompt(input, options);
    const session = await client.session.get({ sessionID: input.sessionID });
    // Controlled native requests test declared participation plumbing, not model question quality.
    if (mode !== 'unenrolled' && input.resume === false && path.basename(session.location.directory) === 'ordinary') {
      await client.permission.create({ sessionID: input.sessionID, action: 'fixture-decision', resources: ['greeting'], save: [] }, options);
      await client.session.form.create({ sessionID: input.sessionID, title: 'Greeting preference', fields: [
        { key: 'greeting', type: 'string', required: true, title: 'Greeting' },
      ] }, options);
      if (mode === 'rescue') {
        const request = await client.permission.create({ sessionID: input.sessionID, action: 'fixture-rescue', resources: ['greeting'], save: [] }, options);
        await client.permission.reply({ sessionID: input.sessionID, requestID: request.id, decision: 'once' }, options);
      }
    }
    return admitted;
  } } };
  const report = await runCampaign(loadManifest(manifestFile), { client: driverClient, output: path.join(base, 'results'), progress: async event => {
    if (event.type === 'awaiting-response') await client.session.form.reply({ sessionID: event.sessionID, formID: event.requestID, answer: { greeting: 'hello' } });
  } });
  if (mode === 'budget') {
    assert.equal(report.complete, false);
    assert.equal(report.requests, 1);
    assert.equal(calls.length, 1, JSON.stringify(calls));
    assert.equal(report.cases.length, 1);
    assert.equal(report.usage.campaign.state, 'Paused');
    assert.equal(report.cases[0].stop.confirmed, true);
    return;
  }
  if (mode === 'rescue') {
    assert.equal(report.complete, false);
    assert.ok(report.cases[1]?.interventions.some(i => i.type === 'unexpected-native-reply'), JSON.stringify(report.cases));
    assert.equal(report.usage.campaign.state, 'Paused');
    assert.equal(report.cases[1].stop.confirmed, true);
    return;
  }
  if (mode === 'unenrolled') {
    assert.equal(report.complete, true, JSON.stringify(report.cases));
    assert.ok(report.cases.every(c => c.snapshot.state === 'Unenrolled' && c.snapshot.counts.workers === 0 && c.externalChecksPass));
    assert.ok(calls.every(call => call.role === 'baseline' && !call.tools.includes('prometheus_control')));
    assert.equal(report.comparisons.length, 1);
    assert.equal(report.comparisons[0].comparable, false, 'Scripted providers do not establish a real-model comparison.');
    return;
  }
  assert.equal(report.complete, true, JSON.stringify({ cases: report.cases, error: report.error, calls, logs: logs.slice(-6000) }));
  assert.equal(report.releaseQualified, false);
  assert.equal(report.cases.length, 2);
  assert.equal(report.cases[0].snapshot.counts.workers, 1);
  assert.equal(report.cases[0].snapshot.counts.rejections, 1);
  assert.equal(report.cases[0].controlledFaults.length, 1);
  assert.equal(report.cases[0].controlledFaults[0].state, 'applied');
  assert.equal(report.cases[1].snapshot.state, 'Unenrolled');
  assert.ok(report.cases.every(c => c.acceptedCompletion && c.externalChecksPass && c.stop.confirmed));
  assert.ok(report.cases.every(c => c.requests > 0));
  assert.equal(report.requests, report.cases.reduce((sum, item) => sum + item.requests, 0));
  assert.ok(report.requests >= calls.length, 'Transport reservations must cover all fixture requests.');
  assert.equal(report.comparisons.length, 0);
  assert.equal(report.cases[1].participation.filter(p => p.classification === 'decision').length, 2);
  assert.equal(report.cases[1].interventions.length, 0);
  assert.equal(fs.existsSync(path.join(base, 'results/workspaces/outside.txt')), false);
  assert.equal(fs.readFileSync(path.join(fixture, 'greeting.txt'), 'utf8'), 'wrong');
});
