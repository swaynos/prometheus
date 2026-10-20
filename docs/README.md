# Prometheus Documentation Index

This directory contains documentation organized across three distinct functional domains.

## 1. Core Goal Engine & Architecture

Architecture, operational boundaries, limits, and implementation details for Prometheus native Plan/Build execution.

| Document | Purpose |
| --- | --- |
| [SPEC.md](file:///Users/jpswaynos/Git/prometheus/SPEC.md) | Complete specification: workflow mechanics, limits, acceptance criteria. |
| [PROMETHEUS.md](file:///Users/jpswaynos/Git/prometheus/docs/PROMETHEUS.md) | Runtime operations, process limits, directory layouts, and recovery. |
| [IMPLEMENTATION.md](file:///Users/jpswaynos/Git/prometheus/docs/IMPLEMENTATION.md) | Technical implementation architecture, controller design, and state models. |
| [packages/prometheus/README.md](file:///Users/jpswaynos/Git/prometheus/packages/prometheus/README.md) | Controller package setup, command registrations, and local installation. |

## 2. Qualification & Verification

Procedures and evidence matrices verifying real-model autonomous behavior.

| Document | Purpose |
| --- | --- |
| [QUALIFICATION.md](file:///Users/jpswaynos/Git/prometheus/docs/QUALIFICATION.md) | Release qualification protocol, runner instructions, and snapshot procedures. |
| [QUALIFICATION-MATRIX.md](file:///Users/jpswaynos/Git/prometheus/docs/QUALIFICATION-MATRIX.md) | Detailed acceptance test matrix across execution categories. |
| [QUALIFICATION-CONTEXT.md](file:///Users/jpswaynos/Git/prometheus/docs/QUALIFICATION-CONTEXT.md) | Model evaluation baselines, prompt contexts, and behavioral requirements. |

## 3. Managed Browser MCP Integration

Playwright browser profile runtime installed outside repositories into OpenCode configuration (`<config_dir>/prometheus-browser/`). Kept separate from goal execution.

| Document | Purpose |
| --- | --- |
| [rules/resource-selection.md](file:///Users/jpswaynos/Git/prometheus/rules/resource-selection.md) | Compact rule deployed to `<config_dir>/prometheus-browser/rules/` and loaded in OpenCode instructions. |
| [RESOURCE-SELECTION.md](file:///Users/jpswaynos/Git/prometheus/docs/RESOURCE-SELECTION.md) | Full browser reference deployed to `<config_dir>/prometheus-browser/docs/` for `/browser` workflows and human-login handoffs. |
| [BROWSER-OPERATIONS.md](file:///Users/jpswaynos/Git/prometheus/docs/BROWSER-OPERATIONS.md) | Operator operations, update, and rollback runbook for OpenCode V2 managed browser installations. |
