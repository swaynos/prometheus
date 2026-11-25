import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import plugin from '../src/index.mjs';
import { projectCheckInSkill } from '../src/skills.mjs';
import { fixture } from './helpers.mjs';

test('the bundled project check-in keeps the four questions and preservation rules', () => {
  const skill = projectCheckInSkill();
  assert.equal(skill.id, 'project-check-in');
  assert.equal(skill.name, skill.id);
  assert.equal(skill.autoinvoke, true);
  assert.match(skill.description, /project update/);
  assert.ok(path.isAbsolute(skill.path));
  const source = fs.readFileSync(skill.path, 'utf8');
  assert.ok(source.includes(`description: ${skill.description}\n`));
  assert.equal(skill.content, source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim());
  const questions = [
    'Now tell me, what is the goal?',
    'Then tell me, where do we measure against that goal?',
    'Then tell me, what remains against the goal?',
    'Then tell me how to measure what remains.',
  ];
  let previous = -1;
  for (const question of questions) {
    const index = skill.content.indexOf(question);
    assert.ok(index > previous, `Missing or out-of-order question: ${question}`);
    previous = index;
  }
  assert.match(skill.content, /verified results from plans, unknowns and untested work/);
  assert.match(skill.content, /user's local\s+date and time/);
  assert.match(skill.content, /YYYY-MM-DD-HHMMSS-project-check-in\.md/);
  assert.match(skill.content, /two runs within one second,\s+add a numeric suffix/);
  assert.match(skill.content, /Never overwrite, truncate, or purge an earlier check-in/);
  assert.match(skill.content, /append a new timestamped section/);
  assert.match(skill.content, /unique timestamped\s+heading, adding a suffix if needed/);
  assert.match(skill.content, /do not prescribe a directory/);
  assert.match(skill.content, /Do not start `\/goal`, delegate to a\s+subagent/);
  assert.match(skill.content, /not authorization to run tests, builds, project commands, application\s+code/);
  assert.match(skill.content, /Plan, read-only, or permission-denied contexts/);
  assert.match(skill.content, /do not try another tool,\s+agent, path, or method/);
  assert.match(skill.content, /say clearly that it was not saved/);
  assert.match(skill.content, /Never\s+claim a file was saved unless the write succeeded/);
  assert.doesNotMatch(source, /\bJoe\b|WorkBrain|SEED|\/home\/|\/Users\//);
});

test('plugin setup registers the skill without starting work, and unload removes it', async t => {
  const h = await fixture(t);
  const cleanup = await plugin.setup(h.ctx);
  t.after(cleanup);
  assert.deepEqual(h.skills, [projectCheckInSkill()]);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.synthetics.length, 0);
  assert.equal(h.sessions.size, 1);
  assert.equal(h.values.size, 0);
  await cleanup();
  assert.deepEqual(h.skills, []);
  assert.ok(h.disposed.includes('skill'));
});

for (const autoinvoke of [true, false]) test(`an existing project-check-in skill is preserved with autoinvoke=${autoinvoke}`, async t => {
  const custom = { ...projectCheckInSkill(), name: 'Local check-in', content: 'Keep this user instruction.', autoinvoke };
  const unrelated = { ...custom, id: 'unrelated' };
  const h = await fixture(t, { skills: [custom, unrelated] });
  const cleanup = await plugin.setup(h.ctx);
  t.after(cleanup);
  assert.deepEqual(h.skills, [custom, unrelated]);
  assert.equal(h.skills[0], custom);
  await cleanup();
  assert.deepEqual(h.skills, [custom, unrelated]);
});
