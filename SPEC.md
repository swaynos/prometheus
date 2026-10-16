# Prometheus — Project Specification

Status: Consolidated design for implementation.
Date: 2026-10-16.
Target: OpenCode V2.

This document defines the required product. It does not claim that the product already provides these capabilities.
The user authorized publication of this specification. That request does not authorize implementation or paid qualification.

## 1. Purpose

Prometheus extends native Plan and Build with investigation, requirement clarification, scoped execution, and independent acceptance.

The user defines the outcome and grants authority. The agent investigates and performs the work. The controller preserves the agreement and controls execution.

Prometheus must reduce repeated user intervention without weakening acceptance criteria.

### 1.1 Required commands

| Command | Purpose |
| --- | --- |
| `/spike` | Investigate a technical question. |
| `/grill-me` | Resolve consequential user decisions. |
| `/goal [instructions]` | Infer the goal from the conversation. Prepare or execute that goal. |

The user can omit commands that the task does not need.
The user can alternate spikes and questions.
The product must not require a fixed command sequence.
Planning is native agent behavior. Do not add a separate `/plan` command.
Text after `/goal` refines or changes the inferred outcome. It does not select a predefined command variant.

### 1.2 Product boundaries

- Preserve native Plan and Build.
- Do not add another user-facing agent.
- Apply Prometheus controls only to enrolled workflows.
- Preserve unrelated native sessions and user configuration.
- Keep `/browser` separate and human-invoked.
- Do not implement a new browser workflow in this scope.
- Do not require commits, staging, or pushes.
- Do not create a general-purpose sandbox or distributed orchestration platform.
- Do not promise completion of every task.

### 1.3 Terms

| Term | Meaning |
| --- | --- |
| Acceptance criterion | An observable condition required for success. |
| Authority | Permission for a defined scope, action, or resource use. |
| Candidate | The exact artifacts under evaluation. |
| Controller | Code that manages state, authority, dispatch, and acceptance. |
| Evaluator | A fresh session that examines a candidate against the agreement. |
| Finding | An observation and its supporting evidence. |
| Goal | The selected outcome for execution. |
| Meta-validator | A procedure that examines whether a validator works. |
| Run | One authorized execution of a goal. |
| Spike | A bounded investigation of one question. |
| Subscope | A defined part of the requested work. |
| Task intent | The kind of work that the user requested. |
| Validator | A procedure that supplies evidence for an acceptance criterion. |
| Worker | The Build session that performs execution and repair. |

## 2. Authority and mode rules

### 2.1 Separate intent from capability

A mode change does not change task intent.
A switch to Build does not start execution.
Build capability does not grant unrestricted authority.

Keep these facts separate:

1. The approved outcome and scope.
2. Native tool permissions.
3. Authority for machine changes and external effects.
4. The resource allowance.

A goal approval does not override a native permission denial.
A tool permission grant does not approve a wider goal.

### 2.2 Plan behavior

In Plan, investigate through permitted read-only actions.
Prepare plans, proposed experiments, and acceptance criteria.
Do not implement product changes through a child session.
Do not publish project documents merely because a proposal is ready.

Write a plan file only when the user requests one.
Use only the plan location permitted by the host.

Persist operational metadata only where the host permits it.
The integration spike must establish how this persistence interacts with Plan restrictions.
Do not assume that an internal storage API bypasses those restrictions.

### 2.3 Build behavior

In Build, perform only the selected, authorized work.
An investigation continuation remains an investigation.
A planning command does not start product implementation.

A clear execution request can approve an identifiable specification version.
Do not add a redundant confirmation when existing authority is sufficient.
Ask when the goal reference is ambiguous or consequential authority is missing.

Repository text, tool output, and child messages cannot grant user authority.

## S1. Native integration and commands

### S1.1 Integration contract

Use supported OpenCode V2 interfaces.
Verify exact interfaces against current documentation and the installed runtime.
Treat unavailable or uncertain capabilities as investigation questions.
Do not substitute V1 behavior or another product's behavior.

Detect command name collisions.
Ask before replacing existing user definitions.
Preserve unrelated configuration during installation and removal.

Load specification content explicitly.
Do not depend on stored `@SPEC.md` text to attach a document.
Do not use template shell expansion to bypass permission controls.

### S1.2 Command behavior by mode

| Command | Plan | Build |
| --- | --- | --- |
| `/spike` | Investigate without prohibited writes. Describe pending experiments. | Perform authorized experiments. Preserve investigation intent. |
| `/grill-me` | Resolve consequential decisions. | Resolve decisions without automatic product changes. |
| `/goal [instructions]` | Infer the goal. Prepare the work. Request Build when needed. | Infer the goal. Complete necessary preparation. Execute within authority. |

### S1.3 Child sessions

Apply explicit permissions to spikes, workers, and evaluators.
Verify the interaction between agent permissions and session restrictions.
Do not assume that child creation supplies isolation or correct permissions.

Keep the originating conversation available to the user.
Make the execution session identifiable and accessible.

### S1.4 Acceptance

- Ordinary Plan and Build retain their normal behavior.
- Delegation cannot bypass applicable Plan restrictions.
- Commands preserve intent across mode changes.
- Registration preserves existing definitions.
- The installed integration reports the loaded runtime version.

## S2. Records, evidence, and handoffs

### S2.1 Distinct records

Keep these records distinct:

- Findings and evidence.
- User decisions.
- Proposed plans.
- Approved specification versions.
- Execution state and consumption.

A user preference does not change an observed fact.
New evidence can supersede a finding.
Preserve the original observation and the reason for correction.

### S2.2 Runtime storage

Use one SQLite store for Prometheus runtime state.
Commit related state changes and audit events in one transaction.
Reference evidence artifacts from this store.
Avoid competing runtime ledgers.

Do not duplicate the complete native conversation.
Use supported interfaces to inspect native session facts.
Do not assume that database transactions make external actions atomic.

### S2.3 Handoff content

Preserve:

- Task and run identities.
- Task intent and selected scope.
- The source user instruction.
- Specification identity and approval.
- Worker and child identities.
- Relevant evidence references.
- Pending work and unresolved effects.
- Applicable permissions.
- Consumed and remaining resources.

“Continue your investigation work” resumes investigation.
“Execute your plan” executes the unambiguous prepared goal in Build.
Ask which goal applies when several references remain possible.

### S2.4 Specification publication

Use `SPEC.md` for the agreed task specification.
Keep proposals separate from published, approved versions.
In authorized Build work, publish the specification before dependent product work.

Record a content hash and version.
Preserve unknown user changes.
Detect concurrent edits before further consequential dispatch.

### S2.5 Acceptance

- Restart preserves intent, authority, findings, and consumption.
- Publication does not overwrite unknown user work.
- Approval remains distinct from preparation and publication.
- Evidence references remain associated with the correct task.

## S3. Spikes

### S3.1 Investigation definition

Give each spike one independently assessable question.
Record:

1. The question.
2. The decision that depends on it.
3. Available evidence.
4. The proposed experiment.
5. Required authority.
6. The resource allowance.
7. Required observations and a stopping condition.

Create one fresh child for each independent question.
Retain that child for related follow-up work where practical.
Do not replace a child after each ordinary error.

Run independent spikes in parallel when authority and resources permit.
Parallel work shares the overall allowance.
Prevent conflicting experiments from changing the same resources concurrently.

### S3.2 Write experiments

In Plan, complete permitted investigations first.
Describe experiments that need writes.
Identify expected outputs and relevant side effects.
Request Build when required.

After an explicit continuation, perform the authorized experiments.
Use owned temporary locations where practical.
Request additional authority for changes outside the existing scope.
Report retained machine changes and owned processes.

Do not convert experiments into product implementation.
Do not remove unrelated work during cleanup.

### S3.3 Findings

Use these results:

- Supported.
- Disproved.
- Inconclusive.

Record observations separately from interpretations.
Include relevant versions, inputs, environment details, and limitations.
State which decision the finding affects.
Identify conditions that could make the finding stale.

Present a short digest first.
Provide detailed evidence by reference.
Do not claim product acceptance from a spike result.

### S3.4 Acceptance

- Each spike has a question and stopping condition.
- Plan restrictions apply to all spike children.
- Build continuation retains investigation intent.
- Inconclusive evidence does not cause unbounded experiments.
- Findings retain provenance and limitations.

## S4. Questions and user correction

### S4.1 Entry points

Allow `/grill-me` before, after, or between spikes.
Do not require spikes for a task that needs no investigation.

### S4.2 Issue classification

| Issue | Required response |
| --- | --- |
| User preference | Ask the user. |
| Discoverable fact | Inspect evidence or propose a spike. |
| Decision with technical uncertainty | Explain the choice and the missing evidence. |
| Reversible detail with low consequence | State a reasonable assumption. |
| Answered question | Reuse the answer unless relevant facts change. |

Do not ask the user to determine discoverable technical facts.
Do not infer preferences from technical findings.

### S4.3 Correction loop

For each consequential decision, present:

1. The proposed interpretation.
2. A concrete acceptance example.
3. The proposed validator.
4. The remaining user decision.

Ask one main question at a time where practical.
Recommend an answer when the evidence supports it.
Explain its effect on scope or acceptance.

Record corrections as user decisions.
Revise affected plan sections.
Preserve historical observations.

### S4.4 Readiness

End with one status:

- Ready for execution.
- Needs investigation.
- Needs a user decision.

Name the issue that prevents readiness.
A ready plan can contain authorized experiments and explicit assumptions.
Do not require advance proof of feasibility.
Do not impose a universal question count.

### S4.5 Acceptance

- The command avoids repeated questions.
- Findings reduce unnecessary questions.
- Corrections change the interpretation without rewriting evidence.
- The agent declares readiness when further questions add no necessary decision.

## S5. Plans and task specifications

### S5.1 Ordered work

Prepare the plan from the outcome, findings, user decisions, criteria, and authority.
Include:

- Prerequisites.
- Necessary spikes.
- Validator construction.
- Implementation.
- Independent evaluation.
- Delivery.

State dependencies.
Use conditional steps when an experiment determines a technical choice.
The checklist guides work. Acceptance criteria define success.

### S5.2 Required task specification sections

Each task specification contains:

1. Outcome.
2. Non-goals.
3. Acceptance criteria.
4. Authorized scope.
5. Protected resources.
6. Assumptions and unresolved questions.
7. Ordered work.
8. Validator definitions.
9. Resource limits.
10. Pause and delivery conditions.

### S5.3 Changes and pivots

Identify which requirements remain, change, or no longer apply.
Preserve historical findings and consumption.
Detect edits to the approved specification.
Examine their effect before further execution.

Obtain a new user decision when scope, authority, or acceptance meaning changes.
Do not require new approval for an implementation choice within the existing agreement.

### S5.4 Acceptance

- Criteria describe observable outcomes.
- The plan includes missing validator construction.
- Approval identifies a specification version.
- Technical uncertainty can remain as planned investigation.
- A pivot cannot silently redefine a prior completion claim.

## S6. Validators

### S6.1 Criterion mapping

For each criterion, define:

- Expected behavior.
- Validation method.
- Pass condition.
- Required environment.
- Evidence to retain.
- Decision owner.
- Known limitations.

Use examples that match the required outcome.
A reload test does not establish cross-device persistence.
A mock result does not establish a required live outcome.

For subjective criteria, define an observable rubric or require user acceptance.

### S6.2 Construction and readiness

Construct validators before dependent implementation where practical.
If a working product is necessary, prepare the procedure and harness first.
Record that dependency.

Establish that:

- Each required criterion has a suitable procedure.
- The procedure executes.
- Required work does not silently skip.
- Relevant known-bad examples fail.
- Relevant known-good examples pass where feasible.
- Infrastructure failures differ from product failures.
- Evidence identifies the intended candidate.

Meta-validation does not prove complete fault coverage.
Do not create an unlimited sequence of meta-validators.

### S6.3 Validator changes

Record the exact validator version used for acceptance.
Permit legitimate test construction and repair.
Do not prohibit every test-file edit.
Do not permit silent weakening of acceptance meaning.

After a relevant validator change, repeat affected readiness checks.
Invalidate affected product evaluation results.
Ask the user only when the change requires a new scope or acceptance decision.

Do not require a separate approval ceremony or model call for every validator edit.
Independent evaluation must examine whether the procedures support the required outcome.

### S6.4 Validator-only goals

If the selected outcome is validator construction, accept the validator deliverable rather than the product.
This is an ordinary goal, not a special command variant.
Require criterion coverage, usable procedures, controlled examples, and clear limitations.
The product may correctly fail these validators.
Missing required validation capability prevents validator-only acceptance.

### S6.5 Acceptance

- Validator files alone do not establish readiness.
- Relevant defects produce failures.
- Test weakening cannot establish acceptance.
- Validator-only completion does not start product implementation.

## S7. Goals and execution

### S7.1 Goal selection

| Request | Meaning |
| --- | --- |
| `/goal` | Infer the goal from the conversation, findings, and user decisions. |
| `/goal [instructions]` | Use the instructions to refine or change the inferred goal. |
| “Execute your plan” | Execute the unambiguous prepared goal in Build. |

Arguments are optional. Do not require the user to repeat an outcome that the conversation establishes.
Reuse the prepared goal when it represents the current agreement.
Otherwise, derive the goal from the current conversation.
Ask only when consequential ambiguity remains.

Instructions can select a limited scope, change the outcome, or request validator construction.
These are examples of ordinary instructions, not reserved command forms.
Distinguish an intermediate step from the entire selected outcome.
For example, “build the validators first” can describe a sequence rather than a validator-only goal.
Use the conversation to resolve that distinction. Ask if it remains consequentially ambiguous.

In Plan, define the outcome, acceptance criteria, validators, dependencies, and required authority.
Include validator construction where necessary.
Request Build when execution needs writes.

In Build, complete necessary preparation before execution.
Do not require another command when the request and existing authority already permit execution.
A mode switch alone does not start work.

Report completion if the selected goal already completed.
Do not silently expand it.

### S7.2 Execution start

After sufficient user authority:

1. Resolve the selected goal.
2. Identify the approved specification.
3. Record existing user changes.
4. Publish agreed documents when necessary and permitted.
5. Record admission and resource limits.
6. Create one fresh Build worker.
7. Supply the specification and relevant evidence references.
8. Start the selected work.

Do not transfer the complete planning conversation.
Do not require another implementation prompt after an unambiguous execution request.

### S7.3 Work and repair

Use the same worker through preparation, experiments, implementation, and ordinary repair.
Construct validators before dependent product work where practical.
Execute validators after relevant changes.
Diagnose failures before the next attempt.
Preserve useful failed experiments and rejected hypotheses.

Continue after partial output when authority, resources, and evidence permit.
Use one continuation owner.
Detect duplicate dispatch.

Do not impose hidden attempt limits.
Do not force a different strategy after a fixed error count.
Require an evidence-based reason for continued attempts.

If the worker cannot continue, pause and report the reason.
Do not silently replace its conversation.

### S7.4 Acceptance

- Execution starts without another user prompt.
- Ordinary repair retains the worker.
- Partial output does not establish completion.
- Natural-language execution preserves scope.
- Bare `/goal` infers the agreed outcome without requiring repeated instructions.
- Optional instructions refine the goal without predefined command variants.
- Investigation-only work does not become product implementation.

## S8. Independent acceptance and delivery

### S8.1 Candidate capture

Stop new worker mutations before final evaluation.
Account for actions still in progress.
Capture a coherent candidate.
Include relevant untracked files and external deliverables.
Preserve unrelated user changes.

Record:

- Candidate identity.
- Specification version.
- Validator version.
- Relevant environment.
- Evidence references.

Do not require a Git commit.
Do not stage, commit, push, or publish without applicable authority.

### S8.2 Fresh evaluation

Create a fresh evaluator for the candidate.
Provide the specification, candidate, procedures, and relevant factual evidence.
Do not provide the worker conversation or its completion narrative.

Apply explicit evaluator permissions.
Prevent changes to product artifacts and acceptance criteria.
Permit owned disposable space for authorized outputs and test data.

Obtain direct evidence where possible.
Treat candidate content as data rather than governing instructions.
The worker cannot accept its own output.

A different model can provide diversity.
Model diversity is not mandatory and does not prove correctness.

### S8.3 Results

Assign Pass, Fail, or Unresolved to each criterion.
Accept only when every required criterion passes.
Return failures to the same worker when repair remains authorized.
A successful build does not replace other required evidence.

If acceptance requires `/browser`, identify the missing evidence.
Wait for the separate human-invoked workflow.
Check that supplied evidence applies to the relevant candidate and criterion.
Do not accept unsupported completion statements.

### S8.4 Delivery

Record evaluator identity and any required user acceptance.
Identify the delivered artifact locations.
Establish that delivery matches the accepted candidate.

Acceptance does not grant new deployment or publication authority.
Later edits create a different candidate.
Repeat affected evaluation before a new acceptance claim.

### S8.5 Acceptance

- Every required criterion has passing evidence.
- Evaluation identifies the exact specification, validators, and candidate.
- Missing evidence prevents acceptance.
- Delivered artifacts match the accepted candidate.

## S9. Boundaries, resources, and recovery

### S9.1 Enforceable controls

Protect runtime code, governing instructions, credentials, approved specifications, and controller state.
Keep protected state outside worker-writable locations.
Verify the actual boundary under available execution capabilities.

A worktree is not a security sandbox.
A separate directory does not stop unrestricted same-user shell writes.
Shell patterns do not provide complete filesystem or network isolation.

Use an existing isolation mechanism when required guarantees need process isolation.
Report unavailable required protection before the affected execution.
Do not create a universal sandbox requirement for unrelated work.

Translate authority into concrete tool and resource restrictions where possible.
Do not claim that code can infer the purpose of every arbitrary command.

### S9.2 Resources

Use one overall allowance for the task.
Include spikes, workers, evaluators, retries, compaction, and other associated model work.
Reserve resources before dispatch where practical.
Parallel work does not create another allowance.

Preserve consumed and uncertain usage across restarts.
Distinguish enforceable limits from estimates.
Do not introduce hidden attempt quotas.

### S9.3 Lifecycle and cancellation

Use a small lifecycle: Draft, Working, Verifying, Paused, and Accepted.
Store pause reasons as data.
Distinguish a stop request from confirmed cessation of activity.
The implementation may use a separate stopping state when needed.

Pause for:

- User cancellation.
- Permission denial.
- Required scope expansion.
- Exhausted limits.
- An uncertain consequential action outcome.
- A supported blocker that requires a user decision.

A repeated error does not establish a blocker.
A worker's impossibility claim does not establish a blocker.

On cancellation, prevent new task dispatch.
Request interruption of owned activity.
Record active operations and uncertain effects.
Do not terminate unrelated sessions or the shared service.
Late receipts cannot clear cancellation.

Paused means that new task dispatch is prohibited.
It does not prove that every remote effect stopped.

### S9.4 Recovery

Before further dispatch after interruption:

1. Read durable state.
2. Inspect native sessions and owned processes.
3. Identify active work.
4. Reconcile pending actions and resource use.
5. Establish one controller owner.
6. Check whether authority still permits continuation.

Treat live events as notifications rather than a durable queue.
A lost stream does not prove that work stopped.
Prevent stale controllers from dispatching new work.
Database consistency alone does not provide this protection.

Record consequential action intent before dispatch where the integration can enforce this boundary.
Record known outcomes and unresolved outcomes.
Verify interception coverage for shell, nested tools, and other execution paths.
Do not claim visibility into effects the controller cannot observe.

Use destination idempotency only where the destination supports it.
Do not automatically replay an action with an unknown outcome.
Do not promise exactly-once external effects.

Require explicit user authority to resume after a durable pause.
A status request must not resume work.

### S9.5 Acceptance

- Restart does not reset authority or consumption.
- Duplicate owners cannot dispatch the same work.
- Cancellation remains effective after late messages.
- Unknown effects remain visible.
- Recovery does not silently replay uncertain actions.

## S10. Implementation and qualification

### S10.1 Evidence discipline

Distinguish these claims:

1. Mechanics verified through deterministic tests.
2. Behavior qualified through real-model runs.
3. Live outcome verified through external evidence.

Do not substitute one claim for another.
Record human intervention and manual repair.
A rescued run does not establish unattended completion.

Use historical Cuddly Winner results as supplied evidence, not a root-cause diagnosis.
The recorded five-case qualification passed one case.
Four cases remained unqualified after the shared 150-turn allowance.
Do not assume that stronger prompts or additional state files resolve that result.

### S10.2 Dependency order

| Stage | Deliverable | Exit evidence |
| --- | --- | --- |
| A | Native capability investigations and minimal state contracts. | Supported command routing, session control, permissions, persistence, and cancellation. |
| B | A small complete execution loop. | Validators, one worker, failure repair, and fresh artifact-bound evaluation. |
| C | Investigation and decision workflow. | Spikes, grilling, correction records, and intent-preserving mode changes. |
| D | Complete goal behavior. | Validator-only goals, subscopes, pivots, and natural-language execution. |
| E | Recovery hardening. | Fault tests for ownership, cancellation, uncertain effects, and consumption. |
| F | Installed qualification. | Declared scenarios, baseline comparisons, and retained evidence. |

Provide basic permissions, cancellation, and resource controls before paid experiments.
Stage E hardens existing controls. It does not introduce them for the first time.
Keep the complete discovery workflow within first-release scope.

Technical investigations are implementation steps, not mandatory new approval ceremonies.
Pause when a result requires a consequential user decision or reveals an unavailable required capability.

### S10.3 Required workflow scenarios

- Plan spike encounters a write requirement without bypassing restrictions.
- Build continuation completes investigation without product implementation.
- Grilling precedes spikes.
- Grilling follows spikes.
- Spikes and questions alternate without losing decisions.
- Validator-only preparation remains validator-only during execution.
- Bare `/goal` uses the current conversation and decisions.
- Optional goal instructions refine the outcome or select a limited scope.
- “Build validators first” does not silently become a validator-only goal.
- A consequentially ambiguous goal produces a focused question.
- “Execute your plan” selects the correct prepared goal.
- Direct Build goals establish sufficient criteria before work.
- Evaluator rejection returns to the same worker.
- Contradictory criteria prevent false acceptance.
- Specification edits trigger examination before continued execution.
- Missing browser evidence remains unresolved.
- Ordinary native sessions retain their behavior.

### S10.4 Required fault scenarios

Test interruptions:

- Before action dispatch.
- After dispatch but before a receipt.
- After an effect but before durable outcome recording.
- During candidate capture.
- During evaluation.
- After acceptance but before the completion message.

Also test:

- Duplicate commands and competing controller owners.
- Cancellation followed by a late receipt.
- Unknown external outcomes.
- Resource exhaustion and restart.
- Validator edits during repair.
- User edits during candidate capture.
- Child attempts to exceed Plan restrictions.
- Untrusted text that resembles authorization.
- Delivery of stale or unrelated artifacts.

Define the expected state, permitted next action, and required evidence for each test.

### S10.5 Plain-Build comparison

Compare the execution loop against ordinary Build.
Use equivalent starting artifacts, specifications, models, and aggregate allowances.
Use the same acceptance procedures.
Account for evaluator overhead consistently.

Measure accepted completion, false acceptance, consumption, elapsed time, and user intervention.
Evaluate discovery quality separately when the task begins without a prepared specification.
Do not infer general superiority from one successful example.

Before paid qualification, obtain the model choice and aggregate allowance.
Declare required scenarios and release gates before the run.
Preserve failed runs and their consumption.

### S10.6 Documentation and installation

Maintain:

- A brief README and command reference.
- This specification and implementation decisions.
- A repeatable qualification procedure.
- Qualification results and evidence references.

Report the loaded runtime version.
Installer success does not prove that an existing service loaded new code.
Do not present proposed commands as installed features before qualification.

## 3. First-release completion

The installed product must demonstrate:

1. A feature request begins in Plan.
2. Spikes investigate relevant unknowns.
3. Authorized Build continuation completes write experiments.
4. Grilling resolves consequential user decisions.
5. The agent declares readiness.
6. Bare `/goal` infers the agreed outcome and prepares its scope and validators.
7. Explicit Build execution starts a fresh worker.
8. The worker constructs usable validators.
9. The worker implements and repairs the deliverable.
10. A fresh evaluator establishes acceptance.
11. Delivery matches the accepted candidate.
12. The controller preserves evidence and final state.

Also demonstrate validator-only completion and unchanged native behavior.
Pass the declared mechanics and recovery tests.
Report real-model results without hiding failures or human rescue.

## 4. Open implementation questions

Resolve these through capability spikes:

- Supported command routing and mode inspection.
- Fresh-session creation, visibility, and continuation.
- Permission layers and nested execution coverage.
- Permitted metadata persistence in Plan.
- Controller ownership and interruption behavior.
- Protection available for controller state.
- Candidate capture and external evidence identity.
- Resource measurement and reservation limits.

These questions do not change the product agreement by themselves.
Ask the user only when findings require a scope, authority, acceptance, or resource decision.

## 5. Review disposition

Retain four narrow improvements from the notebook consultation:

1. Test the complete execution loop early.
2. Compare qualification results against ordinary Build.
3. Bind acceptance to the validator version.
4. Distinguish requested stopping from confirmed cessation.

Preserve the original safeguards for permissions, evidence, ownership, and recovery.
Do not adopt arbitrary counters, mandatory commits, `SPEC.json`, or speculative API examples.
Do not add a mandatory validator approval subsystem.
Do not narrow first-release scope through unapproved deferrals.

## 6. Writing convention

Use short sentences, active voice, explicit actors, and consistent technical terms.
Use ASD-STE100 sentence conventions for procedures and technical descriptions.
Full official dictionary conformity is not verified.
