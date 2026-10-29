import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const packageRoot = path.resolve(import.meta.dirname, '../..');
const exec = promisify(execFile);

export async function isolated(t, { handler, packed = false } = {}) {
  const base = fs.mkdtempSync('/tmp/opencode/prometheus-native-');
  const root = fs.mkdirSync(path.join(base, 'project'), { recursive: true });
  const home = fs.mkdirSync(path.join(base, 'home'), { recursive: true });
  const config = fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  const calls = [];
  const errors = [];
  let provider;
  let server;
  let closed;
  let output = '';
  t.after(async () => {
    if (server) {
      try { process.kill(-server.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      // Only stop this test's owned process group. Never touch the user's service.
      const kill = setTimeout(() => { try { process.kill(-server.pid, 'SIGKILL'); } catch {} }, 5000);
      await closed; clearTimeout(kill);
    }
    if (provider) {
      provider.closeAllConnections();
      await new Promise(resolve => provider.close(resolve));
    }
    fs.rmSync(base, { recursive: true, force: true });
  });
  let runtime = packageRoot;
  if (packed) {
    const packedResult = await exec('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', base], { cwd: packageRoot, timeout: 30000 });
    await exec('tar', ['-xzf', path.join(base, JSON.parse(packedResult.stdout)[0].filename), '-C', base]);
    runtime = path.join(base, 'package');
  }
  const plugins = [runtime];
  if (handler) {
    provider = http.createServer(async (request, response) => {
      try {
        let body = ''; for await (const chunk of request) body += chunk;
        const input = JSON.parse(body);
        calls.push(input);
        const auxiliary = !input.tools?.length && !promptText(input).includes('You are now the reviewer for the session');
        const answer = auxiliary ? { text: 'Fixture session' } : await handler(input, calls.length - 1);
        if (answer?.hang) { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); return; }
        const tool = answer?.tool;
        const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call_fixture_${calls.length}`, type: 'function',
          function: { name: tool.name, arguments: JSON.stringify(tool.input) } }] } : { role: 'assistant', content: answer?.text ?? 'The fixture step is complete.' };
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const emit = value => response.write(`data: ${JSON.stringify(value)}\n\n`);
        const envelope = { id: `chatcmpl-${calls.length}`, object: 'chat.completion.chunk', created: 1, model: 'fixture' };
        emit({ ...envelope, choices: [{ index: 0, delta, finish_reason: null }] });
        emit({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
        response.end('data: [DONE]\n\n');
      } catch (error) { errors.push(String(error)); response.writeHead(500).end(String(error)); }
    });
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    const directory = path.join(base, 'fixture-provider');
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'prometheus-fixture-provider', type: 'module', exports: './index.mjs' }));
    fs.symlinkSync(path.join(packageRoot, 'node_modules'), path.join(directory, 'node_modules'));
    fs.writeFileSync(path.join(directory, 'index.mjs'), `import {Model,Provider} from '@opencode/plugin';
export default {id:'prometheus-fixture-provider',async setup(ctx){const p=Provider.ID.make('fixture');await ctx.provider.transform(editor=>editor.add({info:{...Provider.Info.empty(p),activation:'enabled',package:'@opencode/ai/providers/openai-compatible',settings:{baseURL:${JSON.stringify(`http://127.0.0.1:${provider.address().port}/v1`)},apiKey:'local-fixture-only'}},models:[Model.Info.default(p,Model.ID.make('fixture'))]}));}};`);
    plugins.push(directory);
  }
  fs.writeFileSync(path.join(config, 'opencode.json'), JSON.stringify({ plugins,
    policies: [{ action: 'provider.use', resource: '*', effect: 'deny' }, ...(handler ? [{ action: 'provider.use', resource: 'fixture', effect: 'allow' }] : [])] }));
  // Isolate state and credentials. Only the local fixture provider is allowed.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OPENCODE_') && !/(API_KEY|TOKEN|SECRET|PASSWORD)$/.test(key)));
  Object.assign(env, { HOME: home, OPENCODE_TEST_HOME: home, OPENCODE_CONFIG_DIR: config,
    XDG_CONFIG_HOME: path.join(home, 'config-root'), XDG_DATA_HOME: path.join(home, 'data'),
    XDG_STATE_HOME: path.join(home, 'state'), XDG_CACHE_HOME: path.join(home, 'cache'),
    OPENCODE_DB: path.join(home, 'native.sqlite'), OPENCODE_SERVER_PASSWORD: 'prometheus-isolated-test-only' });
  server = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  closed = new Promise(resolve => server.once('close', resolve));
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Owned server startup timed out. ${output}`)), 30000);
    for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Owned server exited ${code}: ${output}`)); });
  });
  async function request(route, body) {
    const endpoint = new URL(route, url);
    if (['/api/plugin', '/api/command', '/api/config', '/api/location/reload'].includes(endpoint.pathname) && !endpoint.searchParams.has('location[directory]')) endpoint.searchParams.set('location[directory]', root);
    const response = await fetch(endpoint, { method: body === undefined ? 'GET' : 'POST', headers: {
      'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`,
    }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) }).catch(error => {
      throw new Error(`${route}: ${error.message}\n${output}`, { cause: error });
    });
    const text = await response.text();
    assert.equal(response.ok, true, `${route}: ${response.status} ${text}\n${output}`);
    return text ? JSON.parse(text) : undefined;
  }
  const create = async (agent = 'build', permissions = []) => (await request('/api/session', { agent, location: { directory: root },
    ...(handler ? { model: { providerID: 'fixture', id: 'fixture' } } : {}), permissions })).data;
  const wait = async sessionID => {
    await request(`/api/experimental/session/${sessionID}/wait`, {});
    assert.deepEqual(errors, [], 'The local fixture provider failed.');
  };
  return { base, root, home, config, calls, request, create, wait, runtime };
}

export function tool(input, name, args) {
  const available = input.tools?.find(item => item.function?.name === name);
  assert.ok(available, `Missing native tool ${name}. Available: ${input.tools?.map(item => item.function?.name)}`);
  return { tool: { name, input: args } };
}
export const promptText = input => (input.messages ?? []).flatMap(message => typeof message.content === 'string' ? [message.content]
  : (message.content ?? []).flatMap(part => typeof part.text === 'string' ? [part.text] : [])).join('\n');

export async function until(callback, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await callback();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.fail('The expected native test observation did not arrive before its deadline.');
}
