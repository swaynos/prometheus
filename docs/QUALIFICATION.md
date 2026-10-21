# Prometheus Qualification Reference and Evidence Map

Status: Mechanics verified. First-release qualification remains incomplete.
Date: 2026-10-16.

Read [SPEC.md](../SPEC.md) for the product agreement.
Read [PROMETHEUS.md](PROMETHEUS.md) for runtime and implementation architecture.
Read [RESOURCE-SELECTION.md](RESOURCE-SELECTION.md) for browser tool rules.

Writing follows ASD-STE100 conventions. Full dictionary conformity is not verified.

## 1. Evidence Classes

Keep these four classes separate:
1. Deterministic tests: establish controller mechanics.
2. Scripted native tests: establish integration mechanics.
3. Real-model tests: establish observed model behavior.
4. Live checks: establish external outcomes.

Do not substitute one class for another.
A scripted provider is not a real model.
A successful model run does not establish every external outcome.

## 2. Test Execution and Repeat Mechanics

Run these commands from the repository root:

```sh
npm ci
npm ci --prefix packages/prometheus
npm test
npm run test:controller
npm run test:controller:native
```

Environment requirements:
- Native integration tests require installed OpenCode 2.0.29.
- Native tests create isolated services and configuration roots.
- Native tests do not restart the shared service or use paid providers.
- Scripted tests permit only the local fixture provider.
- Native crash tests terminate only owned isolated service groups.
- Location activation starts recovery without model requests or automatic action replays.
- Process-boundary tests require macOS `sandbox-exec`. Record platform skips on other platforms.
- Linux controller execution is not supported. The current process boundary requires macOS `sandbox-exec`.
  Implement and verify a Linux process boundary in a Linux environment before claiming controller support.
  Linux browser support does not establish Linux controller support. No Linux controller fix is included in this update.
- Controlled destination tests record loopback effects before disconnected or held replies. They verify observation without replays.

## 3. Real-Model Admission and Campaign Runner

Obtain the user model choice and aggregate allowance before paid execution.
Declare tasks, fixtures, expected evidence, and stop conditions first.
Use owned test workspaces rather than product checkouts.
Retain unsuccessful runs, human interventions, and resource consumption.

The qualification runner uses a two-phase approval protocol:

Phase 1 (Approval fingerprint generation):
Run the command with the manifest path:

```sh
node packages/prometheus/qualification/run.mjs --manifest /absolute/path/to/manifest.json
```

This invocation prints the approval fingerprint. It does not start services, write output, or call models.
The fingerprint binds runtime source, fixtures, references, independent checks, and manifest bytes.

Phase 2 (Execution):
Supply the approval fingerprint and an output directory:

```sh
node packages/prometheus/qualification/run.mjs --manifest /absolute/path/to/manifest.json --approval THE_FINGERPRINT --output /absolute/path/to/new-results
```

The output directory must not exist before execution.
The runner stores artifacts, ledger entries, and private state in that directory.
Inspect results without resuming:

```sh
node packages/prometheus/qualification/run.mjs --inspect /absolute/path/to/results
```

For repairs, specify `previousCampaign` in a new approved manifest.
The follow-up campaign carries prior requests, estimated cost, and active duration.
Unconfirmed stops and unknown prior effects block follow-up admission.

Reference manifest files in `packages/prometheus/qualification/`:
- `example.json`: smoke-test template.
- `campaign.example.json`: multi-step and paired comparison example.
- `discovery.example.json`: declared human decisions and controlled independent rejection.

## 4. Current Qualification Snapshots

### Harness Snapshot (2026-10-16)

| Suite | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Controller and qualification mechanics | 109 | 0 | 0 |
| Installed native integration | 13 | 0 | 0 |
| Browser regression | 50 | 0 | 3 |
| **Total** | **172** | **0** | **3** |

Snapshot metadata:
- Source fingerprint: `2efd967eac5294efdb4541545ab956c7c29d11974c3b226fc0a367ce275f5683`.
- Manifest: 89 runtime, test, lock, specification, and control files.
- Environment: macOS 26.6.2, Node v24.15.0, npm 11.12.1, OpenCode 2.0.29.
- Raw reports location: `.prometheus-local/qualification-mechanics-2a63t9my/`.
- Paid model requests: None (local scripted provider only).
- Three browser display skips reflect missing Linux virtual-display tools on macOS.

### Original Baseline Snapshot (2026-10-16)

| Suite | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Browser regression | 50 | 0 | 3 |
| Controller mechanics | 73 | 0 | 0 |
| Installed native integration | 6 | 0 | 0 |
| **Total** | **129** | **0** | **3** |

Baseline metadata:
- Package: `opencode-prometheus` version 0.1.0 (experimental, private).
- Repository base commit: `6222bb85794ab3e751cf71ffd698004c10f27ad9`.
- Source fingerprint: `ab6c9499550ebccde4433b3d779851e98ff933ef76ea557142bec3955284f06f` (30 files).
- Host: macOS 26.6.2 build 25G83, Node v24.15.0, npm 11.12.1, OpenCode 2.0.29.
- Paid model requests: None.

Archive download: [qualification-2026-10-16.tar.gz](archives/qualification-2026-10-16.tar.gz).
Archive SHA-256: `74df9b9492590fa1fba408d0388bebfb79583e27adcbbe16d50337b91a593405`.
Preserved files:
- `qualification/2026-10-16-browser.tap`
- `qualification/2026-10-16-controller.tap`
- `qualification/2026-10-16-native.tap`
- `qualification/2026-10-16-source.json`
- `qualification/2026-10-16-mechanics.md`

## 5. Verified Mechanics and Boundaries

The test evidence establishes these mechanics:
1. Extension loading: packaged extensions load correctly. Command collisions preserve user commands. Child sessions inherit permission denials.
2. Worker separation: fresh workers exclude originating conversations. Evaluator rejections return repairs to the same worker. Evaluators assess the repaired candidate.
3. Plan and Build boundaries: Plan records pending experiments without product writes. Investigation continuation does not write product files. Switching native mode to Plan disables writes and network access.
4. Discovery workflow: scripted discovery preserves decisions, Plan preparation, and natural execution as separate steps.
5. Cancellation and pause: cancellations block acceptance. Stop records distinguish requested stops from confirmed cessation.
6. Crash recovery: recovery preserves consumption and records unknown effects. Location activation does not replay uncertain operations or replace workers.
7. Fault resilience: transactions protect state, ownership, duplicate dispatches, forged fields, cancellation races, and lost completion events.
8. Capture and validation: captures preserve concurrent user edits. Modifying declared validator files invalidates previous readiness evidence.
9. Process sandbox: managed processes protect governing files, credentials, external paths, hardlinks, symlinks, and volume aliases.

## 6. Requirement-to-Check Map (S1–S10)

Paths are relative to `packages/prometheus/`.

| Requirement | Observable Check | Mechanical Evidence | Remaining Behavior or Outcome Evidence |
| --- | --- | --- | --- |
| S1: Ordinary native behavior remains intact. | Unenrolled sessions retain tools and instructions. No new agent or `/plan` appears. | `test/plugin.test.mjs`, `test/native/capabilities.test.mjs`, root browser tests. | W17: Inspect user workflow. |
| S1: Plan restrictions apply to children. | Write experiments stay pending. Inherited denials survive. Worker in Plan loses product writes and network. | `test/controller.test.mjs`, `test/capability.test.mjs`, native tests. | W01 and F13 with real models. |
| S1: Mode changes preserve intent. | Switching to Build starts nothing. Investigation continuation does not write products. | Native discovery, qualification checkpoints. | W02. |
| S1: Registration and version reporting are correct. | User command collisions are preserved. Service and plugin identities are reported. | Native packaged loading, qualification preflight. | Requalify with each new service version. |
| S2: Durable handoffs preserve agreement. | Restart retains intent, authority, findings, worker identity, actions, consumption. | Store, controller, recovery, and native restart tests. | F02, F03, F09, F10, W05, W15 in real use. |
| S2: Publication preserves user work. | Concurrently edited `SPEC.md` is not overwritten. Preparation differs from approval and publication. | Controller publication tests, artifact capture tests. | W07, W11, W15. |
| S2: Evidence remains correctly associated. | Foreign task, run, candidate, or specification evidence cannot establish acceptance. | Controller acceptance and contract tests. | W13, W16, F15. |
| S3: Investigations are bounded. | Spikes have questions, dependent decisions, allowances, observations, stop conditions. | Contracts and controller spike tests. | W01–W05: Judge question and finding quality. |
| S3: Restrictions and inconclusive results are honest. | Prohibited Plan experiments are blocked. Exhaustion produces inconclusive findings. | Native discovery, recovery limit tests. | W01, W02: Inspect limitations. |
| S4: Questions add necessary decisions. | Facts are inspected. Answered preferences are reused. Consequential choices supply examples. | Decision record tests. | W03–W05, W10: Apply question rubric. |
| S4: Corrections and readiness are explicit. | Corrections update decisions without changing findings. Agent declares readiness states. | Decision and finding contracts, scripted discovery. | W05, W18. |
| S5: Specifications define observable work. | Criteria, prerequisites, validator construction, scope, limits, delivery are defined. | Goal contracts, rendering, publication, pivot tests. | W07–W12, W18: Review suitability. |
| S5: Approval and pivots remain bounded. | Approval identifies versions. Changes are examined before dispatch. Changes require user decisions. | Controller specification-change and pivot tests. | W15: Historical consumption must stay visible. |
| S6: Validators are usable. | Procedures execute, do not skip work, reject defects, pass controlled examples. | Validator source tests, controlled export/oracle checks. | W06, W09, W13: Fresh evaluator review. |
| S6: Test changes cannot silently weaken acceptance. | Relevant changes invalidate readiness and evaluations. Legitimate repairs remain possible. | `test/validators.test.mjs`, source hashes. | F11, evaluator review. No blanket test-edit ban. |
| S6: Validator-only goals remain limited. | Validators pass while incomplete product fails. Product implementation does not start. | Intent contracts, validator-only checks. | W06: Missing validation capability blocks acceptance. |
| S7: Execution needs no repeated prompt. | Bare `/goal` infers agreement. Build prepares as needed. Natural execution starts goal. | Native discovery, qualification tests. | W07–W12, W18: Language understanding. |
| S7: Repair retains worker and scope. | Worker excludes planning conversation. Rejection returns to same worker. Partial output fails. | Native repair, qualification tests. | W13, W18, W19: No hidden attempt quotas. |
| S8: Acceptance is independent and complete. | Fresh evaluators use exact specification, validators, candidate, environment. Every criterion passes. | Controller acceptance tests, fresh evaluator identities. | W13, W14, W18: Judge criteria and validators. |
| S8: Missing external evidence prevents acceptance. | Browser and user criteria require origin-bound evidence. Prometheus never calls `/browser`. | Controller external-acceptance tests, browser tests. | W16: Human browser observation required. |
| S8: Delivery matches acceptance. | Capture includes untracked files. User edits survive. Stale delivery cannot inherit acceptance. | Artifact and controller tests. | W18, F04, F12, F15: External deliverable checks. |
| S9: Boundaries are enforceable. | Managed processes cannot mutate protected files, credentials, external paths. Children inherit denials. | Sandbox tests, native capabilities, bounded Build runs. | F13, F14: Platform coverage checks. |
| S9: Resources are aggregate and durable. | All sessions, workers, evaluators, fallbacks, and uncertain usage share allowance. Restarts do not refund. | Controller resource tests, campaign ledger tests. | F10: Cost observations remain estimates. |
| S9: Cancellation separates request from cessation. | New dispatch stops. Owned activity is interrupted. Late receipts do not clear cancellation. | Recovery tests, native cancellation tests. | F05, F08: Remote cessation evidence needed. |
| S9: Recovery does not replay unknown effects. | State, processes, ownership, usage reconciled before dispatch. Unknown effects remain visible. | Recovery tests, isolated service crash tests. | F01–F10: Replay prevention checks. |
| S10: Installed qualification is repeatable and honest. | Admission binds runtime, fixtures, checks. Paired arms have equal inputs and allowances. | Qualification harness, native campaigns. | Real-model campaign and paired comparison pending. |
| First release: Complete workflow succeeds. | Plan → investigation → decisions → readiness → inferred goal → execution → validation → repair → acceptance → delivery. | Scripted native discovery and repair tests. | W18: Complete sequence with real models. |

## 7. Mandatory Scenario Catalog

The file `packages/prometheus/qualification/scenarios.mjs` defines workflow scenarios W01–W19 and fault cases F01–F15.
Print the scenario catalog without service access or model requests:

```sh
npm --prefix packages/prometheus run qualification:catalog
```

Key behavior scenarios:
1. Bare `/goal` infers the agreed outcome.
2. Plan prepares without writing product files.
3. Build execution requires no repeated implementation prompt.
4. Investigation continuation does not become product implementation.
5. Grilling works before, between, and after spikes.
6. Validator-only execution completes without product implementation.
7. Validators as an intermediate step do not truncate the goal.
8. Independent evaluation rejection returns work to the same worker.
9. Contradictory criteria prevent false acceptance.
10. Scope changes preserve history and consumed allowances.
11. Service restarts do not duplicate uncertain actions.
12. Missing browser evidence leaves criteria unresolved.
13. Native sessions outside Prometheus preserve standard behavior.
14. Complete end-to-end workflow succeeds under real models (W18).

Record declared human interactions separately from unexpected rescue actions.
Do not classify manual repair as unattended success.

## 8. Question-Quality Rubric

Evaluate discovery turns (W03–W05, W10, W18) against these six checks:
1. The agent inspects discoverable facts instead of asking the user to find them.
2. The agent asks only unresolved consequential preference or authority questions.
3. The agent provides an interpretation, an acceptance example, and a proposed validator.
4. The agent reuses answered preferences unless facts change.
5. Corrections update decisions without modifying historical observations.
6. The agent identifies blockers correctly or declares execution readiness.

## 9. Plain-Build Comparison

Compare prepared-goal execution with ordinary Build under identical conditions:
- Use identical fixtures, model selections, criteria, tool boundaries, and allowances.
- Execute ordinary Build in an isolated workspace.
- Do not provide ordinary Build with Prometheus continuation or evaluator feedback.
- Apply identical external acceptance procedures to both arms.
- Record accepted completion, false acceptance, request counts, estimated costs, elapsed times, and human interventions.
- Use a declared rubric to measure false acceptance. Truncated pairs cannot be compared.

## 10. Release Gates

Release requires these conditions:
1. Passing mechanics and native integration tests for the target environment.
2. Passing evidence for every mandatory workflow scenario (W01–W19) and fault scenario (F01–F15).
3. Zero observed unauthorized actions and zero false acceptances.
4. Regression tests added for every fixed defect before re-testing.
5. Review of the final candidate: requirement map, validator versions, delivered files, and live outcomes.

The qualification runner always outputs `releaseQualified: false`.
Campaign completion alone cannot substitute for human release review.
