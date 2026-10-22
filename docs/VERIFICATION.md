# Verification

Status: First-release verification is incomplete.

The [specification](../SPEC.md) remains the product agreement.
Use [Scenarios](SCENARIOS.md) to select required behavior, fault cases, and evaluation criteria.
Use the [runtime reference](PROMETHEUS.md) for architecture, boundaries, and native integration findings.

Verification collects evidence for a declared scenario, candidate, and environment.
A passing result applies to that scope only. It is not general certification.

## Evidence classes

Keep these four classes separate:

1. Deterministic tests establish controller mechanics.
2. Scripted native tests establish integration mechanics.
3. Real-model tests establish observed model behavior.
4. Live checks establish external outcomes.

Do not substitute one class for another.
A scripted provider is not a real model.
A successful model run does not establish every external outcome.

## Test execution

Run these commands from the repository root:

```sh
npm ci
npm ci --prefix packages/prometheus
npm test
npm run test:controller
npm run test:controller:native
```

Requirements and safeguards:

- The native service must satisfy the [package compatibility policy](../packages/prometheus/README.md#compatibility).
- Native tests create isolated services, configuration, storage, and workspaces.
- They do not restart the shared service or use paid providers.
- Scripted tests permit only the local fixture provider.
- Native crash tests terminate only owned isolated service groups.
- Process-boundary tests require macOS `sandbox-exec`. Record skips on other platforms.
- Linux browser support does not establish Linux controller support. The controller process boundary does not support Linux.
- Controlled destination tests use loopback effects. They do not establish unrelated live outcomes.

New results apply only to the source and environment recorded by that run.
Keep raw output and private runtime data outside Git, or under ignored `.prometheus-local/`.
Review evidence before publication.

## Real-model campaigns

Obtain the user's model choice and aggregate allowance before paid execution.
Declare tasks, fixtures, expected evidence, and stop conditions first.
Use owned test workspaces rather than product checkouts.
Retain failures, resource consumption, declared human decisions, and unexpected rescue.
Do not classify manual repair as unattended success.

The [runner reference](../packages/prometheus/qualification/README.md) owns the execution procedure:

- [Admission](../packages/prometheus/qualification/README.md#admission): inspect and approve the source-bound manifest before execution.
- [Manifest fields](../packages/prometheus/qualification/README.md#manifest-fields): declare cases, checks, limits, and comparison arms.
- [Steps](../packages/prometheus/qualification/README.md#steps): declare prompts, native replies, mode changes, and faults.
- [Checkpoints](../packages/prometheus/qualification/README.md#checkpoints): identify expected states and saved evidence.
- [Failure and follow-up](../packages/prometheus/qualification/README.md#failure-inspection-and-follow-up): inspect retained results and carry prior consumption.

Unknown effects and unconfirmed stops block follow-up execution.
Do not reset the allowance or replay an uncertain action.

## Ordinary-Build comparison

Compare prepared-goal execution with ordinary Build under equal declared conditions:

- Use the same fixtures, model, criteria, tool boundaries, and allowances.
- Run each arm in an isolated workspace.
- Do not give ordinary Build Prometheus continuation or evaluator feedback.
- Apply the same external acceptance procedures to both arms.
- Record accepted completion, false acceptance, request counts, estimated cost, elapsed time, and human interventions.
- Declare the rubric for false acceptance before execution.
- Do not compare truncated or incomplete pairs.

The runner enforces the [comparison and resource contract](../packages/prometheus/qualification/README.md#comparison-and-resources).
Passing a scripted comparison does not establish real-model performance or general superiority.

## Release gates

Release requires:

1. Passing mechanics and native integration checks for the declared candidate and target environment.
2. Suitable passing evidence for every required [workflow and fault scenario](SCENARIOS.md#mandatory-scenario-catalog).
3. No observed unauthorized action or false acceptance.
4. A regression test for each repaired defect, followed by the affected checks.
5. Review of the final requirements, validator identities, delivered files, and required live outcomes.

An unresolved mandatory criterion or unavailable required boundary blocks release.
Repeat broader tests when central controls change. Preserve failures after repair.
Do not remove unmet requirements from the first-release scope.

The runner always reports `releaseQualified: false`.
Campaign completion cannot replace the final requirement review and required external acceptance.

Writing follows ASD-STE100 sentence conventions. Full dictionary conformity is not verified.
