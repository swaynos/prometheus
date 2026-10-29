import { requireThat } from './util.mjs';

export function text(value, name) {
  requireThat(typeof value === 'string' && value.trim(), `${name} must contain text.`);
  return value.trim();
}

export function criteriaContract(criteria) {
  requireThat(Array.isArray(criteria) && criteria.length, 'Supply at least one acceptance criterion.');
  const result = criteria.map(criterion => ({ id: text(criterion.id, 'Criterion identity'),
    description: text(criterion.description, 'Criterion description'),
    ...(criterion.validator ? { validator: text(criterion.validator, 'Validator instructions') } : {}) }));
  requireThat(new Set(result.map(item => item.id)).size === result.length, 'Criterion identities must be unique.');
  return result;
}

const schema = (actions, description) => ({
  type: 'object', additionalProperties: false,
  properties: { action: { type: 'string', enum: actions }, data: { type: 'object', description } },
  required: ['action', 'data'],
});
export const recordSchema = schema(['finding', 'decision', 'status'],
  'finding: {observations, interpretation, limitations, outcome: supported|disproved|inconclusive}. decision: {decision, rationale}. status: {}. Records are model reports, not independent acceptance.');
export const verificationSchema = schema(['start', 'report', 'status'],
  'start: {criteria: [{id, description, validator?}]}. Build only; asks native subagent permission. report: {verificationID, results: [{id, status: pass|fail|unresolved, explanation, evidence: [{messageID, toolCallID}]}]}. Only the assigned evaluator can report. status: {verificationID?}. No command execution or automatic repair.');
