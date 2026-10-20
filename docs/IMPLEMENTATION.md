# Prometheus Implementation

Status: Experimental implementation. First-release qualification is incomplete.
Date: 2026-10-16.

The user authorized implementation after publication of [SPEC.md](../SPEC.md).
The specification remains the product agreement.
This document records implementation decisions and remaining release work.

## Package boundary

The controller lives in `packages/prometheus/`.
The root browser dependencies and installer remain separate.
The root manifest adds only controller test scripts.
No global configuration, shared service, commit, or publication is part of this installation work.

The controller uses the repository's GPL version 3 license.
The package remains private during qualification.

## Milestones

| Milestone | Current evidence | Remaining gate |
| --- | --- | --- |
| M0: Baseline | Browser regression, runtime versions, package ownership, and this coverage map. | Repeat regressions after relevant changes. |
| M1: Native contract | Packaged plugin loading, commands, native session APIs, inherited restrictions, and interruption tests. | Requalify before supporting another OpenCode version. |
| M2: Minimum controller | SQLite transactions, ownership checks, resource reservations, permission denials, and stop records. | Real-model operational qualification. |
| M3: Complete loop | Native scripted failure, independent rejection, same-worker repair, and fresh accepted evidence. | Real-model inference and repair behavior. |
| M4: Spikes | Pending Plan experiments, authorized Build continuation, owned outputs, findings, and inconclusive limits. | Real-model investigation quality. |
| M5: Decisions and goals | Decision provenance, Plan preparation, natural execution, pivots, and limited goal contracts. | All declared conversational scenarios with real models. |
| M6: Recovery | Fault injection, cancellation races, unknown effects, and a real isolated service crash and restart. | Broader installed fault qualification under the selected model. |
| M7: Installed qualification | Archive loading, fresh campaign installations, multi-step checkpoints, shared metering, paired Build drivers, independent checks, and retained mechanics reports. | Paid qualification, plain-Build comparison results, and required live outcomes. |

## Coverage by subscope

| Specification | Implementation | Main evidence |
| --- | --- | --- |
| S1: Native integration | Plugin commands, scoped hooks, and native adapter. | `test/plugin.test.mjs` and `test/native/`. |
| S2: Records and handoffs | Transactional store, separate records, specification identities, and publication checks. | `test/store.test.mjs` and `test/controller.test.mjs`. |
| S3: Spikes | One child per question, owned experiments, stopping conditions, and findings. | Controller tests and native `discovery`. |
| S4: Questions | Prompt guidance, decision records, examples, validator proposals, and readiness status. | Decision tests. Question quality still needs real models. |
| S5: Specifications | Goal contracts, ordered work, preserved documents, and explicit source identities. | Controller tests for Plan, publication, and pivots. |
| S6: Validators | Executable readiness, source-version binding, fresh checks, and evaluator review. | `test/validators.test.mjs` and native `repair`. |
| S7: Execution | Conversation-based preparation, one worker, continuation, and repair. | Native `discovery` and `repair`. Language understanding still needs real models. |
| S8: Acceptance | Candidate capture, fresh evaluators, per-criterion evidence, and delivery checks. | Artifact and acceptance tests. |
| S9: Recovery | Ownership checks, cancellation, resource reservations, stopping status, and uncertain outcomes. | `test/recovery.test.mjs`, sandbox tests, and native `restart`. |
| S10: Qualification | Bound admission, aggregate campaign accounting, scenario steps, independent checks, and paired comparison reports. | Qualification harness tests, installed native campaigns, and [the evidence map](QUALIFICATION-MATRIX.md). |

Test paths in this table are relative to `packages/prometheus/`.

## Native findings

The implemented contract targets OpenCode 2.0.29.
The package rejects unqualified service versions.

- Local package directories need a root entrypoint.
- Command lists use a `data` envelope. Native session context returns an array.
- The missing-session error tag is `Session.NotFoundError`.
- Child creation preserves parent session restrictions before adding controller restrictions.
- Plan can persist operational records without publishing product documents.
- Fresh children do not receive the originating conversation.
- Native interruption reports active execution, not an already-idle originating session.
- Location activation starts recovery. A service restart alone does not activate every saved location.
- Repeated stop paths need one signal operation per owned process group.

The native suite exercises these findings without a paid model.
Live events supply notifications. SQLite records and native facts control recovery.

## Enforced boundaries and limits

The current backend uses macOS `sandbox-exec`.
It does not use a worktree as a security boundary.
The controller rejects active runtime code inside the worker's project.
Other platforms reject required process execution before admission.

Managed processes enforce project and scratch boundaries.
They protect governing files and native configuration from writes.
They strip inherited provider credentials.
Native mutation tools and Code Mode are unavailable within enrolled workflows.
The managed invocation still requires native shell permission.
That permission check does not infer every operation inside an arbitrary program.

The controller does not claim a universal sandbox or exactly-once external effects.
Candidate exclusions and external acceptance remain explicit in the runtime reference.

## Release work remains in scope

The implementation does not remove an unmet specification requirement.
Every scenario in S10 remains a first-release gate.
Deterministic provider scripts cannot establish model judgment, question quality, or autonomous reliability.

Obtain the model choice and aggregate allowance before paid qualification.
Retain failures, human interactions, resource consumption, and external evidence.
Compare prepared-goal execution with ordinary Build under equivalent conditions.
Do not publish a complete-release claim before those gates pass.

The qualification runner now supports Plan and Build sequences, expected Draft or Paused outcomes, declared human interactions, native form and permission replies, controlled mutations, and saved checkpoint identities.
Its meter covers both comparison arms and all native session requests before dispatch.
The native-Build arm uses the shared local tool and macOS process boundary. It receives no Prometheus continuation or evaluator feedback.
Approval binds source and check assets. Each campaign loads a fresh runtime copy rather than cached checkout modules.
Failed runs remain retained. Follow-up admission can carry consumed requests, observed cost, and active qualification duration.
Unconfirmed stops and unknown prior effects block that follow-up path.
The runner never declares full-release qualification from a campaign result alone.

Qualification review exposed a controller capability gap.
A retained worker role could permit product writes or network execution after that native session switched to Plan.
Regressions reproduced both paths before the repair.
Managed processes now inspect the current native mode. Plan processes have read-only product access and cannot request network execution.
Action records identify the native mode and applied write capability.
An installed scripted test verifies the worker-mode switch against the actual service.

See [the qualification context](QUALIFICATION-CONTEXT.md) for recorded results and the original evidence archive.

Writing follows ASD-STE100 sentence conventions. Full dictionary conformity is not verified.
