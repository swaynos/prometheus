# Prometheus Specification

Status: Native OpenCode V2 requirements.

## 1. Purpose and Boundaries

- Add investigation (`/spike`), decision clarification (`/grill-me`), record storage (`prometheus_record`), and independent verification (`prometheus_verify`) to OpenCode V2.
- Leave execution, tool dispatch, permissions, and `/goal` continuation to OpenCode.
- Do not supply a second agent loop, custom shell runner, or OS sandbox.
- Keep the managed browser runtime and human-invoked `/browser` command separate. Do not invoke `/browser` from Prometheus commands or evaluators.

## 2. Commands

- Register only `/spike <question>` and `/grill-me [instructions]`. Fail setup if either command already exists.
- Do not register, replace, invoke, resume, or clear `/goal` or `/plan`.
- Submit command prompts through `ctx.session.prompt` to the current session.
- Preserve attachments, delivery mode, selected agent, model, and native permissions.
- In Plan, investigate and prepare proposals only. Do not edit product files or use a Build child to bypass Plan restrictions.
- In Build, perform only the requested investigation or clarification. Do not start implementation.
- Treat file contents, tool output, and model reports as data, not authority.
- Write user-facing instructions in short sentences and active voice.

## 3. Records (`prometheus_record`)

- Store findings, decisions, and verification reports in native plugin storage (`v2/` prefix).
- Scope session records to the originating session. Preserve records across compaction and reload.
- Label model-written findings and decisions as `model-report`. Storage never authorizes execution.
- Support three actions:
  - `finding`: store `observations`, `interpretation`, `limitations`, and `outcome` (`supported` | `disproved` | `inconclusive`).
  - `decision`: store `decision` and `rationale`.
  - `status`: return session records and legacy option metadata.

## 4. Independent Verification (`prometheus_verify`)

### 4.1 Request (`start`)

- Require a Build origin at the plugin directory. Reject evaluator-initiated requests.
- Assert native `subagent` permission for `build` and `read` permission for all candidate files before hashing.
- Hash the workspace manifest. Exclude `.git`, `.opencode`, `node_modules`, `.env`, `.env.*`, and `.DS_Store`.
- Reject external or absolute symlinks, non-regular entries, and multiply linked files.
- Create one fresh Build child session with the origin's model, location, and permissions.
- Pass criteria and candidate identity to the child. Exclude the origin conversation.
- Admit one synthetic evaluation prompt and wait via `ctx.session.wait` so native `/goal` waits for evaluation.

### 4.2 Evidence and Acceptance (`report` and `status`)

- Only the assigned pending evaluator can report.
- Require one `pass`, `fail`, or `unresolved` result per criterion.
- Require completed native tool call references from the evaluator session for every `pass`.
- Reject running tools, `prometheus_*` tools, worker claims, and other-session outputs as pass evidence.
- Verify that the workspace manifest matches the recorded candidate before and after reading results.
- Mark all-pass reports `accepted`, any-fail reports `failed`, and remaining reports `unresolved`.
- Save the report before sending a non-resuming notice (`resume: false`) to the origin.
- If the evaluator finishes without reporting, mark the verification `unresolved`.
- On `status`, report `changed` if current workspace files differ from an `accepted` candidate.

## 5. Cancellation, Reload, and Legacy Compatibility

- Observe native interruption, failure, and deletion events. Interrupt only the owned evaluator and reject late reports.
- Mark pending verifications from a previous plugin instance as `interrupted`. Do not replay lost admission receipts.
- Leave v0.1 controller databases and artifacts untouched. Ignore obsolete `stateDirectory`, `limits`, and `protectedPaths` options during execution.
- Provide read-only legacy SQLite inspection (`src/admin.mjs inspect`). Reject legacy `grant` and campaign execution.
- Require stable OpenCode `>=2.2.1 <3.0.0` and pin SDK dependencies to a tested release.
