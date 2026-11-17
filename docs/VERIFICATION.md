# Verification guide

Use automated tests to check integration behavior, then approved live-model tests to assess model judgment.
The results establish only the behavior and configurations actually tested.

## Automated tests

Run these commands from the repository root:

```sh
npm run test:controller
npm run test:controller:native
npm test
npm run docs:check
git diff --check
```

| Command | Coverage |
| --- | --- |
| `test:controller` | Plugin registration, version restrictions, storage, manifests, verification, and read-only v0.1 database inspection |
| `test:controller:native` | A packed plugin in isolated OpenCode services with a local scripted provider on Linux or macOS |
| `test` | Browser integration tests |
| `docs:check` | Local Markdown links and section references |
| `npm --prefix packages/prometheus run qualification:catalog` | Machine-readable scenario catalog from `packages/prometheus/qualification/scenarios.mjs` |

The retired v0.1 campaign runner, `qualification/run.mjs`, rejects execution without making network or model requests.

## Required scenarios

| ID | Scenario | Required observation |
| --- | --- | --- |
| N01 | Native goal ownership | Exactly one native `/goal` exists. Prometheus does not replace or invoke it. |
| N02 | Command admission | `/spike` and `/grill-me` preserve attachments, delivery, agent, model, and permissions. |
| N03 | Plan restrictions | Plan sessions do not write product files or create Build evaluators. |
| N04 | Linux execution | Native shell and edit tools execute without a custom process runner. |
| N05 | Native continuation | Native `/goal` reviews and continues work after preparation commands. |
| N06 | Independent verification | A new evaluator cites completed native tool results from its own session. |
| N07 | Repair in origin | Failed or unresolved reports return to the origin session. The plugin does not run a repair loop. |
| N08 | Human control | Permission denials, cancellations, and reloads stop work. Work does not restart automatically. |
| F01–F06 | Fault handling | Reject changed candidates, worker claims, late reports, lost receipts, legacy runs, and denied checks. |

## Live-model qualification

Scripted tests establish integration behavior, not model judgment.
Before a live-model test, obtain approval for the model, budget, and output path.
Then check the following behavior:

1. `/spike` and `/grill-me` keep model findings separate from user decisions.
2. Plan investigations request Build instead of bypassing write restrictions.
3. Native `/goal <objective>` completes repairs without repeated manual prompts.
4. `prometheus_verify` rejects defective candidates.
   It accepts repaired candidates only with direct tool evidence.
5. Required checks that lack permission report `unresolved`.
   Interruptions and reloads do not restart work.

## Acceptance limits

- Native permissions and file hashes do not provide an OS sandbox.
- Tool references establish execution, not the completeness of the evaluator's reasoning.
- Excluded paths and external systems require separate evidence.
  Exclusions include `.git`, `.opencode`, `node_modules`, `.env*`, `.DS_Store`, and credential-bearing `proxies.txt` files.
  Placeholder `proxies.txt.example` files remain included.
