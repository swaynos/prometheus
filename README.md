# Prometheus

Prometheus extends OpenCode V2 with investigation, requirement clarification, and independent verification.
**OpenCode owns execution.** Prometheus uses native sessions, tools, permissions, and goal continuation.

## Commands

| Command | Owner | Purpose |
| --- | --- | --- |
| `/spike <question>` | Prometheus | Investigate with permitted native tools. |
| `/grill-me [instructions]` | Prometheus | Resolve consequential user decisions. |
| `/goal <objective>` | OpenCode | Continue work toward an explicit objective. |

Use the preparation commands as needed. They stay in the current session and preserve Plan or Build.
They do not start a goal or product implementation.

After preparation, give native `/goal` an explicit objective:

```text
/goal Implement the agreed settings screen and verify its acceptance criteria.
```

OpenCode provides `/goal pause`, `/goal resume`, and `/goal clear`.
An empty native `/goal` does not infer the objective from the conversation.

## Verification

Ask the Build agent to use `prometheus_verify` when you need a fresh evaluator.
The evaluator uses native tools and reports evidence for each criterion.
The originating session handles repairs. Prometheus does not run another execution loop.

The evaluator examines the current workspace. Native permissions apply.
File hashes detect changes; they do not provide process isolation or prevent edits.
See the [runtime reference](docs/PROMETHEUS.md) for evidence and candidate limits.

Findings and decisions can be stored with `prometheus_record`.
These model reports are separate from independent acceptance.

## Installation and migration

Require stable OpenCode **2.2.1 or later, below 3.0.0**.
See the [package guide](packages/prometheus/README.md).

Version 0.2 removes the custom `/goal`, managed process runner, and macOS-only sandbox.
Old controller data stays unchanged. Old runs do not resume.
The old controller budget and isolation guarantees no longer apply.

## Checks

```sh
npm run test:controller
npm run test:controller:native
npm test
```

Native integration tests use owned services and a local scripted provider. They do not use a paid model.
Real-model reliability remains unverified.

The separate browser runtime and human-invoked `/browser` workflow are unchanged.

See the [specification](SPEC.md) and [documentation index](docs/README.md).
