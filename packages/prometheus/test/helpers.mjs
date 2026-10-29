import fs from 'node:fs';
import path from 'node:path';
import metadata from '../package.json' with { type: 'json' };

export async function fixture(t, { agent = 'build', commands = [{ name: 'goal', description: 'Native goal.' }], values = new Map() } = {}) {
  const base = fs.mkdtempSync(path.join('/tmp/opencode', 'prometheus-test-'));
  const root = fs.mkdirSync(path.join(base, 'project'), { recursive: true });
  const privateRoot = fs.mkdirSync(path.join(base, 'private'), { recursive: true });
  fs.mkdirSync(path.join(privateRoot, 'evidence'));
  const sessions = new Map([['sesOrigin', { id: 'sesOrigin', agent, model: { providerID: 'fixture', id: 'fixture' },
    location: { directory: root }, permissions: [{ action: 'shell', resource: '*', effect: 'ask' }] }]]);
  const messages = new Map([['sesOrigin', []]]);
  const hooks = new Map();
  const tools = [];
  const prompts = [];
  const synthetics = [];
  const interrupts = [];
  const assertions = [];
  const disposed = [];
  let sequence = 0;
  const registration = name => ({ dispose: async () => { disposed.push(name); } });
  const ctx = {
    app: { version: metadata.dependencies['@opencode/plugin'] }, location: { directory: root }, options: {},
    storage: { get: async key => structuredClone(values.get(key)), set: async (key, value) => { values.set(key, structuredClone(value)); }, remove: async key => { values.delete(key); } },
    command: { list: async () => ({ data: commands }), transform: async callback => { callback({ add: c => commands.push(c) }); return registration('command'); } },
    tool: { transform: async callback => { callback({ add: tool => tools.push(tool) }); return registration('tool'); } },
    permission: { assert: async input => { assertions.push(input); } },
    session: {
      get: async ({ sessionID }) => structuredClone(sessions.get(sessionID)),
      context: async ({ sessionID }) => structuredClone(messages.get(sessionID) ?? []),
      create: async input => {
        const session = { ...structuredClone(input), id: `sesChild${++sequence}` };
        sessions.set(session.id, session); messages.set(session.id, []); return session;
      },
      prompt: async input => { prompts.push(input); return input; },
      synthetic: async input => { synthetics.push(input); return input; },
      interrupt: async input => { interrupts.push(input); },
      wait: async () => {},
      hook: async (name, callback) => { hooks.set(`session.${name}`, callback); return registration(name); },
    },
    event: { subscribe: async function* ({ signal }) { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); } },
  };
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root, store: { directory: privateRoot }, ctx, values, sessions, messages, hooks, commands, tools, prompts, synthetics, interrupts, assertions, disposed };
}

export const criteria = [{ id: 'greeting', description: 'greeting.txt contains hello.', validator: 'Read the file and run the declared project tests.' }];
export const callContext = (sessionID = 'sesOrigin') => ({ sessionID, agent: 'build', messageID: 'msgAssistant', id: 'callFixture', signal: new AbortController().signal });
export const toolMessage = (overrides = {}) => ({ id: 'msgEvidence', type: 'assistant', content: [{ type: 'tool', id: 'callRead', name: 'read',
  state: { status: 'completed', input: { path: 'greeting.txt' }, content: [{ type: 'text', text: 'hello' }] }, ...overrides }] });
export const result = (status = 'pass') => ({ id: 'greeting', status, explanation: 'The native file result shows the candidate content.',
  evidence: status === 'pass' ? [{ messageID: 'msgEvidence', toolCallID: 'callRead' }] : [] });
