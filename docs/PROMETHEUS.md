# Native Runtime Reference

## Execution Flow

```text
/spike or /grill-me -> ctx.session.prompt -> current Plan/Build session -> native tools -> prometheus_record
native /goal <objective> -> OpenCode continuation and review
prometheus_verify start -> permission admission -> workspace manifest -> fresh Build evaluator -> tool evidence -> report
```

Prometheus does not replace native tools, spawn shell processes, switch the active agent, or run a repair loop.

## Storage Keys

All native plugin storage keys use the `v2/` prefix:

| Key | Content |
| --- | --- |
| `v2/session/<sessionID>` | Session `findings` and `decisions` (`source: "model-report"`). |
| `v2/verification/<verificationID>` | Criteria, candidate manifest, origin/evaluator IDs, status, and report. |
| `v2/latest/<sessionID>` | Latest verification ID for an origin or evaluator session. |
| `v2/evaluator/<sessionID>` | Verification ID assigned to a child evaluator session. |

Writes to a session or verification key are serialized within the plugin instance.

## Verification Lifecycle

1. **Admission:** `start` requires a Build session at the plugin workspace. It asserts native `subagent` (`build`) and `read` permissions before hashing candidate files.
2. **Child Creation:** The plugin creates a Build child session with the origin's model, location, and permissions, then sends criteria and candidate metadata via `ctx.session.synthetic`.
3. **Evaluation:** The context hook injects completed native tool call IDs (`messageID`, `toolCallID`, `tool`, `hash`). The evaluator runs native tools and calls `prometheus_verify` (`report`).
4. **Acceptance:** Every `pass` must reference a completed non-Prometheus tool call from the evaluator session. Candidate hashes must match before and after report assembly.
5. **Notification:** The plugin saves the report first, then sends a synthetic notice to the origin with `resume: false`. If the evaluator stops without reporting, status becomes `unresolved`.

## Candidate Manifest Limits

- Includes tracked and untracked regular files and internal relative symlinks.
- Excludes `.git`, `.opencode`, `node_modules`, `.env`, `.env.*`, and `.DS_Store`.
- Rejects absolute or external symlinks, special files, and files with multiple hardlinks (`nlink > 1`).
- Detects file modifications before acceptance and during later `status` checks. It does not isolate processes or block writes.

## Interruption, Reload, and Legacy State

- Native interruption, failure, or deletion of the origin or evaluator marks a pending verification `interrupted` and interrupts the owned evaluator.
- Plugin unload aborts event subscriptions, marks active verifications `interrupted` without blocking reload, and disposes registrations.
- A new plugin instance marks `starting` or `pending` records from an older boot ID as `interrupted`.
- Old v0.1 SQLite files and options (`stateDirectory`, `limits`, `protectedPaths`) are ignored at runtime. Inspect old databases with `node packages/prometheus/src/admin.mjs inspect <dir>`.
