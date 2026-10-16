# Resource Selection

Unless a workflow is specified, prefer local context, direct pages/APIs,
text-only search, then browser automation.

## Browser workflow

Select backend, mode, authentication, and recording in this order:
1. Explicit user direction for the current task.
2. Project-local browser instructions.
3. Managed `prometheus-browser` defaults.

This delegates workflow choices, not higher-priority instructions or the shared
safeguards below. User/project workflows may share a headed task window.
State the selected backend, mode, and session; do not silently switch workflows.
Report unavailable capabilities rather than treating defaults as a ban.
Tool availability alone selects neither a workflow nor recording.

When using `prometheus-browser`, read `../docs/RESOURCE-SELECTION.md` relative to
this rule before browser actions. Follow its relevant tool procedures even in
user/project-selected workflows. Apply its managed mode and login procedures only
when using the default managed workflow.

## Shared safeguards

- Use a dedicated automation profile. Keep saved authentication outside repositories,
  owner-only (mode 0600), and scoped to approved origins. Never expose credentials
  or authentication state in model context, logs, screenshots, or recordings.
- Pause agent actions during human control; inspect the page on handback. Do not
  poll for login completion or infer it from a redirect alone; verify task access.
- Recording requires explicit intent, capture scope, local destination, and a stop
  procedure. Exclude authentication and verify the saved artifact before success.
- Use visible, enabled controls; verify entered values and attachment acceptance.
- Verify submissions from page evidence. Validate downloads/generated files locally
  for nonzero size, type, and required content/hash without overwriting unrelated files.
  A preview is not delivery; an existing image is not a new generation result.
- Record intent before non-idempotent actions. After interruption, mark the outcome
  unknown and inspect before retrying; never automatically replay unknown actions.
- Use bounded waits. Report HTTP 401/403 and challenges as access denial; do not
  retry through another workflow or change settings to bypass denial.
