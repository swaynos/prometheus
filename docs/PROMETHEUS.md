# Prometheus Reference and Implementation

Status: Experimental implementation. First-release qualification is incomplete.
Date: 2026-10-16.

Read [SPEC.md](../SPEC.md) for the product agreement.
Read the [package guide](../packages/prometheus/README.md) for installation and limits.
Read [QUALIFICATION.md](QUALIFICATION.md) for verification procedures and evidence.
Read [RESOURCE-SELECTION.md](RESOURCE-SELECTION.md) for browser tool rules.

Writing follows ASD-STE100 conventions. Full dictionary conformity is not verified.

## 1. Package Boundary

The controller code is in `packages/prometheus/`.
Root browser dependencies and the installer stay separate.
The root package manifest adds only controller test scripts.
Installation does not add global configuration, start a shared service, or make git commits.
The controller uses the GNU General Public License version 3.
The package stays private during qualification.

## 2. Goal Inference and Authority

Discuss the outcome before you enter `/goal`.
The agent uses conversation context, findings, and user decisions.
You do not need to repeat an agreed outcome.

In Plan mode, the agent records a proposed goal.
The record defines criteria, validators, dependencies, authority, and limits.
Plan mode does not write project files or start execution.

In Build mode, `/goal` authorizes execution.
The agent completes preparation in that request.
A switch to Build mode alone does not supply execution authority.

Optional text changes the inferred outcome.
For example, "create the validators without implementation" selects a limited goal.
"Create validators first" specifies an intermediate step.
The agent must resolve that difference from context or ask one focused question.

The implementation detects exact natural execution and resume requests.
Examples include "Execute your plan" and "Resume the goal".
Other wording can require `/goal` to establish execution authority.
Unrestricted natural-language understanding is not mechanically verified.

## 3. Spikes and Decisions

Each spike answers one question in its own child session.
Independent spikes share the task allowance.
Write experiments require Build mode and explicit investigation authority.
Experiment outputs stay in owned experiment directories.

Spike findings use one of three statuses:
- Supported
- Disproved
- Inconclusive

Findings record observations, interpretations, limitations, and evidence references.
User corrections change decisions. Corrections do not change historical observations.

The `/grill-me` command can precede, follow, or separate spikes.
The agent asks for user preferences rather than discoverable technical facts.
The agent provides an acceptance example and a proposed validator.
The interaction ends with one of three states:
- Ready
- Needs investigation
- Needs a user decision

## 4. Runtime Records and Storage

Each native project uses one SQLite runtime store.
Workspaces keep separate task records in that store.
Conflicting executions cannot own overlapping workspace paths.
Use the originating conversation to revise or resume a paused goal.

You can request retirement to end a run without acceptance.
Retirement requires native user permission and settled operation outcomes.
Retirement preserves evidence and consumed allowances. It does not delete artifacts.
An explicit subsequent goal can start a new worker after retirement.

The private directory contains the store, evidence, candidate captures, and scratch directories.
File permissions must prevent access by other users (mode 0700).
The store rejects symlinked private paths and unsupported schema versions.

Records separate:
- Tasks and specifications
- Runs and sessions
- Findings and decisions
- Dispatches and evidence
- Evaluations

Related state changes and audit events share one transaction.
The runtime does not copy full native conversations into SQLite.

Task approval is separate from document creation.
Specification publication preserves unrelated existing content in `SPEC.md`.
An unchanged, previously owned specification can receive an authorized revision.
Concurrent edits prevent silent replacement.

## 5. Worker Execution and Acceptance

Execution uses one fresh native Build worker.
The controller supplies the specification and relevant findings.
The controller does not supply the full planning conversation.

The worker creates validators when needed.
The worker supplies evidence that validator procedures operate.
A fresh evaluator session examines that evidence and the candidate.

Acceptance records identify:
- Specification version
- Candidate manifest
- Validator declarations
- Evaluator session identity
- Evidence for each criterion
- Delivery location

The candidate manifest identifies validator files in the candidate.
Validator declarations list mutable procedure sources and configuration files.
The controller hashes those files before and after readiness checks.
A change to a declared file invalidates readiness and requires fresh evidence.

The evaluator checks whether declared files and controlled examples cover the required procedure.
The controller cannot infer every dependency of arbitrary code.
Missing evidence prevents a pass verdict.
Worker assertions cannot replace evaluator evidence.
User and browser criteria require origin-bound external acceptance evidence.

Native file mutation tools and unrestricted shell execution are disabled in enrolled workflows.
All worker file changes use the managed process boundary.
Managed processes inspect the current native session mode, not only the retained worker role.
Plan-mode processes have read-only product access and cannot request network execution.
Action records identify the native mode and the applied write capability.

The evaluator executes only declared validator procedures.
Evaluator processes cannot write candidate files.
Native recursive content searches use the managed process boundary.
Native `grep` remains available for one assessed file.

## 6. Process Boundaries and Security Limits

The process boundary currently supports macOS `sandbox-exec`.
The controller rejects active runtime code in the worker project directory.
Non-macOS platforms reject process execution before launch.
The controller does not use git worktrees as security boundaries.

Managed processes enforce these rules:
- Reads are restricted to the project, owned scratch, and required system toolchains.
- Process writes stay inside authorized project and scratch paths.
- Runtime code, specifications, instructions, and private stores are write-protected.
- Inherited provider credentials are stripped from the environment.
- External hardlink creation is blocked.
- Sibling paths, symlink escapes, and macOS Data-volume aliases are blocked.

Managed process execution requires native shell permission.
That permission check does not infer every operation inside an arbitrary program.
The controller does not claim universal operating-system security or exactly-once external effects.

## 7. Cancellation and Crash Recovery

To pause work, submit "Pause the goal" in the originating conversation or interrupt the worker.
Interrupting an active originating session also pauses owned work.
An idle originating session does not emit an execution event. Pause it with a message or worker interrupt.

The controller blocks new dispatch after a durable pause.
The controller requests interruption of owned activity.
The status record separates requested stops from confirmed cessation.
The status record shows unresolved stop outcomes.
Pausing does not stop unrelated sessions or the shared service.

A local stop does not prove that a remote effect stopped.
Unknown external effects remain visible.
Status inspection does not resume work.
Resuming work after a durable pause requires explicit user authorization.

Recovery inspects native sessions before dispatch.
An absent message after compaction does not prove that dispatch had no effect.
The controller does not replay uncertain dispatches.

Process records retain host, PID, process group, token, and scratch location.
After a service crash, a PID alone does not establish process ownership.
Do not terminate an unrelated process that reused that PID.
Cross-host ownership blocks automatic takeover.
An active local owner also blocks automatic takeover.

Subsequent product edits invalidate current acceptance.
The accepted historical record remains available.
A new explicit execution request starts checks for a new candidate.

The runtime preserves request reservations across restarts.
The allowance starts when the conversation enters Prometheus.
Earlier unrelated conversation costs do not count against the allowance.
HTTP requests and WebSocket handshakes use conservative accounting.
Fallbacks and uncertain requests consume reservations.
Observed cost values are estimates.

An operator can inspect a task without model requests:

```sh
node packages/prometheus/src/admin.mjs inspect /absolute/path/to/project-state TASK_ID
```

An operator can grant a new total allowance:

```sh
node packages/prometheus/src/admin.mjs grant /absolute/path/to/project-state TASK_ID NEW_TOTAL_REQUESTS [DEADLINE] [MAX_USD]
```

Arguments:
- `NEW_TOTAL_REQUESTS`: Integer count including consumed and uncertain requests.
- `DEADLINE`: Optional Unix timestamp in milliseconds. Use `-` to keep the current deadline.
- `MAX_USD`: Optional positive cost limit estimate.

The grant command records an operator decision in SQLite. It does not resume the run.
Resume the task explicitly in the originating Build conversation.

Reconcile uncertain operations before continuation:
- Collect observation evidence first.
- The internal reconciliation action requires native user permission.
- It records effect or no-effect without replaying the operation.
- Users do not need to edit SQLite records directly.

Interrupted local processes use normal repair.
Interrupted network processes can leave external effects unknown and require reconciliation.

## 8. Separate Browser Workflow

Prometheus does not invoke `/browser`.
When criteria require browser evidence, the criterion stays unresolved.
The user runs browser actions in a separate native conversation outside Prometheus.
The originating conversation records external evidence for the relevant candidate.
Recording external acceptance evidence requires native user permission.

## 9. Implementation Milestones

| Milestone | Current Evidence | Remaining Gate |
| --- | --- | --- |
| M0: Baseline | Browser regression, runtime versions, package ownership, coverage map. | Repeat regressions after relevant changes. |
| M1: Native contract | Packaged plugin loading, commands, native session APIs, restrictions, interruptions. | Requalify before supporting new OpenCode versions. |
| M2: Minimum controller | SQLite transactions, ownership checks, resource reservations, permission denials, stop records. | Real-model operational qualification. |
| M3: Complete loop | Native scripted failure, independent rejection, same-worker repair, fresh accepted evidence. | Real-model inference and repair behavior. |
| M4: Spikes | Pending Plan experiments, authorized Build continuation, owned outputs, findings, limits. | Real-model investigation quality. |
| M5: Decisions and goals | Decision provenance, Plan preparation, natural execution, pivots, limited goal contracts. | All declared conversational scenarios with real models. |
| M6: Recovery | Fault injection, cancellation races, unknown effects, isolated service crash and restart. | Installed fault qualification under selected model. |
| M7: Installed qualification | Archive loading, campaign installs, multi-step checkpoints, shared metering, paired arms, reports. | Paid qualification, plain-Build comparisons, live outcomes. |

## 10. Subscope Coverage (S1–S10)

Test paths are relative to `packages/prometheus/`.

| Subscope | Implementation | Main Evidence |
| --- | --- | --- |
| S1: Native integration | Plugin commands, scoped hooks, native adapter. | `test/plugin.test.mjs`, `test/native/`. |
| S2: Records and handoffs | Transactional store, separate records, specification identities, publication checks. | `test/store.test.mjs`, `test/controller.test.mjs`. |
| S3: Spikes | One child per question, owned experiments, stop conditions, structured findings. | Controller tests, native `discovery`. |
| S4: Questions | Prompt guidance, decision records, examples, validator proposals, readiness states. | Decision tests. Quality needs real models. |
| S5: Specifications | Goal contracts, ordered work, preserved documents, explicit source identities. | Plan, publication, and pivot tests. |
| S6: Validators | Executable readiness, source-version binding, fresh checks, evaluator review. | `test/validators.test.mjs`, native `repair`. |
| S7: Execution | Conversation-based preparation, single worker, continuation, repair. | Native `discovery`, `repair`. Needs real models. |
| S8: Acceptance | Candidate capture, fresh evaluators, per-criterion evidence, delivery checks. | Artifact and acceptance tests. |
| S9: Recovery | Ownership checks, cancellation, reservations, stopping status, uncertain outcomes. | `test/recovery.test.mjs`, sandbox tests, native `restart`. |
| S10: Qualification | Bound admission, aggregate campaign accounting, scenario steps, paired comparisons. | Qualification harness, installed native campaigns, [QUALIFICATION.md](QUALIFICATION.md). |

## 11. Preserved Native Findings

The implementation targets OpenCode 2.0.29. The package rejects other versions.
Key verified facts:
1. Local package directories require a root entrypoint.
2. Command lists use a `data` envelope; native session context returns an array.
3. The missing-session error tag is `Session.NotFoundError`.
4. Child creation preserves parent session restrictions before adding controller restrictions.
5. Fresh child sessions do not receive the originating conversation.
6. Plan mode persists operational records without publishing product documents.
7. Native interruption reports active execution, not an idle originating session.
8. Location activation starts recovery; a service restart alone does not activate saved locations.
9. Repeated stop paths require one signal operation per owned process group.
