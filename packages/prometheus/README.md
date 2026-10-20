# OpenCode Prometheus

Prometheus extends native OpenCode V2 Plan and Build.
It supplies conversation-derived goals, persistent repair, and independent acceptance.

## Status

This package is experimental.
Deterministic tests and scripted native tests establish mechanics.
Real-model qualification remains necessary.

The native contract targets OpenCode 2.0.29.
The package rejects other service versions until their native contract passes qualification.
The managed process boundary currently supports macOS `sandbox-exec`.
Other platforms reject process execution before launch.

## Installation

Install a packaged copy outside the project that the worker can change.
Do not load the active controller from a worker-writable checkout.
The package rejects that configuration.

From the repository root, install the dependencies:

```sh
npm ci --prefix packages/prometheus
```

Create an archive in an existing owned output directory:

```sh
npm pack ./packages/prometheus --pack-destination /absolute/path/to/package-output
```

Extract the archive into a separate installation directory.
The archive contains a `package/` directory.
Use that directory in the configuration below.
Node-based operator and qualification tools also need the package dependencies there.

Add the package directory to the V2 `plugins` configuration.
Preserve unrelated configuration.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-prometheus",
      "options": {
        "limits": { "maxRequests": 100 }
      }
    }
  ]
}
```

This example authorizes 100 model requests per workflow.
Choose your own allowance. The package supplies no hidden default allowance.
Optional limits include `deadline` and `maxUSD`.
Use Unix milliseconds for `deadline`.
The cost limit uses observed estimates. It is not a billing guarantee.

Optional `stateDirectory` selects a private directory outside the target project.
The default is `$XDG_STATE_HOME/prometheus`, or `~/.local/state/prometheus`.
Optional `protectedPaths` adds protected locations.

Inspect the loaded plugin version after installation.
Installation does not prove that an existing service loaded new code.

## Commands

| Command | Purpose |
| --- | --- |
| `/spike` | Investigate a technical question. |
| `/grill-me` | Resolve consequential user decisions. |
| `/goal [instructions]` | Infer the goal from the conversation. Prepare in Plan. Execute in Build. |

There is no `/plan` command.
Optional goal instructions are ordinary directions, not reserved command variants.

Switching to Build does not start execution.
“Continue your investigation work” preserves investigation intent.
“Execute your plan” executes the identifiable prepared goal in Build.

## Execution

The controller creates one fresh Build worker.
The worker retains its conversation through ordinary repair.
A fresh evaluator checks the exact candidate.
Every required criterion must pass.

The internal `prometheus_control` tool records the workflow.
It is not another user command or agent.

Managed processes enforce file boundaries.
Native file-mutation tools and native shell tools are unavailable within enrolled workflows.
Use the managed process action for changes and executable checks.
Native shell permission checks apply to the displayed invocation.
This does not reproduce native shell scanning inside arbitrary programs.
Parent session restrictions remain in child sessions.

The process timeout defaults to 120000 milliseconds.
A procedure can request another positive timeout.
The task deadline can shorten it.
Processes retain at most 1 MiB of combined output.
The result identifies truncated output.

Evaluators execute declared procedures against read-only candidates.
Use `{scratch}` for disposable outputs.
Use `{project}` for source files during investigation.
Write experiments use an owned directory rather than the product directory.

## Limits

- Candidate capture excludes `.git`, `.opencode`, `node_modules`, and credential files named `.env` or `.env.*`.
- Required excluded artifacts need a different evidence method. Do not claim that capture proves their contents.
- Candidate capture rejects absolute symlinks, external symlinks, and files with multiple hardlinks.
- Arbitrary external deliverables need explicit external evidence.
- A process receipt does not prove a remote business outcome.
- Unknown consequential effects prevent automatic replay.
- `/browser` remains a separate human-invoked workflow.
- Invoke `/browser` in a separate native conversation. Enrolled sessions do not receive browser tools.
- No real-model reliability claim accompanies this version.

## Qualification tools

Read [the runner reference](qualification/README.md) for multi-step scenarios, independent checks, and paired native-Build runs.
Approval binds the runtime, fixtures, and procedures. The campaign ledger shares one request allowance across both arms and all model work.
Follow-up attempts can carry prior consumption instead of resetting it.
The tools require a user-selected model and allowance before paid execution.
Campaign completion does not establish full-release qualification.

Writing follows ASD-STE100 sentence conventions. Full dictionary conformity is not verified.
