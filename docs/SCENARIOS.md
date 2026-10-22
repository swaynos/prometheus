# Scenarios

Status: Required checks are mapped. Real-model verification remains incomplete.
The specification remains the agreement. A mapped check is not a passing result.

A scenario defines the behavior to test and the observations needed to assess it.
Use this reference to select scenarios and map requirements to checks.
Use [Verification](VERIFICATION.md) to run checks, assess evidence, and review release readiness.

## Evidence and identity

Use the [evidence classes](VERIFICATION.md#evidence-classes) without substituting one class for another.

For each acceptance claim, retain the specification, validator, candidate, environment, and evidence identities.
For each campaign, retain the approved manifest and source binding.
Keep failures, resource consumption, controlled injections, declared decisions, and unexpected rescue.

Paths below are relative to `packages/prometheus/` unless stated otherwise.

## Mandatory scenario catalog

`qualification/scenarios.mjs` defines W01–W19 and F01–F15.
Each fault specifies the expected state, permitted next action, and required evidence.
Print the catalog without service access or model work:

```sh
npm --prefix packages/prometheus run qualification:catalog
```

W01–W17 map the mandatory workflow scenarios in S10.3.
W18 maps the complete installed first-release demonstration.
W19 checks the already-completed-goal boundary in S7.1.
The fault catalog maps S10.4. Deterministic tests establish precise fault mechanics.
Use installed native tests where the behavior depends on actual session, process, or service behavior.

Campaign scenario tags are an index. They are not proof that the checks are suitable.
An example campaign does not cover every mandatory scenario.

## Requirement-to-check map

| Requirement | Observable check | Mechanical evidence | Remaining behavior or outcome evidence |
| --- | --- | --- | --- |
| S1: Ordinary native behavior remains intact. | Unenrolled sessions retain tools and instructions. No new user-facing agent or `/plan` command appears. | `test/plugin.test.mjs`; `test/native/capabilities.test.mjs`; root browser regressions. | W17. Inspect the installed user workflow, not only registry entries. |
| S1: Plan restrictions apply to children. | A write experiment stays pending. Applicable native denials survive child creation. A worker switched to native Plan loses product-write and network capability. | `test/controller.test.mjs`; `test/capability.test.mjs`; native capabilities, discovery, and worker-mode switch. | W01 and F13 with a real model. |
| S1: Mode changes preserve intent. | Switching to Build starts nothing. Explicit investigation continuation does not implement the product. | Native discovery; installed scenario checkpoints. | W02. |
| S1: Registration and version reporting are correct. | User command collisions are preserved. The supported service and loaded plugin are identified. | Native packaged loading; runner preflight. | Repeat for each newly supported service version. |
| S2: Durable handoffs preserve the agreement. | Restart retains intent, authority, findings, worker identity, pending actions, and consumption. | Store, controller, recovery, and native restart tests. | F02, F03, F09, F10; W05 and W15 under real use. |
| S2: Publication preserves user work. | Unknown or concurrently edited `SPEC.md` is not overwritten. Preparation differs from approval and publication. | Controller publication tests; artifact capture tests. | W07, W11, W15. |
| S2: Evidence remains correctly associated. | Foreign task, run, candidate, or specification evidence cannot establish acceptance. | Controller acceptance and contract tests. | W13, W16, F15. |
| S3: Investigations are bounded. | Each spike has a question, dependent decision, allowance, observations, and stopping condition. Related follow-up retains its child. | Contracts and controller spike tests. | W01–W05. Judge the investigation question and finding quality. |
| S3: Restrictions and inconclusive results are honest. | Plan cannot perform prohibited experiments. Build remains investigation. Exhaustion produces an inconclusive finding rather than unlimited work. | Native discovery; controller and recovery limit tests. | W01, W02; inspect provenance and stated limitations. |
| S4: Questions add necessary decisions. | Discoverable facts are inspected. Answered preferences are reused. Consequential choices include an example and validator. | Decision record tests establish provenance only. | W03–W05 and W10. Apply the question-quality rubric below. |
| S4: Corrections and readiness are explicit. | Corrections change decisions without rewriting findings. The agent declares Ready, Needs investigation, or Needs a user decision. | Decision and finding contracts; scripted discovery. | W05 and W18. |
| S5: Specifications define observable work. | Criteria, prerequisites, missing validator construction, scope, protections, limits, pause conditions, and delivery are identifiable. | Goal contracts, rendering, publication, and pivot tests. | W07–W12 and W18. Review suitability, not only field presence. |
| S5: Approval and pivots remain bounded. | Approval identifies a version. Changes are examined before dependent dispatch. A changed acceptance meaning needs a user decision. | Controller specification-change and pivot tests. | W15. Historical consumption must remain visible. |
| S6: Validators are usable. | Procedures run, do not silently skip required work, reject relevant defects, and pass controlled good examples where feasible. | Validator source tests; controlled export and validator-oracle checks. | W06, W09, W13. A fresh evaluator must judge coverage and suitability. |
| S6: Test changes cannot silently weaken acceptance. | Relevant changes invalidate readiness and affected evaluations. Legitimate repairs remain possible. | `test/validators.test.mjs`; source hashes in process evidence. | F11 and real-model evaluator review. No blanket test-edit ban applies. |
| S6: Validator-only goals remain limited. | Validators can be accepted while the incomplete product correctly fails. Product implementation does not begin. | Intent contracts; validator-only independent checks. | W06. Missing required validation capability must prevent acceptance. |
| S7: Execution needs no repeated implementation prompt. | Bare `/goal` infers the agreement. Direct Build prepares as necessary. Natural execution starts the identifiable goal. | Native discovery and scenario-runner tests. | W07–W12 and W18. Scripts do not establish language understanding. |
| S7: Repair retains the worker and scope. | One fresh worker excludes the originating conversation. Rejection returns to that worker. Partial output does not establish completion. | Native repair and installed scenario tests. | W13, W18, W19. No hidden attempt quota or mandatory strategy change. |
| S8: Acceptance is independent and complete. | Fresh evaluators use the exact specification, validators, candidate, and environment. Every required criterion passes. | Controller acceptance tests; fresh evaluator identities and receipts. | W13, W14, W18. Contradictory criteria and deficient validators need real-model judgment. |
| S8: Missing external evidence prevents acceptance. | Browser and user criteria require origin-bound evidence for the relevant candidate. Prometheus never invokes `/browser`. | Controller external-acceptance tests; separate browser regressions. | W16 and the required human-invoked browser observation. |
| S8: Delivery matches acceptance. | Capture includes relevant untracked files. User edits survive. Stale or unrelated delivery cannot inherit acceptance. | Artifact and controller tests. | W18; F04, F12, F15. Excluded or external deliverables need another evidence method. |
| S9: Boundaries are enforceable. | Managed processes cannot mutate protected code, instructions, state, credentials, or external paths. Children retain native restrictions. | Sandbox tests; native capabilities; bounded native-Build scenarios. | F13, F14. No universal operating-system or network-security certification is claimed. |
| S9: Resources are aggregate and durable. | Spikes, workers, evaluators, auxiliary requests, fallbacks, and uncertain usage share the allowance. Restart and follow-up do not refund reservations. | Controller resource tests; campaign ledger tests; installed budget case. | F10. Cost observations remain estimates, not billing guarantees. |
| S9: Cancellation separates request from cessation. | New dispatch stops. Owned activity is interrupted. Late receipts cannot clear cancellation. Unrelated work remains untouched. | Recovery tests; native origin, worker, and evaluator cancellation; campaign cancellation checks. | F05, F08 under the declared environment. Remote cessation needs destination evidence. |
| S9: Recovery does not replay unknown effects. | Durable state, native activity, processes, ownership, and usage are reconciled before dispatch. Unknown effects remain visible. | Recovery tests; isolated service crash; controlled loopback destination tests. | F01–F10. A local laboratory destination is not proof of an unrelated live business outcome. |
| S10: Installed verification is repeatable and honest. | Admission binds runtime, fixtures, and checks. Paired arms have equal declared inputs and allowances. Failed and rescued runs remain visible. | Scenario-runner harness and isolated native campaign tests. | The approved real-model campaign and ordinary-Build comparison remain pending. |
| First release: The complete workflow succeeds. | Plan → investigation → decisions → readiness → inferred goal → authorized execution → validators → implementation and repair → fresh acceptance → matching delivery → durable final state. | Scripted native discovery and repair establish parts of the mechanics. | W18 must demonstrate the complete sequence with real models. Validator-only completion and unchanged native behavior are additional gates. |

## Question-quality rubric

For W03–W05, W10, and W18, retain evidence for these observations:

1. The agent inspects discoverable technical facts instead of asking the user to determine them.
2. The agent asks only unresolved consequential preferences or authority questions.
3. The agent supplies a concrete interpretation, acceptance example, and proposed validator.
4. The agent reuses prior answers unless relevant facts change.
5. Corrections change the proposed agreement without changing historical observations.
6. Readiness identifies the remaining blocker or correctly declares execution readiness.

Use a fresh review of native message and record references.
Do not give that reviewer a worker completion narrative as proof.
Count declared user answers separately from unexpected implementation rescue.

## Implementation milestones

| Milestone | Mechanical evidence | Remaining gate |
| --- | --- | --- |
| M0: Baseline | Browser tests, runtime identities, package ownership, coverage map. | Repeat affected tests after changes. |
| M1: Native contract | Package loading, commands, native sessions, restrictions, interruption. | Repeat native verification before extending compatibility policy. |
| M2: Minimum controller | Transactions, ownership, reservations, denials, stop records. | Real-model operational checks. |
| M3: Complete loop | Scripted rejection, same-worker repair, fresh accepted evidence. | Real-model inference and repair. |
| M4: Spikes | Plan experiments, authorized Build continuation, owned outputs, findings, limits. | Real-model investigation quality. |
| M5: Decisions and goals | Decision provenance, preparation, execution, pivots, limited goals. | Required conversations with real models. |
| M6: Recovery | Fault injection, cancellation, unknown effects, isolated service restart. | Installed fault scenarios with the selected model. |
| M7: Installed verification | Fresh installations, checkpoints, metering, paired arms, retained reports. | Real-model campaigns, ordinary-Build comparison, required live outcomes. |

The runner supports Plan and Build sequences, declared human replies, expected pauses, and independent checks.
Admission binds runtime source, fixtures, reference examples, and procedures.
Each campaign loads a fresh protected runtime copy.
One durable allowance covers both comparison arms and all metered sessions.
See the [runner reference](../packages/prometheus/qualification/README.md) for the detailed contract.

## Release review

Apply the [release gates](VERIFICATION.md#release-gates) to this map and the final candidate.
A mapped check is not a passing result.

Writing follows ASD-STE100 sentence conventions. Full dictionary conformity is not verified.
