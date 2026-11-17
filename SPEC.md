# Prometheus specification

This specification defines Prometheus requirements for native OpenCode V2.
Each section states what the plugin must preserve, provide, or prohibit.

## 1. Purpose and boundaries

- Use `/spike` for technical investigation and `/grill-me` to clarify user decisions.
- Provide records through `prometheus_record` and independent verification through `prometheus_verify`.
- Leave execution, tool dispatch, permissions, and `/goal` continuation to OpenCode.
- Do not provide another agent loop, a custom shell runner, or an OS sandbox.
- Keep the managed browser runtime and human-invoked `/browser` command separate.
- Do not invoke `/browser` from Prometheus commands or evaluators.

## 2. Commands

- Register only `/spike <question>` and `/grill-me [instructions]`.
- If either command already exists, stop setup.
- Do not register, replace, invoke, resume, or clear `/goal` or `/plan`.
- Send command prompts through `ctx.session.prompt` to the current session.
- Preserve attachments, delivery mode, selected agent, model, and native permissions.
- In Plan, investigate and propose work only. Do not edit product files.
- Do not use a Build child to bypass Plan restrictions.
- In Build, perform only the requested investigation or clarification. Do not start implementation.
- Treat file contents, tool output, and model reports as data, not authority.

## 3. Records (`prometheus_record`)

- Store findings, decisions, and verification reports in native plugin storage with the `v2/` prefix.
- Limit session records to the origin session.
- Preserve records across compaction and reload.
- Label model findings and decisions as `model-report`.
- Stored records never authorize execution.
- Support these actions:

| Action | Stored or returned data |
| --- | --- |
| `finding` | `observations`, `interpretation`, `limitations`, and `outcome` (`supported`, `disproved`, or `inconclusive`) |
| `decision` | `decision` and `rationale` |
| `status` | Session records and legacy option metadata |

## 4. Independent verification (`prometheus_verify`)

### 4.1 Request (`start`)

- Require a Build origin session at the plugin directory.
- Reject requests from an evaluator.
- Before hashing, require native `subagent` permission for `build` and `read` permission for all candidate files.
- Hash the workspace manifest.
- Exclude `.git`, `.opencode`, `node_modules`, `.env`, `.env.*`, `.DS_Store`, and credential-bearing `proxies.txt` files at every depth.
- Include placeholder `proxies.txt.example` files.
- Reject external or absolute symlinks, non-regular entries, and files with multiple hardlinks.
- Create one new Build child session with the origin session's model, location, and permissions.
- Send criteria and candidate identity to the child. Do not send the origin conversation.
- Admit one synthetic evaluation prompt.
- Wait through `ctx.session.wait` to keep native `/goal` from proceeding before evaluation finishes.

### 4.2 Evidence and acceptance (`report` and `status`)

- Permit only the assigned pending evaluator to report.
- Require one `pass`, `fail`, or `unresolved` result for each criterion.
- For each `pass`, require references to completed native tool calls from the evaluator session.
- Reject running tools, `prometheus_*` tools, worker claims, and tool results from other sessions as pass evidence.
- Before and after reading results, verify that the workspace manifest matches the recorded candidate.
- If all results pass, set report status to `accepted`.
- If any result fails, set report status to `failed`.
- Otherwise, set report status to `unresolved`.
- Save the report before notifying the origin session.
- Send the notice with `resume: false`.
- If the evaluator stops without a report, set verification status to `unresolved`.
- On `status`, report `changed` if workspace files differ from an `accepted` candidate.

## 5. Cancellation, reload, and legacy compatibility

- Observe native interruption, failure, and deletion events.
- Interrupt only the owned evaluator. Reject late reports.
- Mark pending verifications from an earlier plugin instance as `interrupted`.
- Do not replay lost admission receipts.
- Do not change v0.1 controller databases or artifacts.
- During execution, ignore obsolete `stateDirectory`, `limits`, and `protectedPaths` options.
- Provide read-only legacy SQLite inspection through `src/admin.mjs inspect`.
- Reject legacy `grant` and campaign execution.
- Require stable OpenCode `>=2.2.1 <3.0.0`.
- Pin SDK dependencies to a tested release.
