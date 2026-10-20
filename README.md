# Prometheus

Prometheus is an experimental extension for native OpenCode V2 Plan and Build.
You define the outcome, permissions, and resource limits.
The agent investigates, prepares the work, implements, and repairs failures without repeated continuation prompts.
A fresh evaluator checks the result against the agreed criteria.

The [complete specification](SPEC.md) defines the workflow, acceptance criteria, execution controls, and release qualification.
The controller package implements the workflow mechanics. It does not install commands into your current session automatically.
Read the [package guide](packages/prometheus/README.md) for installation.
Read the [runtime reference](docs/PROMETHEUS.md) for limits and recovery, or browse the [documentation index](docs/README.md).

## Implementation status

The package targets OpenCode 2.0.29.
Controller tests and scripted native tests exercise the execution mechanics.
The managed process boundary currently supports macOS.
Real-model qualification and the plain-Build comparison remain pending.
See the [qualification reference](docs/QUALIFICATION.md) for test procedures, requirement matrix, and snapshots.

## Commands

| Command | Purpose |
| --- | --- |
| `/spike <question>` | Investigate an unknown. Return findings and evidence. |
| `/grill-me` | Resolve consequential user decisions through focused questions. |
| `/goal [instructions]` | Infer the goal from the conversation. Prepare in Plan. Execute in Build. |

Use only the commands that the task needs.
Spikes and questions can occur in either order.
Planning is normal agent behavior. There is no separate `/plan` command.

## Use `/goal`

Discuss the outcome with the agent. Use spikes and questions when useful.
Then enter:

```text
/goal
```

The agent infers the goal from the conversation, findings, and your decisions.
You do not need to repeat an agreed outcome.
The agent asks only when consequential ambiguity remains.

Optional instructions refine or change the goal:

```text
/goal only implement the settings screen
/goal create the validators without implementing the product
```

These are ordinary instructions, not special command variants.
The conversation determines whether validator construction is an intermediate step or the complete goal.

## Plan and Build

In Plan, the agent defines the outcome, acceptance criteria, validators, dependencies, and required permissions.
It includes validator construction when needed.
It requests Build when execution requires writes.

In Build, `/goal` completes necessary preparation and starts authorized execution.
Switching to Build alone does not start work or change task intent.
“Continue your investigation” continues investigation.
“Execute your plan” starts the prepared goal when the reference and authority are clear.

## Execution and completion

Execution starts in a fresh Build worker with the agreed specification and relevant evidence.
The worker retains its conversation through preparation, implementation, and ordinary repair.
Partial output does not end the run.

A fresh evaluator checks the exact candidate against every required criterion.
Missing evidence prevents acceptance.
Delivered artifacts must match the accepted candidate.

A goal limited to validator construction ends when those validators are ready.
It does not continue into product implementation.

## Your control

You control scope, authority, and resource limits.
Prometheus pauses for cancellation, denied permission, exhausted limits, or consequential decisions that require your input.
It also pauses when a consequential action has an uncertain outcome.
Explicit authority is necessary to resume a paused run.

`/browser` remains a separate human-invoked command outside this execution workflow.
The browser profile installer registers this command and the `prometheus-browser` MCP server.
See the [resource selection guide](docs/RESOURCE-SELECTION.md) for browser procedures
and the [operations guide](docs/BROWSER-OPERATIONS.md) for installation, cutover, and recovery.

## Design principles

- **Actionable planning:** Establish the finish line, available evidence, implementation gaps, and necessary permissions. Ask questions only when answers materially change the outcome or authority. Allow experimentation without requiring advance proof of feasibility.
- **Persistent execution:** Keep the worker’s context across preparation, implementation, and repair. Use failed attempts as evidence for the next attempt. Continue through ordinary errors within user-defined limits.
- **Independent verification:** Fresh evaluators inspect requirements, artifacts, and evidence without receiving the worker’s conversation. Acceptance requires every criterion to pass and applies to the exact artifacts evaluated. Offline tests cannot substitute for required live outcomes.
- **Evidence-based acceptance:** Use authorized files, tools, and APIs to obtain evidence. Keep `/browser` separate and human-invoked. Keep authentication private and under human control.
- **Durable recovery:** Preserve goals, authority, pending actions, feedback, and unresolved findings across compaction and restarts. Investigate uncertain side effects before retrying.
- **Human control:** Pause for cancellation, denied permission, or unknown action outcomes. Require explicit authorization to resume. Preserve user changes and prevent workers from rewriting their governing instructions.
- **Native compatibility:** Extend OpenCode V2 without changing ordinary Plan and Build behavior.

Success means less routine supervision, preserved user control, and evidence for each completion claim.

Writing follows ASD-STE100 sentence conventions. Full official dictionary conformity is not verified.
