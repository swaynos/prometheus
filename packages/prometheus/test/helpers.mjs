import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { Controller } from '../src/controller.mjs';
import { Runner } from '../src/sandbox.mjs';

export class FakeNative {
  constructor() { this.sessions = new Map(); this.messages = new Map(); this.sent = []; this.waiters = new Map(); this.notices = []; }
  async create(input) {
    const session = { id: input.id, agent: input.agent ?? 'build', cost: 0, active: false, ...input };
    this.sessions.set(session.id, session); this.messages.set(session.id, []); return session;
  }
  async get(key) { if (!this.sessions.has(key)) throw new Error('Missing native session.'); return this.sessions.get(key); }
  async exists(key) { return this.sessions.has(key); }
  async context(key) { return this.messages.get(key); }
  async synthetic(input) {
    if (this.failSend) throw new Error('Lost transport after dispatch.');
    this.sent.push(input);
    this.sessions.get(input.sessionID).active = true;
    this.sessions.get(input.sessionID).outcome = undefined;
    this.messages.get(input.sessionID).push({ id: input.id, type: 'synthetic', text: input.text });
    return input;
  }
  async notice(sessionID, text) { this.notices.push({ sessionID, text }); }
  async wait(key) { if (!this.sessions.get(key)?.active) return; return new Promise(resolve => { const waits = this.waiters.get(key) ?? []; waits.push(resolve); this.waiters.set(key, waits); }); }
  async interrupt(key) {
    if (this.sessions.has(key)) { this.sessions.get(key).outcome = 'interrupted'; this.sessions.get(key).active = false; }
    for (const resolve of this.waiters.get(key) ?? []) resolve();
    this.waiters.delete(key);
  }
  async complete(key) {
    this.sessions.get(key).outcome = 'succeeded';
    this.sessions.get(key).active = false;
    for (const resolve of this.waiters.get(key) ?? []) resolve();
    this.waiters.delete(key);
  }
}
export const goal = (overrides = {}) => ({ outcome: 'Write a greeting.', intent: 'implementation', scope: ['greeting.txt'],
  nonGoals: ['No deployment.'], assumptions: [], checklist: ['Construct a check.', 'Write the greeting.', 'Evaluate the candidate.'],
  criteria: [{ id: 'greeting', description: 'The greeting says hello.', pass: 'The file contains hello.', owner: 'evaluator', validatorIDs: [] }],
  validators: [], limits: { maxRequests: 100 }, ...overrides });

export async function fixture(t, { agent = 'build', limits = { maxRequests: 100 } } = {}) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'prometheus-test-'));
  const root = fs.realpathSync(fs.mkdirSync(path.join(base, 'project'), { recursive: true }) || path.join(base, 'project'));
  const native = new FakeNative();
  await native.create({ id: 'sesOrigin', agent });
  const store = new Store(path.join(base, 'private'));
  // Controller tests simulate admission. The separate OS tests exercise the real boundary.
  const runner = new Runner({ scratchRoot: path.join(store.directory, 'scratch'), available: () => true });
  const controller = new Controller({ store, native, runner, root, limits });
  runner.protectedPaths = controller.protectedPaths;
  controller.enroll('sesOrigin');
  const user = (text = '/goal', flags = {}) => {
    const key = `msgUser${native.messages.get('sesOrigin').length}`;
    native.messages.get('sesOrigin').push({ id: key, type: 'user', text });
    controller.source('sesOrigin', { id: key, text, agent: native.sessions.get('sesOrigin').agent,
      allowStart: true, allowResume: true, ...flags });
  };
  user();
  t.after(async () => { await controller.close(); store.close(); fs.rmSync(base, { recursive: true, force: true }); });
  return { base, root, native, store, runner, controller, user };
}
export async function startFixture(t, options) {
  const f = await fixture(t, options);
  f.controller.prepare('sesOrigin', goal());
  await f.controller.start('sesOrigin');
  f.run = f.store.get('run', f.controller.status('sesOrigin').taskID ? f.controller.taskFor('sesOrigin').runID : '');
  return f;
}
