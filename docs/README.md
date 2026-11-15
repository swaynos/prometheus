# Documentation Index

Each topic has one reference document.

## Product and Runtime

| Document | Purpose |
| --- | --- |
| [Project overview](../README.md) | Commands, workflow, and quick checks. |
| [Specification](../SPEC.md) | Product requirements and acceptance boundaries. |
| [Package guide](../packages/prometheus/README.md) | Installation, OpenCode compatibility, tool inputs, and v0.1 migration. |
| [Runtime reference](PROMETHEUS.md) | Execution flow, storage keys, candidate manifest, and interruption rules. |
| [Verification guide](VERIFICATION.md) | Automated suites, required scenarios, live-model checks, and acceptance limits. |

## Browser Integration

The browser runtime is separate from goal execution and installs under `<config_dir>/prometheus-browser/`.

| Document | Purpose |
| --- | --- |
| [Resource selection rule](../rules/resource-selection.md) | Compact workflow and safeguard rule loaded in OpenCode instructions. |
| [Browser reference](RESOURCE-SELECTION.md) | Shared settings, profiles, login handoff, file transfers, and failure handling. |
| [Shopping workflow](BROWSER-SHOPPING-WORKFLOW.md) | Product, availability, cart verification, and manual handoff limitations. |
| [2captcha policy and accounting](BROWSER-2CAPTCHA.md) | Explicit paid-solve authorization, private ledger, and reconciliation. |
| [Operations guide](BROWSER-OPERATIONS.md) | Installation, migration, updates, rollback, and verification procedures. |
| [Proxy pool specification](BROWSER-PROXY-SPEC.md) | Implemented persistent sessions, proxy rotation, safety, and acceptance criteria; Linux headless and Xvfb remain unverified. |
| [Proxy pool low-level design](BROWSER-PROXY-LLD.md) | Implemented storage, lifecycle, routing, integration, and test design; see specification for qualification limits. |
