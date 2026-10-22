# Documentation index

Each subject has one detailed reference. Other documents link to that reference.

## Product and runtime

| Document | Purpose |
| --- | --- |
| [Project overview](../README.md) | Commands and user workflow. |
| [Specification](../SPEC.md) | Product requirements and acceptance criteria. |
| [Package guide](../packages/prometheus/README.md) | Installation, compatibility policy, and package limits. |
| [Runtime reference](PROMETHEUS.md) | Architecture, records, process boundaries, recovery, and native findings. |

## Scenarios and Verification

Scenarios define what to test. Verification defines how to collect and assess the evidence.

| Document | Purpose |
| --- | --- |
| [Scenarios](SCENARIOS.md) | Required behavior and fault scenarios, requirement-to-check map, and evaluation criteria. |
| [Verification](VERIFICATION.md) | Test execution, evidence classes, comparison rules, and release gates. |
| [Scenario runner](../packages/prometheus/qualification/README.md) | Admission, manifest fields, execution, checkpoints, and failure handling. |

Accepted service versions come from the package policy.
Keep exact tested versions and results with private verification reports.

## Browser integration

The browser runtime is separate from goal execution.
The installer places it under `<config_dir>/prometheus-browser/`.

| Document | Purpose |
| --- | --- |
| [Resource selection rule](../rules/resource-selection.md) | Compact rule loaded in OpenCode instructions. |
| [Browser reference](RESOURCE-SELECTION.md) | Shared settings, browser actions, login, transfers, and failure handling. |
| [Operations guide](BROWSER-OPERATIONS.md) | Installation, updates, rollback, recovery, and verification procedures. |
| [Profile reference](BROWSER-PROFILES.md) | Catalog sources, explicit selection, reproducibility, and identity limits. |

Local `TEMP-` notes are ignored by Git. They are not published references or active work plans.
