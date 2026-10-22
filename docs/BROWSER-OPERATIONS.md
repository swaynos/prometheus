# Browser operations and recovery

The managed browser runtime is separate from Prometheus goal execution.
It supports macOS and Linux. Windows execution is not supported.
Use the [browser reference](RESOURCE-SELECTION.md) for settings, login, tool procedures, and access-denial handling.
Use the [profile reference](BROWSER-PROFILES.md) for preset selection and identity limits.

## Scope and installed files

The installer manages OpenCode V2 `mcp.servers`, browser permission rules, and JSON/JSONC configuration.
It does not migrate OpenCode V1 configuration or change the goal controller and native Plan/Build permissions.
It changes only the selected configuration root, not source or project files.

| Surface | Installed location or name |
| --- | --- |
| MCP server | `prometheus-browser` |
| Tools | `prometheus-browser_browser_*` |
| Runtime and pinned dependencies | `<config_dir>/prometheus-browser/` |
| Instruction rule | `<config_dir>/prometheus-browser/rules/resource-selection.md` |
| Browser reference | `<config_dir>/prometheus-browser/docs/RESOURCE-SELECTION.md` |
| Shared settings | `<config_dir>/prometheus-browser.json` |
| Saved authentication | `<config_dir>/prometheus-sessions/` |
| Login coordination | `<config_dir>/prometheus-logins/` |
| Installation receipt | `<config_dir>/prometheus-browser-migration.json` |

Keep the separate `rules/` and `docs/` directories. They prevent filename conflicts on case-insensitive filesystems.

## Installation and migration

1. Select a configuration root outside repositories. Use Node `>=22.22.2 <25`.
   Run `npm ci` from the repository root.
2. Install the selected browser. Use `npx playwright install chromium` for bundled Chromium, or install Google Chrome for `channel: "chrome"`.
   Linux `virtual-display` mode also requires Xvfb, `xvfb-run`, and `xauth`.
3. Finish or cancel login handoffs. Stop affected browser tasks, login helpers, and OpenCode servers.
   Obtain authority before stopping another person's work.
   `--quiescent` records your assertion; it does not detect or stop active work.
4. Run the installer and inspect status:

```sh
node scripts/browser-profile.mjs install --config-dir "$HOME/.config/opencode" --quiescent
node scripts/browser-profile.mjs status --config-dir "$HOME/.config/opencode"
```

Add `--migrate` when replacing a recognized local `cuddly-winner-browser` registration.
The installer refuses that registration without the flag.
Inspect project and ancestor configuration, commands, rules, and inherited environment settings for old namespace references.
Reconcile those overrides in their owning files. The installer does not edit them.

Migration preserves JSONC comments, unrelated settings, server options, and disabled state.
It renames registered browser environment keys and permission/policy patterns, including inline agent rules.
It replaces only the exact known legacy rule reference and grants no additional tool permissions.
Custom registrations, command collisions, modified legacy rules, conflicting destination data, ambiguous configuration files, and unsafe paths require manual reconciliation.

The installer registers `/browser` as a human-invoked Build prompt command, not an automatic controller action.
It prepares dependencies in private staging and checks a blank-page browser launch before publication.
The check loads no saved accounts. The installer does not download browser executables.
A preparation or readiness failure leaves the preceding registration active and permits retry.

Migration copies settings and saved sessions; it does not move or delete the originals.
Private files use mode 0600. New private directories use mode 0700.
Conflicting destination bytes are not overwritten. Login coordination records are not copied or replayed.
Status output does not expose cookie or storage values.

After installation, restart affected OpenCode services. Check the MCP connection and invoke `/browser` in a new, separate native conversation.
Installation status confirms configuration and tracked bytes, not that a running service loaded them.
Verify task access after state reuse. Copied files and redirects do not prove authentication.

## Updates and status

Run `install --quiescent` from the updated checkout. An owned installation does not need `--migrate`.
Do not update an active installation by copying runtime files manually.

Unchanged shipped bytes cause a no-op after another readiness check.
Changed runtime, documentation, or lockfile bytes cause a staged update.
The previous runtime, dependencies, and untracked siblings remain in a private backup.
Untracked siblings are not copied into the new runtime. Keep task outputs outside that directory.

`status` reports `configured`, `legacyConfigured`, `receipt`, `pending`, `drift`, and `updateAvailable`.
Drift covers tracked files and owned configuration fields, including permission-rule positions.
Changed shared settings, refreshed authentication, and unrelated configuration edits are not drift.
Inspect owned-field changes instead of overwriting them.

Missing or changed installed dependency manifests block a no-op installation.
Inspect and remove/reinstall the owned profile to repair its dependency tree.
`configured` alone does not prove dependency or browser readiness.

Updates preserve shared settings. They do not change display settings, execution modes, selected browsers, or authentication.
After an update, restart affected OpenCode services and verify the loaded runtime.

## Rollback, removal, and interrupted operations

Stop affected work before either operation:

```sh
node scripts/browser-profile.mjs rollback --config-dir "$HOME/.config/opencode" --quiescent
# Or remove a completed installation:
node scripts/browser-profile.mjs remove --config-dir "$HOME/.config/opencode" --quiescent
```

For a completed installation, both operations restore the original registration, command, permission patterns, and rule reference.
They preserve later unrelated configuration edits and current Prometheus settings and authentication.
They do not merge newer state into a restored legacy namespace. Verify account access before using the restored server.

Unchanged configuration can be restored byte-for-byte.
Modified owned files or configuration fields block removal to preserve user work.
The runtime is archived, not recursively deleted.
Backups and receipts remain under `<config_dir>/prometheus-browser-backups/`.
They can contain private configuration and authentication. Do not publish or commit them.

An interrupted operation leaves `prometheus-browser-pending.json` and blocks further installation or removal.
Inspect `status`, stop affected work, then run `rollback --quiescent` to restore the preceding installation.
Successful recovery clears the pending transaction and permits retry. It does not restart tasks or replay browser actions.
Newer conflicting bytes block recovery and remain untouched.
A dead installer lock can be reclaimed. A live or unrecognized lock requires inspection.

Unversioned receipts are not ownership proof. Preserve their backups and reconcile them manually.
Do not delete a live runtime or change authentication to force a passing status.

## Verification

Run browser checks from the repository root:

```sh
node --test tests/integration/browser_profile.test.mjs
npm test
```

Use `PROMETHEUS_TEST_BROWSER_CHANNEL=chrome npm test` to include installed Chrome in browser-channel checks and the isolated installed-runtime test.
The default suite tests bundled browser paths. Tests use local fixtures and synthetic saved state, not real accounts or challenged public sites.
They cover installation, migration, updates, rollback, recovery, file transfers, runtime settings, and unsafe paths.
Linux virtual-display tests require Xvfb. Skips on another platform do not establish Linux display coverage.
Live login and site-specific access require separate human-authorized checks.

Before and after a validation task, capture `browser_status`.
Retain the Node and Playwright versions, platform, architecture, configured distribution, launch/context settings, and actual running browser version.
This metadata is diagnostic context, not proof of site access. Launch metadata does not list every internal Playwright argument.

For goal-controller checks and release gates, use the separate [verification procedure](VERIFICATION.md).
