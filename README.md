# Prometheus

Prometheus is an experimental extension for native OpenCode V2 Plan and Build.
You define the outcome, permissions, and resource limits.
The agent investigates the task, prepares the work, implements the product, and repairs failures.
You do not need to repeat routine instructions to continue the work.
A separate evaluator checks the result against the agreed acceptance criteria.

The [specification](SPEC.md) defines the workflow, acceptance criteria, execution controls, and release requirements.
The controller package implements the workflow. It does not automatically install commands into your current session.

- Use the [package guide](packages/prometheus/README.md) to install the controller.
- Use the [runtime reference](docs/PROMETHEUS.md) for execution limits and recovery procedures.
- Use the [documentation index](docs/README.md) to find other references.

## Implementation status

See the [package compatibility policy](packages/prometheus/README.md#compatibility) for accepted service versions.
Controller tests and scripted native tests check execution mechanics.
They do not establish real-model reliability.

The controller's managed process boundary supports macOS only.
Linux controller execution needs a process-boundary implementation and verification on Linux.
The separate browser runtime supports macOS and Linux. It does not support Windows execution.

Real-model verification and comparison with ordinary Build remain incomplete.
Use [Scenarios](docs/SCENARIOS.md) for required behavior, fault cases, and checks.
Use [Verification](docs/VERIFICATION.md) for test instructions, evidence rules, and release gates.

## Commands

| Command | Purpose |
| --- | --- |
| `/spike <question>` | Investigate a technical question. Return findings and evidence. |
| `/grill-me` | Resolve important user choices through focused questions. |
| `/goal [instructions]` | Determine the goal from the conversation. Prepare in Plan. Execute in Build. |

Use only the commands that the task needs.
You can investigate technical questions before or after you discuss user choices.
The agent plans through normal conversation. There is no separate `/plan` command.

## Use `/goal`

Discuss the required outcome with the agent.
Use `/spike` for technical investigation and `/grill-me` for unresolved user choices when necessary.
Then enter:

```text
/goal
```

The agent determines the goal from the conversation, findings, and your decisions.
You do not need to repeat an agreed outcome.
The agent asks a question only if an unresolved choice can change the outcome or required authority.

You can add instructions to clarify or change the goal:

```text
/goal only implement the settings screen
/goal create the validators without implementing the product
```

These are ordinary instructions, not special command variants.
The conversation determines whether validator construction is one step or the complete goal.

## Plan and Build

In Plan, the agent defines the outcome, acceptance criteria, validators, prerequisites, and required permissions.
The plan includes validator construction when necessary.
The agent requests Build when execution requires file changes.

In Build, `/goal` completes the necessary preparation and starts authorized execution.
Switching to Build alone does not start work or change the task's purpose.
“Continue your investigation” continues investigation. It does not authorize product implementation.
“Execute your plan” starts the prepared goal when the goal and execution authority are clear.

## Execution and completion

Execution starts in a new Build worker with the agreed specification and relevant evidence.
The worker keeps its conversation through preparation, implementation, and normal repair.
Partial output does not end the run.

A new evaluator checks the exact candidate against every required criterion.
The candidate is the set of files submitted for evaluation.
Missing evidence prevents acceptance. Delivered artifacts must match the accepted candidate.

A goal limited to validator construction ends when those validators are ready.
It does not continue into product implementation.

## Your control

You control scope, authority, and resource limits.
Prometheus pauses when you cancel work, deny permission, or reach a resource limit.
It also pauses for important decisions that require your input.
An important action with an uncertain outcome also causes a pause.
Explicit authorization is necessary to resume a paused run.

`/browser` is a separate command that a person invokes outside the goal-execution workflow.
The browser profile installer registers this command and the `prometheus-browser` MCP server.
Use the [browser reference](docs/RESOURCE-SELECTION.md) for browser procedures.
Use the [operations guide](docs/BROWSER-OPERATIONS.md) for installation, migration, and recovery.

## Design principles

- **Useful planning:** Define the required result, available evidence, missing capabilities, and necessary permissions.
  Ask questions only when the answers can change the outcome or authority.
  Permit investigation without requiring proof that the proposed method will work.
- **Continued execution:** Keep the worker's conversation through preparation, implementation, and repair.
  Use failed attempts as evidence for the next attempt.
  Continue through normal errors within user-defined limits.
- **Independent verification:** Give new evaluators the requirements, candidate, and evidence, but not the worker's conversation.
  Accept a candidate only when every required criterion passes.
  Offline tests cannot replace required live checks.
- **Evidence-based acceptance:** Use authorized files, tools, and APIs to obtain evidence.
  Keep `/browser` separate and human-invoked.
  Keep authentication private and under human control.
- **Recovery without lost records:** Preserve goals, authority, pending actions, feedback, and unresolved findings across compaction and restarts.
  Investigate uncertain effects before retrying an action.
- **Human control:** Pause for cancellation, denied permission, or unknown action outcomes.
  Require explicit authorization to resume.
  Preserve user changes. Prevent workers from changing their governing instructions.
- **Native compatibility:** Extend OpenCode V2 without changing normal Plan and Build behavior.

Success means less routine supervision, preserved user control, and evidence for each completion claim.

This document uses ASD-STE100-style sentences. Full dictionary conformity has not been verified.
