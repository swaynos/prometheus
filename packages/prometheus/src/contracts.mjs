import { requireThat, hash } from './util.mjs';

const text = (value, name) => { requireThat(typeof value === 'string' && value.trim(), `${name} must contain text.`); return value.trim(); };
const texts = (value, name) => { requireThat(Array.isArray(value), `${name} must be an array.`); return value.map(v => text(v, name)); };
export function argumentsContract(value) {
  requireThat(Array.isArray(value) && value.length && typeof value[0] === 'string' && value[0].trim() &&
    value.every(v => typeof v === 'string' && !v.includes('\0')), 'Supply an executable argument array.');
  return [...value];
}

export function limitsContract(l) {
  requireThat(l && Number.isSafeInteger(l.maxRequests) && l.maxRequests > 0, 'Supply an aggregate model-request allowance.');
  if (l.deadline !== undefined) requireThat(Number.isSafeInteger(l.deadline) && l.deadline > 0, 'Invalid deadline.');
  if (l.maxUSD !== undefined) requireThat(Number.isFinite(l.maxUSD) && l.maxUSD > 0, 'Invalid cost estimate limit.');
  return { maxRequests: l.maxRequests, ...(l.deadline ? { deadline: l.deadline } : {}), ...(l.maxUSD ? { maxUSD: l.maxUSD } : {}) };
}
export function withinLimits(requested, approved) {
  return !!approved && requested.maxRequests <= approved.maxRequests &&
    (!approved.deadline || requested.deadline && requested.deadline <= approved.deadline) &&
    (!approved.maxUSD || requested.maxUSD && requested.maxUSD <= approved.maxUSD);
}

export function spikeContract(input) {
  requireThat(input && typeof input === 'object', 'A spike definition is required.');
  return {
    question: text(input.question, 'Question'), decision: text(input.decision, 'Dependent decision'),
    experiment: text(input.experiment, 'Experiment'), observations: text(input.observations, 'Required observations'),
    stopWhen: text(input.stopWhen ?? 'Report a finding when the question is answered or its allowance ends.', 'Stopping condition'),
    evidenceIDs: texts(input.evidenceIDs ?? [], 'Available evidence'), writable: input.writable === true,
    ...(input.allowance ? { allowance: limitsContract(input.allowance) } : {}),
  };
}
export function findingContract(input) {
  requireThat(['supported', 'disproved', 'inconclusive'].includes(input?.outcome), 'Invalid finding outcome.');
  return { outcome: input.outcome, observations: text(input.observations, 'Observations'),
    interpretation: text(input.interpretation, 'Interpretation'), limitations: text(input.limitations, 'Limitations'),
    evidenceIDs: texts(input.evidenceIDs ?? [], 'Evidence identities') };
}
export function decisionContract(input) {
  requireThat(['ready', 'needs-investigation', 'needs-user'].includes(input?.status), 'Supply a readiness status.');
  return { interpretation: text(input.interpretation, 'Interpretation'), example: text(input.example, 'Acceptance example'),
    validator: text(input.validator, 'Proposed validator'), decision: text(input.decision ?? 'No user decision recorded.', 'Decision'), status: input.status };
}

export function goalContract(input) {
  requireThat(input && typeof input === 'object', 'A goal is required.');
  const goal = {
    outcome: text(input.outcome, 'Outcome'),
    intent: text(input.intent, 'Task intent'),
    nonGoals: texts(input.nonGoals ?? [], 'Non-goals'),
    scope: texts(input.scope, 'Scope'),
    assumptions: texts(input.assumptions ?? [], 'Assumptions'),
    checklist: texts(input.checklist, 'Checklist'),
    criteria: [], validators: [],
    limits: input.limits,
    document: input.document,
  };
  requireThat(goal.scope.length && goal.checklist.length, 'Scope and ordered work are required.');
  requireThat(['investigation', 'validators', 'implementation'].includes(goal.intent), 'Unknown task intent.');
  requireThat(Array.isArray(input.criteria) && input.criteria.length, 'Acceptance criteria are required.');
  goal.criteria = input.criteria.map(c => ({ id: text(c.id, 'Criterion identity'), description: text(c.description, 'Criterion'),
    pass: text(c.pass, 'Pass condition'), owner: c.owner ?? 'evaluator', validatorIDs: texts(c.validatorIDs ?? [], 'Validator identities') }));
  requireThat(goal.criteria.every(c => ['evaluator', 'user', 'browser'].includes(c.owner)), 'Unknown criterion owner.');
  goal.validators = (input.validators ?? []).map(v => ({
    id: text(v.id, 'Validator identity'), method: text(v.method, 'Method'),
    argv: v.argv ? argumentsContract(v.argv) : undefined,
    files: texts(v.files ?? [], 'Validator source files'),
    environment: text(v.environment, 'Environment'), limitations: text(v.limitations, 'Limitations'),
    negative: text(v.negative, 'Relevant known-bad example'), positive: v.positive ?? 'Not established.',
  }));
  const unique = values => new Set(values).size === values.length;
  requireThat(unique(goal.criteria.map(c => c.id)) && unique(goal.validators.map(v => v.id)), 'Duplicate criterion or validator identity.');
  requireThat(goal.criteria.every(c => c.validatorIDs.every(key => goal.validators.some(v => v.id === key))), 'A criterion refers to an absent validator.');
  goal.limits = limitsContract(goal.limits);
  if (goal.document !== undefined) text(goal.document, 'Specification document');
  return goal;
}
export function renderSpec(goal) {
  if (goal.document) return goal.document;
  return `# Task specification\n\n## Outcome\n${goal.outcome}\n\n## Intent\n${goal.intent}\n\n## Non-goals\n${bullets(goal.nonGoals)}\n\n## Scope\n${bullets(goal.scope)}\n\n## Acceptance criteria\n${goal.criteria.map(c => `- ${c.id}: ${c.description}\n  Pass: ${c.pass}\n  Owner: ${c.owner}\n  Validators: ${c.validatorIDs.join(', ') || 'Independent inspection'}`).join('\n')}\n\n## Protected resources\nDo not change governing instructions, controller state, credentials, or this specification.\n\n## Assumptions\n${bullets(goal.assumptions)}\n\n## Ordered work\n${goal.checklist.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n## Validators\n${goal.validators.map(v => `- ${v.id}: ${v.method}\n  Command: ${JSON.stringify(v.argv ?? null)}\n  Source files: ${JSON.stringify(v.files)}\n  Environment: ${v.environment}\n  Known-bad example: ${v.negative}\n  Known-good example: ${v.positive}\n  Limitations: ${v.limitations}`).join('\n')}\n\n## Limits\n${JSON.stringify(goal.limits)}\n\n## Pause and delivery\nPause for cancellation, denial, required scope expansion, exhausted limits, or uncertain consequential effects.\nAccept every criterion before delivery. Do not deploy or publish without authority.\n`;
}
const bullets = items => items.length ? items.map(v => `- ${v}`).join('\n') : 'None.';
export const specIdentity = goal => hash({ goal, document: renderSpec(goal) });
export function evaluationContract(goal, results) {
  requireThat(Array.isArray(results) && results.length === goal.criteria.length, 'Report every criterion exactly once.');
  requireThat(new Set(results.map(r => r.id)).size === results.length, 'Duplicate criterion result.');
  return goal.criteria.map(c => {
    const r = results.find(value => value.id === c.id);
    requireThat(r && ['pass', 'fail', 'unresolved'].includes(r.status), `Missing result for ${c.id}.`);
    return { id: c.id, status: r.status, explanation: text(r.explanation, 'Explanation'), evidenceIDs: texts(r.evidenceIDs ?? [], 'Evidence identities') };
  });
}

export const objectSchema = properties => ({ type: 'object', properties, additionalProperties: false });
export const stringSchema = { type: 'string' };
// The controller applies the detailed contract. This schema keeps the tool readable.
export const controlSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['prepare', 'start', 'status', 'pause', 'resume', 'retire', 'reconcile', 'spike', 'finding', 'decision', 'candidate', 'evaluate', 'evidence', 'run'] },
    data: { type: 'object', description: 'Action data. Read the action contract in the session instructions.' },
  }, required: ['action', 'data'],
};
