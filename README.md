# Prometheus

Prometheus extends OpenCode V2 with technical investigation, requirement clarification, and independent verification.
OpenCode owns execution, tools, permissions, and goal continuation.

## Commands and Tools

| Surface | Owner | Purpose |
| --- | --- | --- |
| `/spike <question>` | Prometheus | Investigate with permitted native tools. |
| `/grill-me [instructions]` | Prometheus | Clarify consequential user decisions. |
| `/goal <objective>` | OpenCode | Continue work toward an explicit objective. |
| `prometheus_record` | Prometheus | Store or read session findings and decisions. |
| `prometheus_verify` | Prometheus | Run or inspect independent candidate verification. |

Preparation commands stay in the current Plan or Build session. They do not start implementation or a goal.
Give native `/goal` an explicit objective after preparation:

```text
/goal Implement the agreed settings screen and verify its acceptance criteria.
```

OpenCode owns `/goal pause`, `/goal resume`, and `/goal clear`. An empty `/goal` does not infer an objective.

## Verification and Records

Use `prometheus_verify` in Build to dispatch a fresh evaluator session.
The evaluator checks the current workspace with native tools and cites completed tool evidence for each criterion.
The origin session performs repairs. Prometheus does not run a repair loop or OS sandbox.

Use `prometheus_record` to store model-written findings and user decisions.
Model reports do not establish independent acceptance.

## Installation and Checks

Require stable OpenCode **>=2.2.1 <3.0.0**. See the [package guide](packages/prometheus/README.md).

```sh
npm run test:controller
npm run test:controller:native
npm test
```

See the [specification](SPEC.md) and [documentation index](docs/README.md).
