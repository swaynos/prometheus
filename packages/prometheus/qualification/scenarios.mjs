// Required observations. A catalog entry is not a qualification result.
export const workflows = [
  ['N01', 'Native goal ownership', 'Prometheus loads beside exactly one native /goal and never invokes or replaces it.'],
  ['N02', 'Native command admission', 'Spike and grill-me preserve attachments, delivery, agent, model, tools, and permissions.'],
  ['N03', 'Plan investigation', 'Investigation stays in Plan. No Build child or product write bypasses restrictions.'],
  ['N04', 'Native execution on Linux', 'Native editing and shell tools perform work without a plugin-owned process runner.'],
  ['N05', 'Native continuation', 'The native goal reviewer continues work after a Prometheus command, without a second loop.'],
  ['N06', 'Independent verification', 'A fresh evaluator uses actual native tool evidence and reports every criterion.'],
  ['N07', 'Repair in origin', 'Failed verification returns evidence. The origin repairs work. Prometheus does not dispatch repairs.'],
  ['N08', 'Human control', 'Native permission denials and cancellation remain effective. Reload does not restart work.'],
].map(([id, name, expected]) => ({ id, name, expected }));
export const faults = [
  ['F01', 'Changed candidate', 'Changed files cannot retain an accepted status for the current candidate. Hashes detect changes but do not prevent them.'],
  ['F02', 'Missing or unrelated evidence', 'Worker claims, running tools, and other-session results cannot establish an evaluator pass.'],
  ['F03', 'Restart or cancellation', 'Pending verification becomes interrupted. Late reports and automatic replay are rejected.'],
  ['F04', 'Unknown admission outcome', 'A lost evaluator-admission receipt is reported as interrupted, not replayed.'],
  ['F05', 'Legacy state', 'Old records remain untouched and inspectable. Old allowances and run states do not start work.'],
  ['F06', 'Unavailable checks', 'A denied or unavailable required check remains unresolved, not accepted.'],
].map(([id, name, expected]) => ({ id, name, expected }));
