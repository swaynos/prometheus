# Verification Guide

## Automated Suites

Run all checks from the repository root:

```sh
npm run test:controller
npm run test:controller:native
npm test
git diff --check
```

- `test:controller`: runs unit tests for plugin registration, version guards, storage, manifests, verification, and v0.1 database inspection.
- `test:controller:native`: packs the plugin and runs isolated OpenCode services against a local scripted provider on Linux or macOS.
- `test`: runs the browser integration suite.
- `npm --prefix packages/prometheus run qualification:catalog`: prints the machine-readable scenario catalog (`packages/prometheus/qualification/scenarios.mjs`).

The v0.1 campaign runner (`qualification/run.mjs`) is retired and fails closed without network or model requests.

## Required Scenarios

| ID | Scenario | Required Observation |
| --- | --- | --- |
| N01 | Native goal ownership | Exactly one native `/goal` exists; Prometheus never replaces or invokes it. |
| N02 | Command admission | `/spike` and `/grill-me` preserve attachments, delivery, agent, model, and permissions. |
| N03 | Plan restrictions | Plan sessions do not write product files or spawn Build evaluators. |
| N04 | Linux execution | Native shell and edit tools execute without a custom process runner. |
| N05 | Native continuation | Native `/goal` reviews and continues work after preparation commands. |
| N06 | Independent verification | Fresh evaluator cites completed native tool results from its own session. |
| N07 | Repair in origin | Failed or unresolved reports return to the origin without a plugin repair loop. |
| N08 | Human control | Permission denials, cancellations, and reloads stop work without auto-restart. |
| F01–F06 | Fault handling | Rejects changed candidates, worker claims, late reports, lost receipts, legacy runs, and denied checks. |

## Live-Model Qualification

Scripted tests prove integration mechanics, not model judgment. For live-model checks, obtain explicit approval for the model, budget, and output path, then verify:

1. `/spike` and `/grill-me` keep model findings separate from user decisions.
2. Plan investigations request Build rather than bypassing write restrictions.
3. Native `/goal <objective>` completes repairs without repeated manual prompts.
4. `prometheus_verify` rejects defective candidates and passes repaired candidates using direct tool evidence.
5. Denied required checks report `unresolved`. Interruptions and reloads do not restart work.

## Acceptance Limits

- Native permissions and file hashes are not an OS sandbox.
- Tool reference checks prove that a tool ran, not that the evaluator's reasoning is complete.
- Excluded paths (`.git`, `.opencode`, `node_modules`, `.env*`, `.DS_Store`) and external systems require separate evidence.
