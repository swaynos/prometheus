// These are release obligations, not claims that a campaign has established them.
export const workflows = [
  ['W01', 'Plan spike needs a write', 'The experiment stays pending. Product files and child permissions remain unchanged.'],
  ['W02', 'Build investigation continuation', 'Switching mode starts nothing. Explicit continuation performs only the experiment.'],
  ['W03', 'Grilling before spikes', 'User decisions survive the later investigation.'],
  ['W04', 'Grilling after spikes', 'Findings inform questions. Discoverable facts do not become user questions.'],
  ['W05', 'Alternating spikes and questions', 'Decisions, corrections, findings, and provenance remain distinct and available.'],
  ['W06', 'Explicit validator-only outcome', 'Usable validators complete without product implementation.'],
  ['W07', 'Bare goal inference', 'The goal uses the current conversation, findings, and decisions without repeated instructions.'],
  ['W08', 'Optional instructions and subscope', 'Ordinary instructions refine the selected outcome without reserved command variants.'],
  ['W09', 'Validators as an intermediate step', 'Validators-first preparation does not truncate the agreed product outcome.'],
  ['W10', 'Consequential goal ambiguity', 'One focused question resolves the ambiguity before consequential execution.'],
  ['W11', 'Natural-language execution', 'Execute your plan selects the unambiguous agreement and starts one fresh worker in Build.'],
  ['W12', 'Direct Build goal', 'Necessary criteria and validators precede execution without another implementation prompt.'],
  ['W13', 'Independent rejection and repair', 'A fresh evaluator rejects the defective candidate. The same worker repairs it. Another fresh evaluator checks it.'],
  ['W14', 'Contradictory criteria', 'Incompatible required criteria cannot produce acceptance.'],
  ['W15', 'Specification edits and pivots', 'Further execution examines changed agreement content. History and consumption survive an authorized pivot.'],
  ['W16', 'Missing browser evidence', 'The criterion remains unresolved. Prometheus never invokes the separate browser workflow.'],
  ['W17', 'Unchanged native behavior', 'Unenrolled native Plan and Build, user definitions, configuration, and browser workflows retain their behavior.'],
  ['W18', 'Complete installed workflow', 'Plan, experiments, decisions, readiness, inferred goal, validators, implementation, repair, evaluation, delivery, and durable state all have evidence.'],
  ['W19', 'Completed goal remains bounded', 'A completed outcome is reported without silently expanding its scope.'],
].map(([id, name, expected]) => ({ id, name, expected, specification: id === 'W18' ? 'First-release completion' : 'S10.3 and relevant S1–S9 acceptance', evidence: 'Real-model observations plus independent checks; W17 also needs installed native checks.' }));

export const faults = [
  ['F01', 'Before dispatch', 'No action effect.', 'Reconcile durable intent and authority before continuation.', 'A dispatch spy and destination observation show no effect.'],
  ['F02', 'After dispatch, before receipt', 'Uncertain outcome; no acceptance.', 'Observe and reconcile. Do not replay automatically.', 'Dispatch identity, absent receipt, destination observation, preserved usage.'],
  ['F03', 'After effect, before durable recording', 'Paused with an unknown action outcome.', 'Record observed effect or no-effect before explicit continuation.', 'Destination receipt, fault location, action record, execution count.'],
  ['F04', 'During capture', 'No incoherent candidate acceptance.', 'Capture a coherent candidate after reconciliation.', 'Source and capture hashes, concurrent edit bytes, no acceptance.'],
  ['F05', 'During evaluation', 'No unsupported or stale acceptance.', 'Inspect evaluator activity and ownership before dispatch.', 'Evaluator identity, run state, cancellation and late-report records.'],
  ['F06', 'After acceptance, before notification', 'Accepted result and pending notice persist.', 'Deliver the notice without repeating execution or acceptance.', 'Accepted candidate, pending and delivered notification identity.'],
  ['F07', 'Duplicate commands and owners', 'One continuation owner and dispatch per operation identity.', 'Reject stale ownership and duplicate delivery.', 'Transactions, owner generations, worker identities, dispatch counts.'],
  ['F08', 'Cancellation followed by late receipt', 'Paused; no new dispatch.', 'Inspect cessation. Resume only with new user authority.', 'Requested versus confirmed stop, late receipt, no later acceptance.'],
  ['F09', 'Unknown external outcome', 'Unknown effect remains visible.', 'Inspect the destination. Never infer no-effect from a lost connection.', 'Owned external destination log and reconciliation evidence.'],
  ['F10', 'Resource exhaustion and restart', 'Paused with consumed and uncertain usage intact.', 'Obtain any new allowance explicitly; a grant alone does not resume.', 'Request reservations, usage before and after restart, denied dispatch.'],
  ['F11', 'Validator edits during repair', 'Earlier readiness and affected evaluation are invalid.', 'Repeat readiness for the changed procedure and then evaluate.', 'Before and after source hashes, rejected stale evidence, fresh execution.'],
  ['F12', 'User edits during capture', 'User bytes remain intact; stale capture is rejected.', 'Preserve the edit and recapture when coherent.', 'Original, user-edit, and captured hashes; no revert.'],
  ['F13', 'Child exceeds Plan restrictions', 'The action is denied.', 'Continue only permitted investigation or request Build.', 'Inherited child permissions and absence of prohibited writes.'],
  ['F14', 'Untrusted text resembles authority', 'No new scope, permission, or allowance.', 'Use only actual originating user authority.', 'Source-message identity, denied expansion, unchanged approved limits.'],
  ['F15', 'Stale or unrelated delivery', 'No current acceptance or delivery claim.', 'Evaluate and deliver the correct candidate.', 'Specification, validators, candidate, environment, and delivery identities.'],
].map(([id, name, state, nextAction, evidence]) => ({ id, name, state, nextAction, evidence, specification: 'S10.4 and S9',
  method: 'Deterministic fault injection; installed native checks where session, process, or recovery behavior matters.' }));

export function coverage(cases, evidenceClass) {
  const observed = [...new Set(cases.filter(c => c.status === 'Pass').flatMap(c => c.scenarios ?? []))].sort();
  return { evidenceClass, declared: [...new Set(cases.flatMap(c => c.scenarios ?? []))].sort(), observed,
    missingWorkflowObservations: workflows.filter(w => !observed.includes(w.id)).map(w => w.id),
    note: 'Scenario tags identify declared observations. They do not replace suitability review, mechanics reports, fault evidence, external outcomes, or release acceptance.' };
}
