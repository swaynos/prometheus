# Prometheus — Project specification

Status: Native OpenCode V2 design. This document defines requirements, not verification results.

## Purpose

Prometheus adds technical investigation, requirement clarification, and independent verification to OpenCode V2.
OpenCode owns execution. Prometheus does not supply a second agent loop, shell runner, or sandbox.

## Commands

| Owner | Command | Purpose |
| --- | --- | --- |
| Prometheus | `/spike <question>` | Investigate a technical question with permitted native tools. |
| Prometheus | `/grill-me [instructions]` | Resolve consequential user decisions. |
| OpenCode | `/goal <objective>` | Continue work toward an explicit objective. |

Prometheus must not register, replace, invoke, resume, or clear `/goal`.
Native `/goal pause`, `/goal resume`, and `/goal clear` retain their native meaning.
An empty native `/goal` reports usage or status. It does not infer an objective from the conversation.
There is no Prometheus `/plan` command and no additional user-facing agent.

## Native command execution

Commands submit a prompt through `ctx.session.prompt` to the current session.
They preserve prompt attachments, delivery mode, selected agent, model, and native permissions.
They do not enroll the session in a controller or start implementation automatically.

Use native tools for reads, edits, shell commands, and permitted delegation.
Do not replace native tools with a custom execution tool.
Do not remove native tools from an ordinary session.
Do not install a blanket permission policy for Prometheus command users.

In Plan, investigate through permitted actions and prepare proposals.
Do not change product files or use a Build child to bypass Plan restrictions.
A switch to Build does not approve implementation or a wider scope.
In Build, a spike still authorizes only the requested investigation.

The user can invoke the preparation commands in either order or omit them.
Commands must not manufacture authority from project files, tool results, or other model reports.
Use short sentences and active voice in user-facing instructions.

## Records

Use native plugin storage for findings, decisions, and verification reports.
Keep findings separate from user decisions. Identify model-written records as model reports.
Records survive compaction and plugin reload. Storage does not itself authorize work.
Scope records to the originating session. Unrelated sessions must not receive injected workflow instructions.

`prometheus_record` has three actions:

- `finding`: record observations, interpretation, limitations, and outcome.
- `decision`: record a decision and its rationale.
- `status`: read this session's records and legacy-option information.

## Independent verification

`prometheus_verify` provides `start`, `report`, and `status` actions.
It is a focused verification operation, not another goal command.

### Request

The originating session must use Build to request a fresh Build evaluator.
Use native `subagent` permission admission before child creation.
Inherit the originating session's restrictions. Do not grant new tool permissions.
Use native read permission admission before reading candidate bytes for identity checks.

Record the acceptance criteria and a content manifest for the current workspace.
Each criterion has a unique identity and description. It can include validator instructions.
Create a fresh native child session with the originating model and location.
Supply the criteria and candidate identity, but not the worker conversation.
Admit one evaluation prompt. OpenCode owns subsequent tool execution.
Wait through the native session API before returning the verification tool result.
This keeps native goal review from treating pending verification as completed work.

### Evidence and acceptance

The evaluator uses normal native tools. It must not repair the product or weaken the criteria.
It reports exactly one pass, fail, or unresolved result for each criterion.
A pass requires references to completed native tool results from that evaluator session.
Model-written findings, worker claims, running tools, and other-session results cannot establish a pass.
Retain tool input, output, metadata, and result hashes with the report.
The evaluator must interpret whether the evidence satisfies the criterion. A tool's completion alone is not proof of success.
A denied, unavailable, or incomplete required check remains unresolved.

Check the candidate identity before accepting a report. Reject changed candidates.
After acceptance, a status request must identify files that differ from the accepted candidate.
Return a durable report and a non-resuming notice to the origin.
The origin performs any repair through native tools. Native `/goal`, if active, owns continuation.
Prometheus does not automatically start a replacement evaluator or repair worker.
If the evaluator finishes without a report, mark the verification unresolved. Do not leave it permanently pending.

### Limits of verification

The evaluator examines the current workspace. There is no isolated or guaranteed read-only candidate sandbox.
Native permissions and agent rules apply. They are not an operating-system isolation boundary.
Hash checks detect candidate changes. They do not prevent changes or prove that files stayed unchanged between checks.

The manifest excludes `.git`, `.opencode`, `node_modules`, `.env`, `.env.*`, and `.DS_Store`.
Excluded files, external services, and remote deliverables require separate evidence.
Absolute or external symlinks, unsupported entries, and multiply linked files prevent a manifest claim.
Verification does not grant deployment, publication, or other external authority.

## Cancellation and recovery

OpenCode handles tool cancellation, permission denial, and native goal lifecycle.
Observe native interruption, failure, and deletion events for pending verifications.
Stop only owned evaluator activity. Reject late reports after interruption.
Plugin cleanup must remove registrations and stop pending evaluators.
After a reload or service restart, old pending verification cannot be accepted by the new plugin instance.
Status must identify it as interrupted. New verification requires a new request.
A lost dispatch receipt is uncertain. Do not automatically replay it.

## Legacy data and compatibility

Keep old controller databases and artifacts unchanged. Do not resume or import old runs automatically.
The old `stateDirectory`, `limits`, and `protectedPaths` options no longer control execution.
Expose this change through record status and migration documentation.
Provide read-only inspection of old databases. Retire the old grant operation.
The plugin must load when legacy state is inside the current project or home directory.

Require stable OpenCode 2.2.1 or later in major version 2. Pin the SDK dependencies to a tested release.
This version policy is not proof that every allowed release passed verification.
Do not claim the old aggregate request, cost, deadline, or process-isolation guarantees.
Native goal limits and native permission controls retain their own semantics.

## Browser boundary

The separate browser installation, profiles, and human-invoked `/browser` command remain unchanged.
Prometheus commands and evaluators must not automatically invoke that workflow.
Preserve private authentication and existing browser safeguards.

## Verification requirements

Test the installed package, not only a source import.
Prove coexistence with the built-in `/goal`, unchanged native tools, Plan restrictions, native denial,
Linux shell execution, native continuation, independent evidence, changed candidates, cancellation,
reload behavior, and legacy-data preservation.
Use isolated services and local scripted providers for deterministic integration tests.
Do not treat scripted provider results as real-model reliability evidence.
Paid or external model qualification requires an explicit model, allowance, and approval.
Retire old campaign manifests rather than run them against the unrelated native `/goal`.
