# Documentation index

Start with the [project overview](../README.md), the [package guide](../packages/prometheus/README.md) for installation, or the [browser operations guide](BROWSER-OPERATIONS.md) for browser setup.

## Product and runtime

| Document | Purpose |
| --- | --- |
| [Project overview](../README.md) | Commands, workflow, and basic verification |
| [Specification](../SPEC.md) | Product requirements and acceptance limits |
| [Package guide](../packages/prometheus/README.md) | Installation, compatibility, tool inputs, and v0.1 migration |
| [Runtime reference](PROMETHEUS.md) | Execution flow, storage keys, candidate manifest, and interruption rules |
| [Verification guide](VERIFICATION.md) | Automated tests, required scenarios, live-model tests, and acceptance limits |

## Browser integration

The browser runtime runs separately from goal execution and installs under `<config_dir>/prometheus-browser/`.

| Document | Purpose |
| --- | --- |
| [Resource selection rule](../rules/resource-selection.md) | Short workflow instructions and safeguards for OpenCode |
| [Browser reference](RESOURCE-SELECTION.md) | Settings, profiles, login, file transfers, and failure procedures |
| [Shopping workflow](BROWSER-SHOPPING-WORKFLOW.md) | Product and cart verification, followed by manual checkout |
| [CAPTCHA guide](BROWSER-2CAPTCHA.md) | Provider coverage, paid authorization, proxy disclosure, ledger, and reconciliation |
| [Operations guide](BROWSER-OPERATIONS.md) | Installation, proxy setup, migration, updates, rollback, and verification |
| [Proxy specification](BROWSER-PROXY-SPEC.md) | Proxy requirements and acceptance criteria |
| [Proxy design](BROWSER-PROXY-LLD.md) | Parser, storage, identities, lifecycle, routing, and tests |

## Documentation maintenance

See the [writing guide](WRITING-GUIDE.md) and [project terms](TECHNICAL-TERMS.md).
