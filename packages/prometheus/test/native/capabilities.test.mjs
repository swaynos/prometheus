import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('installed OpenCode loads the package and exercises native session capabilities without a model', { timeout: 120000 }, async t => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'prometheus-native-'));
  const root = path.join(base, 'project');
  const home = path.join(base, 'home');
  const config = path.join(home, 'config');
  const proof = path.join(base, 'proof.json');
  const probe = path.join(base, 'probe');
  const installed = path.join(base, 'installed');
  for (const directory of [root, home, config, probe, installed]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let server;
  let closed;
  t.after(async () => {
    if (server) {
      try { process.kill(-server.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await closed;
    }
    fs.rmSync(base, { recursive: true, force: true });
  });
  const packed = await exec('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', base], { cwd: packageRoot, timeout: 30000 });
  const archive = JSON.parse(packed.stdout)[0].filename;
  await exec('tar', ['-xzf', path.join(base, archive), '-C', installed]);
  fs.writeFileSync(path.join(probe, 'package.json'), JSON.stringify({ name: 'prometheus-capability-probe', type: 'module', exports: './index.mjs' }));
  fs.writeFileSync(path.join(probe, 'index.mjs'), `import fs from 'node:fs';import {spawn,execFileSync} from 'node:child_process';
import {Native} from ${JSON.stringify(path.join(installed, 'package', 'src', 'native.mjs'))};
export default { id:'prometheus-probe', async setup(ctx) {
  const processProbe=spawn('/bin/sleep',['10'],{detached:true,stdio:'ignore'});
  const ended=new Promise(resolve=>processProbe.once('close',resolve));
  const processIdentity=execFileSync('/bin/ps',['-o','pid=,pgid=,ppid=','-p',String(processProbe.pid)],{encoding:'utf8'}).trim();
  let groupSignal;
  try {process.kill(-processProbe.pid,'SIGKILL');groupSignal='sent';}catch(error){groupSignal=String(error);processProbe.kill('SIGKILL');}
  await ended;
  const created = await ctx.session.create({ agent:'build', title:'Owned capability fixture', permissions:[{action:'shell',resource:'*',effect:'deny'}] });
  const child = await ctx.session.create({ parentID:created.id, agent:'build', title:'Owned child fixture' });
  const restricted = await new Native(ctx).create({parentID:created.id,agent:'build',permissions:[{action:'edit',resource:'*',effect:'deny'}]});
  let childShellDenied=false;
  try {await ctx.permission.assert({sessionID:restricted.id,agent:'build',action:'shell',resources:['/usr/bin/true'],save:[]});}catch{childShellDenied=true;}
  await ctx.session.update({ sessionID:child.id, permissions:[{action:'edit',resource:'*',effect:'deny'}] });
  const admission = await ctx.session.synthetic({ sessionID:child.id, id:'msg_PrometheusNativeProbe', text:'Recorded without execution.', resume:false });
  const duplicate = await ctx.session.synthetic({ sessionID:child.id, id:'msg_PrometheusNativeProbe', text:'Recorded without execution.', resume:false });
  await ctx.session.wait({ sessionID:created.id });
  const fetched = await ctx.session.get({ sessionID:child.id });
  let missingTag;
  try { await ctx.session.get({sessionID:'ses_PrometheusMissingFixture'}); } catch(error) {missingTag=error._tag;}
  const messages = await ctx.session.context({ sessionID:created.id });
  await ctx.session.interrupt({ sessionID:child.id, continue:false });
  const commands=await ctx.command.list();
  fs.writeFileSync(${JSON.stringify(proof)},JSON.stringify({version:ctx.app.version,parent:created.id,child:fetched.id,parentID:fetched.parentID,permissions:fetched.permissions,admission,duplicate,missingTag,contextIsArray:Array.isArray(messages),commands,processIdentity,groupSignal,childShellDenied}));
} };`);
  fs.writeFileSync(path.join(root, 'opencode.json'), JSON.stringify({
    plugins: [{ package: path.join(installed, 'package'), options: { stateDirectory: path.join(base, 'private') } }, probe],
    policies: [{ action: 'provider.use', resource: '*', effect: 'deny' }],
  }));
  const env = { ...process.env, HOME: home, OPENCODE_TEST_HOME: home, OPENCODE_CONFIG_DIR: config,
    XDG_CONFIG_HOME: path.join(home, 'config-root'), XDG_DATA_HOME: path.join(home, 'data'),
    XDG_STATE_HOME: path.join(home, 'state'), XDG_CACHE_HOME: path.join(home, 'cache'), OPENCODE_DB: path.join(home, 'native.sqlite'),
    OPENCODE_SERVER_PASSWORD: 'prometheus-isolated-test-only' };
  server = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  closed = new Promise(resolve => server.once('close', resolve));
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The owned server did not start. ${output}`)), 30000);
    for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => {
      output += chunk;
      const found = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (found) { clearTimeout(timer); resolve(found[0]); }
    });
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`The owned server exited: ${code}. ${output}`)); });
  });
  async function request(route, body) {
    const response = await fetch(`${url}${route}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}` }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    const text = await response.text();
    assert.equal(response.ok, true, text);
    return text ? JSON.parse(text) : undefined;
  }
  const created = await request('/api/session', { agent: 'plan', location: { directory: root } });
  await request(`/api/session/${created.data.id}/prompt`, { text: 'Record this test input without model execution.', resume: false });
  if (!fs.existsSync(proof)) {
    const diagnostic = await request('/api/plugin');
    const configDiagnostic = await request('/api/config');
    assert.fail(`The native probe did not load.\n${output}\n${JSON.stringify(diagnostic)}\n${JSON.stringify(configDiagnostic)}`);
  }
  const result = JSON.parse(fs.readFileSync(proof, 'utf8'));
  assert.match(result.version, /^2\./);
  assert.match(result.parent, /^ses_/);
  assert.match(result.child, /^ses_/);
  assert.equal(result.parentID, result.parent);
  assert.equal(result.contextIsArray, true);
  assert.equal(result.admission.type, 'synthetic');
  assert.equal(result.admission.id, result.duplicate.id);
  assert.equal(result.missingTag, 'Session.NotFoundError');
  assert.equal(result.groupSignal, 'sent', JSON.stringify({ identity: result.processIdentity, signal: result.groupSignal }));
  assert.equal(result.childShellDenied, true);
  const loaded = await request('/api/plugin');
  const registered = await request('/api/command');
  const logs = [];
  function readLogs(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) readLogs(file);
      else if (entry.isFile() && /\.log$/.test(entry.name)) logs.push(fs.readFileSync(file, 'utf8').split('\n').filter(line => /plugin|prometheus|Error/.test(line)).join('\n'));
    }
  }
  readLogs(home);
  for (const name of ['spike', 'grill-me', 'goal']) assert.ok(registered.data.some(c => c.name === name), JSON.stringify(loaded.data.filter(p => p.source.type !== 'builtin')) + '\n' + logs.join('\n'));
  assert.equal(loaded.data.find(p => p.id === 'prometheus')?.state.status, 'active');
  assert.ok(!result.commands.data.some(c => c.name === 'plan'));
  fs.writeFileSync(path.join(root, 'opencode.json'), JSON.stringify({
    plugins: [{ package: path.join(installed, 'package'), options: { stateDirectory: path.join(base, 'private') } }],
    commands: { goal: { description: 'User-owned goal command', template: 'Preserve this user command.' } },
    policies: [{ action: 'provider.use', resource: '*', effect: 'deny' }],
  }));
  await request('/api/location/reload', {});
  let after;
  const reloadDeadline = Date.now() + 10000;
  do {
    after = await request('/api/command');
    if (after.data.find(c => c.name === 'goal')?.description === 'User-owned goal command') break;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < reloadDeadline);
  assert.equal(after.data.find(c => c.name === 'goal')?.description, 'User-owned goal command', JSON.stringify(await request('/api/plugin')));
});
