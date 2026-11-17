# Native runtime reference

Prometheus prepares work, records decisions, and requests independent evaluation.
OpenCode runs the tools and controls goal continuation.

## Execution flow

```text
/spike or /grill-me -> ctx.session.prompt -> current Plan/Build session -> native tools -> prometheus_record
native /goal <objective> -> OpenCode continuation and review
prometheus_verify start -> permission admission -> workspace manifest -> fresh Build evaluator -> tool evidence -> report
```

Prometheus does not replace native tools, start shell processes, switch the active agent, or run a repair loop.

## Storage keys

All native plugin storage keys start with `v2/`.

| Key | Content |
| --- | --- |
| `v2/session/<sessionID>` | Session `findings` and `decisions`, with `source: "model-report"` |
| `v2/verification/<verificationID>` | Criteria, candidate manifest, origin and evaluator IDs, status, and report |
| `v2/latest/<sessionID>` | Latest verification ID for an origin or evaluator session |
| `v2/evaluator/<sessionID>` | Verification ID assigned to a child evaluator session |

Within one plugin instance, writes to each session or verification key run in sequence.

## Verification lifecycle

1. **Admission:** `start` requires a Build session at the plugin workspace.
   Before hashing files, the plugin requires native `subagent` (`build`) and `read` permissions.
2. **Child creation:** The plugin creates a Build child with the origin session's model, location, and permissions.
   It sends criteria and candidate metadata through `ctx.session.synthetic`.
3. **Evaluation:** The context hook supplies completed native tool references: `messageID`, `toolCallID`, `tool`, and `hash`.
   The evaluator runs native tools and calls `prometheus_verify` with action `report`.
4. **Acceptance:** Each `pass` must reference a completed non-Prometheus tool call from the evaluator session.
   Candidate hashes must match before and after report assembly.
5. **Notification:** The plugin saves the report, then sends a synthetic notice with `resume: false` to the origin session.
   If the evaluator stops without a report, verification status becomes `unresolved`.

## Candidate manifest limits

The manifest identifies the candidate through tracked and untracked regular files and internal relative symlinks.
The following paths are excluded at every depth:

- `.git`
- `.opencode`
- `node_modules`
- `.env` and `.env.*`
- `.DS_Store`
- Credential-bearing `proxies.txt` files

Placeholder `proxies.txt.example` files remain included.
The manifest rejects absolute or external symlinks, special files, and files with multiple hardlinks (`nlink > 1`).
Hashes reveal changes before acceptance and during later `status` requests, but they do not isolate processes or prevent writes.

## Interruption, reload, and legacy state

- Native interruption, failure, or deletion of either session marks pending verification as `interrupted`.
  The plugin interrupts the owned evaluator.
- On unload, the plugin aborts event subscriptions and marks active verifications as `interrupted`.
  It disposes registrations without blocking reload.
- A new plugin instance marks `starting` or `pending` records from an older boot ID as `interrupted`.
- The runtime ignores v0.1 SQLite files and obsolete `stateDirectory`, `limits`, and `protectedPaths` options.
  For read-only inspection, run `node packages/prometheus/src/admin.mjs inspect <dir>`.
