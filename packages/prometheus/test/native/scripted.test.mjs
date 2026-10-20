import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../../src/store.mjs';
import { hash } from '../../src/util.mjs';
import { goal } from '../helpers.mjs';
import { sandboxAvailable } from '../../src/sandbox.mjs';
import { OpenCode } from '@opencode/client';
import { preflight } from '../../qualification/preflight.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

for (const scenario of ['repair', 'cancel', 'cancel-worker', 'cancel-evaluation', 'worker-plan', 'discovery', 'restart']) test(`native scripted workflow: ${scenario}`, { timeout: 60000, skip: !sandboxAvailable() }, async t => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'prometheus-scripted-'));
  const root = path.join(base, 'project');
  const home = path.join(base, 'home');
  const probe = path.join(base, 'provider');
  const privateRoot = path.join(base, 'private');
  for (const directory of [root, home, probe, path.join(home, 'config')]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let service;
  let serviceClosed;
  let store;
  const ownedProcessGroups = new Set();
  async function stopService(signal = 'SIGTERM') {
    if (!service) return;
    try { process.kill(-service.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await serviceClosed;
  }
  const calls = [];
  const steps = { origin: 0, worker: 0, evaluator: 0, spike: 0 };
  let workerNegative;
  let releaseWorker;
  const workerGate = new Promise(resolve => { releaseWorker = resolve; });
  const declaredGoal = goal({ limits: { maxRequests: 30 }, criteria: [{ id: 'greeting', description: 'The greeting says hello.', pass: 'The check returns zero.', owner: 'evaluator', validatorIDs: ['greeting'] }],
    validators: [{ id: 'greeting', method: 'Compare greeting.txt with hello.', argv: ['/bin/sh', '-c', `${scenario === 'cancel-evaluation' ? 'sleep 30; ' : ''}test "$(cat greeting.txt)" = hello`], environment: 'macOS with sh.', limitations: 'Only the greeting content.', negative: 'A wrong greeting fails.' }] });
  const provider = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    let input;
    try { input = JSON.parse(body); } catch { response.writeHead(400).end(); return; }
    const text = JSON.stringify(input);
    const role = text.includes('Prometheus role: evaluator.') ? 'evaluator' : text.includes('Prometheus role: worker.') ? 'worker' : text.includes('Prometheus role: spike.') ? 'spike' : 'origin';
    const step = steps[role]++;
    calls.push({ role, step, route: request.url, originContextLeaked: role !== 'origin' && text.includes('ORIGIN_ONLY_CONTEXT_SENTINEL') });
    if (scenario === 'worker-plan' && role === 'worker' && step === 0) await workerGate;
    const evidence = [...text.matchAll(/evidence_[a-f0-9]{32}/g)].map(match => match[0]);
    const uniqueEvidence = [...new Set(evidence)];
    let action;
    const investigation = { question: 'Can a controlled file establish the experiment result?', decision: 'Use a file-based validator.',
      experiment: 'Write an observation in the owned directory.', observations: 'Read the output and exit status.', writable: true };
    if (scenario === 'discovery' && role === 'origin') {
      if (step === 0 || step === 2) action = { action: 'spike', data: investigation };
      else if (step === 4) action = { action: 'decision', data: { interpretation: 'Use a plain greeting only.', example: 'greeting.txt contains hello.',
        validator: 'An exact content check.', decision: 'The user selected plain content.', status: 'ready' } };
      else if (step === 6) action = { action: 'prepare', data: { goal: declaredGoal } };
      else if (step === 8) action = { action: 'start', data: {} };
    }
    else if (role === 'origin' && step === 0) action = { action: 'prepare', data: { goal: declaredGoal } };
    else if (role === 'origin' && step === 1) action = { action: 'start', data: {} };
    else if (role === 'spike' && step === 0) action = { action: 'run', data: { argv: ['/bin/sh', '-c', 'printf observation > observation.txt'] } };
    else if (role === 'spike' && step === 1) action = { action: 'finding', data: { outcome: 'supported', observations: 'The owned experiment completed.',
      interpretation: 'The file-based check is available.', limitations: 'This local environment only.', evidenceIDs: uniqueEvidence.slice(-1) } };
    else if (role === 'worker' && step === 0) action = { action: 'run', data: { validatorID: 'greeting', argv: scenario.startsWith('cancel') && scenario !== 'cancel-evaluation' || scenario === 'restart' ? ['/bin/sleep', '30'] : ['/bin/sh', '-c', 'printf wrong > greeting.txt; test "$(cat greeting.txt)" = hello'] } };
    else if (role === 'worker' && step === 1) { workerNegative = uniqueEvidence.at(-1); action = { action: 'candidate', data: { readiness: { greeting: [workerNegative] } } }; }
    else if (role === 'worker' && step === 2) action = { action: 'run', data: { validatorID: 'greeting', argv: ['/bin/sh', '-c', 'printf hello > greeting.txt; test "$(cat greeting.txt)" = hello'] } };
    else if (role === 'worker' && step === 3) action = { action: 'candidate', data: { readiness: { greeting: [workerNegative, uniqueEvidence.at(-1)] } } };
    else if (role === 'evaluator' && step % 2 === 0) action = { action: 'run', data: { validatorID: 'greeting' } };
    else if (role === 'evaluator' && step % 2 === 1) action = { action: 'evaluate', data: { results: [{ id: 'greeting', status: step === 1 ? 'fail' : 'pass', explanation: step === 1 ? 'The independent check rejected the wrong greeting.' : 'The declared check passed for this candidate.', evidenceIDs: uniqueEvidence.slice(-1) }] } };
    const delta = action ? { role: 'assistant', tool_calls: [{ index: 0, id: `call_${role}_${step}`, type: 'function', function: { name: 'prometheus_control', arguments: JSON.stringify(action) } }] }
      : { role: 'assistant', content: 'The assigned step is complete.' };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = object => response.write(`data: ${JSON.stringify(object)}\n\n`);
    emit({ id: `chatcmpl-${role}-${step}`, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] });
    // Keep the origin active so native interruption emits its documented execution event.
    if (scenario === 'cancel' && role === 'origin' && step >= 2) return;
    emit({ id: `chatcmpl-${role}-${step}`, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: action ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    releaseWorker();
    await stopService();
    for (const group of ownedProcessGroups) {
      try { process.kill(-group, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
    store?.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  const providerURL = `http://127.0.0.1:${provider.address().port}/v1`;
  fs.writeFileSync(path.join(probe, 'package.json'), JSON.stringify({ name: 'prometheus-fixture-provider', type: 'module', exports: './index.mjs' }));
  fs.symlinkSync(path.join(packageRoot, 'node_modules'), path.join(probe, 'node_modules'));
  fs.writeFileSync(path.join(probe, 'index.mjs'), `import {Model,Provider} from '@opencode/plugin';
export default {id:'prometheus-fixture-provider',async setup(ctx){const p=Provider.ID.make('fixture');await ctx.provider.transform(editor=>editor.add({info:{...Provider.Info.empty(p),activation:'enabled',package:'@opencode/ai/providers/openai-compatible',settings:{baseURL:${JSON.stringify(providerURL)},apiKey:'fixture-only'}},models:[Model.Info.default(p,Model.ID.make('fixture'))]}));}};`);
  await import(pathToFileURL(path.join(probe, 'index.mjs')).href);
  fs.writeFileSync(path.join(root, 'opencode.json'), JSON.stringify({
    plugins: [{ package: packageRoot, options: { stateDirectory: privateRoot, limits: { maxRequests: 30 } } }, probe],
    policies: [{ action: 'provider.use', resource: '*', effect: 'deny' }, { action: 'provider.use', resource: 'fixture', effect: 'allow' }],
  }));
  const env = { ...process.env, HOME: home, OPENCODE_TEST_HOME: home, OPENCODE_CONFIG_DIR: path.join(home, 'config'),
    XDG_CONFIG_HOME: path.join(home, 'config-root'), XDG_DATA_HOME: path.join(home, 'data'), XDG_STATE_HOME: path.join(home, 'state'),
    XDG_CACHE_HOME: path.join(home, 'cache'), OPENCODE_DB: path.join(home, 'native.sqlite'), OPENCODE_SERVER_PASSWORD: 'prometheus-scripted-test-only' };
  let output = '';
  async function startService() {
    service = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    serviceClosed = new Promise(resolve => service.once('close', resolve));
    output = '';
    return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup failed: ${output}`)), 10000);
    for (const stream of [service.stdout, service.stderr]) stream.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    service.once('error', reject);
    service.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
    });
  }
  let url = await startService();
  const authorization = `Basic ${Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`;
  async function request(route, body) {
    const response = await fetch(`${url}${route}`, { method: body ? 'POST' : 'GET', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    const text = await response.text();
    assert.equal(response.ok, true, `${route}: ${response.status} ${text}`);
    return text ? JSON.parse(text) : null;
  }
  const created = await request('/api/session', { agent: scenario === 'discovery' ? 'plan' : 'build', location: { directory: root }, model: { providerID: 'fixture', id: 'fixture' } });
  let pluginStatus;
  const startupDeadline = Date.now() + 10000;
  do {
    pluginStatus = await request('/api/plugin');
    if (pluginStatus.data.some(p => p.id === 'prometheus-fixture-provider' || p.state.status === 'failed' && p.source.path === probe)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < startupDeadline);
  assert.equal(pluginStatus.data.find(p => p.id === 'prometheus-fixture-provider')?.state.status, 'active', JSON.stringify(pluginStatus.data.filter(p => p.source.type !== 'builtin')));
  await preflight(OpenCode.make({ baseUrl: url, headers: { Authorization: authorization } }), {
    root, packageRoot, signal: AbortSignal.timeout(15000),
  });
  await request(`/api/session/${created.data.id}/prompt`, { text: 'Create greeting.txt with hello. Create the check first. Use an aggregate allowance of 30 model requests. No deployment. Context marker: ORIGIN_ONLY_CONTEXT_SENTINEL.', resume: false });
  await request(`/api/session/${created.data.id}/command`, { name: scenario === 'discovery' ? 'spike' : 'goal', text: '' });
  store = new Store(path.join(privateRoot, hash(created.data.projectID)));
  if (scenario === 'worker-plan') {
    const until = Date.now() + 15000;
    let worker;
    do {
      worker = store.list('run')[0]?.worker;
      if (worker && calls.some(c => c.role === 'worker')) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < until);
    assert.ok(worker);
    await request(`/api/session/${worker}/agent`, { agent: 'plan' });
    assert.equal((await request(`/api/session/${worker}`)).data.agent, 'plan');
    releaseWorker();
    let action;
    do {
      action = store.list('action').find(a => a.sessionID === worker && a.completionReceived);
      if (action) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < until);
    assert.ok(action, JSON.stringify({ calls, status: store.list('run'), actions: store.list('action') }));
    await request(`/api/session/${created.data.id}/prompt`, { text: 'Pause the goal.' });
    assert.equal(action.nativeAgent, 'plan');
    assert.equal(action.writable, false);
    assert.equal(fs.existsSync(path.join(root, 'greeting.txt')), false);
    return;
  }
  if (scenario === 'discovery') {
    const origin = `/api/session/${created.data.id}`;
    const waitSession = sessionID => request(`/api/experimental/session/${sessionID}/wait`, {});
    await waitSession(created.data.id);
    assert.equal(store.list('spike')[0]?.state, 'pending');
    assert.equal(store.list('session').filter(s => s.role !== 'origin').length, 0);
    assert.equal(fs.existsSync(path.join(root, 'SPEC.md')), false);
    await request(`${origin}/agent`, { agent: 'build' });
    assert.equal(store.list('run').length, 0);
    await request(`${origin}/prompt`, { text: 'Continue your investigation work.' });
    await waitSession(created.data.id);
    const spike = store.list('spike')[0];
    await waitSession(spike.sessionID);
    assert.equal(store.list('finding')[0]?.outcome, 'supported');
    assert.equal(fs.existsSync(path.join(root, 'observation.txt')), false);
    assert.equal(fs.existsSync(path.join(root, 'greeting.txt')), false);
    assert.equal(store.list('run').length, 0);
    await request(`${origin}/agent`, { agent: 'plan' });
    await request(`${origin}/command`, { name: 'grill-me', text: 'Use a plain greeting only.' });
    await waitSession(created.data.id);
    assert.equal(store.list('decision')[0]?.status, 'ready');
    await request(`${origin}/command`, { name: 'goal', text: '' });
    await waitSession(created.data.id);
    assert.equal(store.list('specification').length, 1);
    assert.equal(store.list('run').length, 0);
    assert.equal(fs.existsSync(path.join(root, 'SPEC.md')), false);
    await request(`${origin}/agent`, { agent: 'build' });
    assert.equal(store.list('run').length, 0);
    await request(`${origin}/prompt`, { text: 'Execute your plan.' });
  }
  if (scenario.startsWith('cancel') || scenario === 'restart') {
    const startedDeadline = Date.now() + 10000;
    let action;
    do {
        action = store.list('action').find(a => a.process?.pid && (scenario !== 'cancel-evaluation' || store.get('session', a.sessionID)?.role === 'evaluator'));
      if (action) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < startedDeadline);
    assert.ok(action, JSON.stringify({ calls, messages: await request(`/api/session/${created.data.id}/context`) }));
    if (scenario === 'restart') {
      ownedProcessGroups.add(action.process.processGroup);
      const requestsBefore = store.list('task')[0].requests;
      const callsBefore = calls.length;
      await stopService('SIGKILL');
      url = await startService();
      await request(`/api/session/${created.data.id}/prompt`, { text: 'Inspect recovery state only.', resume: false });
      const recoveryDeadline = Date.now() + 10000;
      let recovered;
      do {
        recovered = store.list('run')[0];
        if (recovered.state === 'Paused' && store.get('action', action.id).state === 'unknown') break;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (Date.now() < recoveryDeadline);
      assert.equal(recovered.state, 'Paused', JSON.stringify({ recovered, plugins: await request('/api/plugin'), info: await request('/api/info') }));
      assert.equal(store.get('action', action.id).state, 'unknown');
      assert.equal(store.list('task')[0].requests, requestsBefore);
      assert.equal(calls.length, callsBefore);
      assert.equal(store.list('session').filter(s => s.role === 'worker').length, 1);
      return;
    }
    const target = scenario === 'cancel-worker' ? store.list('run')[0].worker : scenario === 'cancel-evaluation' ? store.list('run')[0].evaluator : created.data.id;
    await request(`/api/session/${target}/interrupt`, { continue: false });
    const stoppedDeadline = Date.now() + 10000;
    let run;
    do {
      run = store.list('run')[0];
      if (run?.state === 'Paused' && store.list('stop')[0]?.state === 'confirmed') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < stoppedDeadline);
    assert.equal(run?.state, 'Paused', JSON.stringify({ run, calls, stops: store.list('stop') }));
    assert.equal(store.list('stop')[0]?.state, 'confirmed', JSON.stringify(store.list('stop')));
    assert.equal(store.list('evaluation').length, 0);
    return;
  }
  const deadline = Date.now() + 30000;
  let run;
  while (Date.now() < deadline) {
    run = store.list('run')[0];
    if (run && ['Accepted', 'Paused'].includes(run.state)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const messages = await request(`/api/session/${created.data.id}/context`);
  assert.equal(run?.state, 'Accepted', JSON.stringify({ run, calls, output, messages, providers: await request('/api/provider'), models: await request('/api/model') }));
  assert.equal(fs.readFileSync(path.join(root, 'greeting.txt'), 'utf8'), 'hello');
  assert.ok(calls.some(c => c.role === 'worker'));
  assert.ok(calls.some(c => c.role === 'evaluator'));
  assert.ok(calls.every(c => !c.originContextLeaked));
  assert.deepEqual(store.list('evaluation').map(e => e.results[0].status), ['fail', 'pass']);
  assert.equal(store.list('session').filter(s => s.role === 'worker').length, 1);
  assert.equal(store.list('evidence').filter(e => e.kind === 'validator-execution' && store.get('session', e.sessionID).role === 'worker').length, 2);
});
