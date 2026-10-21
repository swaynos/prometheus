# Browser Operations, Recovery, And Migration

Prometheus owns the managed Playwright browser integration. The five runtime
files started from `cuddly-winner`, with the namespace changed to `prometheus`.
Prometheus now adds optional context settings, input timing, readiness controls,
and runtime metadata. Browser work remains separate from goal execution.

## Source And Scope

The original imported runtime matched the browser files at source commit
`ccdf463463146c1fe1d2905ed08a83dbe0369de5` in `cuddly-winner`. The source checkout
was at `0b3e67f` when that match was verified. Ten imported browser test files
provide behavior regression coverage. `scripts/import-browser.mjs` is a one-time
bootstrap tool. It refuses to overwrite files and is not an update mechanism.
The current runtime includes local extensions. Do not describe it as an exact
namespace-only copy. Wrapper equality also does not establish dependency or
browser-version equality.

The installer targets OpenCode V2 `mcp.servers`, ordered permission rules, and
JSON/JSONC configuration. It does not migrate OpenCode V1 configuration. It does
not change the goal controller, generated Goal definitions, or native Plan/Build
permissions. It does not delete anything from the source project.

| Surface | Installed location or name |
| --- | --- |
| MCP server | `prometheus-browser` |
| Tools | `prometheus-browser_browser_*` |
| Runtime and pinned npm dependencies | `<config_dir>/prometheus-browser/` |
| Compact instruction rule | `<config_dir>/prometheus-browser/rules/resource-selection.md` |
| Tool and login reference | `<config_dir>/prometheus-browser/docs/RESOURCE-SELECTION.md` |
| Shared settings | `<config_dir>/prometheus-browser.json` |
| Private saved authentication | `<config_dir>/prometheus-sessions/` |
| Human login coordination | `<config_dir>/prometheus-logins/` |
| Active installation receipt | `<config_dir>/prometheus-browser-migration.json` |

The separate `rules/` and `docs/` directories are necessary on case-insensitive
filesystems. Do not flatten the two resource-selection files into one directory.

## Prepare And Cut Over

1. Select the configuration root. Keep it outside repositories. Use Node
   `>=22.22.2 <25`. Run `npm ci` from the Prometheus repository root.
2. Install the selected browser. For bundled Chromium, run
   `npx playwright install chromium`. For `channel: "chrome"`, install Google
   Chrome. Windows is not supported at this time; browser execution supports macOS and Linux.
   `virtual-display` requires Linux, Xvfb, `xvfb-run`, and `xauth`.
3. Inspect project and ancestor OpenCode configuration, agent definitions, command
   files, and custom rules for references to `cuddly-winner-browser` or
   `CUDDLY_WINNER_*`. Reconcile overrides in their owning projects. The installer
   changes only the selected configuration document, not other project files.
   Rename inherited shell or service `CUDDLY_WINNER_*` environment settings to
   `PROMETHEUS_*` too. Only environment values declared in the registration are
   renamed automatically.
4. Finish or cancel both old and new login handoffs. Stop affected browser tasks,
   login helpers, and OpenCode servers. Obtain authority before stopping another
   person's work. `--quiescent` records an operator assertion, not process detection.
5. Run the explicit cutover from the repository root:

```sh
node scripts/browser-profile.mjs install --config-dir "$HOME/.config/opencode" --migrate --quiescent
node scripts/browser-profile.mjs status --config-dir "$HOME/.config/opencode"
```

Omit `--migrate` for a fresh installation. The installer refuses an existing
legacy registration without that flag. It accepts only the recognized local
legacy script and configuration-root pairing. Custom registrations, command
collisions, modified legacy rules, conflicting destination data, ambiguous config
files, and unsafe filesystem paths require manual reconciliation.

The cutover preserves JSONC comments, unrelated settings, server options, and
disabled state. It renames browser environment keys and permission/policy patterns
in global and inline agent rules. It replaces only the exact known legacy rule
reference. It installs `/browser` as a Build prompt command, not a controller
command or an automatic worker action. It grants no additional tool permissions.

Settings and session files are copied, not moved. The original namespace remains
available for rollback. Copies use mode 0600 and newly created private directories
use mode 0700. Conflicting destination bytes are never overwritten. No cookie or
storage values are returned. Coordination records are never copied or replayed.

Dependencies are prepared in a private staging directory. A real blank-page
launch checks the selected browser mode before publication. It loads no saved
accounts. An unsuccessful preparation or readiness check leaves the old
registration active and permits retry. Browser executables are not downloaded
automatically by the installer.

After a successful cutover, restart the affected OpenCode services. Check the MCP
connection and use `/browser` in a new, separate native conversation. The source
installation status proves configuration and tracked bytes, not that an already
running service loaded them. Verify account or task access after state reuse.
Do not infer successful authentication from copied files or a redirect.

## Updates

Run the same `install --quiescent` command from the updated checkout. `--migrate`
is not required for an already owned installation. Unchanged shipped bytes cause
a no-op after another readiness check. Changed runtime, documentation, or
package-lock bytes cause a staged update. The previous runtime, dependencies,
and untracked siblings are retained
in a private backup. Untracked runtime siblings are not copied into the new live
runtime. Keep task outputs outside the managed runtime directory.

`status` reports `configured`, `legacyConfigured`, `receipt`, `pending`, `drift`,
and `updateAvailable`. Drift applies to tracked files and owned configuration
fields. Refreshed login state, changed settings, and unrelated configuration edits
are not installation drift. Changes to owned fields or permission-rule positions
require inspection instead of an automatic overwrite.

The readiness check also requires the pinned npm dependencies in the installed
directory. Missing or changed dependency manifests block a no-op installation.
Inspect and remove/reinstall the owned profile to repair that dependency tree.
The `configured` status alone does not prove dependency or browser readiness.

### Runtime Settings And Validation Context

Existing three-key browser settings remain valid. Optional `launchOptions` and
`contextOptions` are documented in [the browser reference](RESOURCE-SELECTION.md).
Settings files are preserved by installation; an update does not select new
display values, change modes, refresh authentication, or pin a different browser.

Before and after a validation task, capture `browser_status`. Record its
Playwright version, Node version, platform, architecture, configured distribution,
explicit launch options, context options, and running browser version. This is
diagnostic context, not a new startup gate or a universal access qualification.
The reported launch options do not enumerate every internal Playwright argument.

The optional navigation readiness selector and fixed typing delay do not add
random behavior or automatic retries. Denial classification precedes saved-login
verification, so a challenge is not treated as proof that credentials must be
captured again. The existing browser modes and workflow-selection rules remain.

Do not update an active installation by copying runtime files manually. Stop the
affected work, run the installer with a truthful `--quiescent` assertion, and
restart OpenCode. A repository change is not a loaded MCP service change.

## Rollback, Removal, And Interruptions

Stop affected work before either operation:

```sh
node scripts/browser-profile.mjs rollback --config-dir "$HOME/.config/opencode" --quiescent
# Or remove a completed installation:
node scripts/browser-profile.mjs remove --config-dir "$HOME/.config/opencode" --quiescent
```

For a completed installation, both operations restore the original registration,
command, permission patterns, and rule reference. This includes restoring the
legacy registration after a cutover. They preserve later unrelated configuration
edits. They retain all current Prometheus settings and saved authentication,
including refreshed or newly captured state. They do not merge newer state back
into the legacy namespace. Inspect account access before using the restored server.

Unchanged configuration can be restored byte-for-byte. Modified owned runtime
files or configuration fields block removal rather than losing user work. The
runtime is archived, not recursively deleted. Private backups and receipts remain
under `<config_dir>/prometheus-browser-backups/`. They can contain private config
and authentication copies. Do not publish, attach, or commit them.

An interrupted operation leaves `prometheus-browser-pending.json`. Further
installation or removal refuses to proceed. Inspect `status`, stop affected work,
then invoke `rollback --quiescent` to restore the preceding installation. A
successful recovery clears the pending transaction and permits retry. Recovery
does not restart a task or replay a browser action. Newer conflicting bytes block
recovery and remain untouched. A dead installer lock can be reclaimed; a live or
unrecognized lock requires inspection.

Unversioned receipts from the unfinished prototype are not treated as ownership
proof. Preserve their private backups and reconcile them manually before using
this installer. Do not delete a live runtime or change authentication to force a
passing status.

## Qualification

```sh
node --test tests/integration/browser_profile.test.mjs
npm test
npm run test:controller
npm run test:controller:native
```

To include installed Chrome in the browser-channel checks and the isolated
installed-runtime test, run `PROMETHEUS_TEST_BROWSER_CHANNEL=chrome npm test`.
The default suite still tests the bundled shell and full Chromium. These tests
use local fixtures, not accounts or challenged public sites.

The profile tests cover cutover, configuration preservation, state copies,
updates, rollback, removal, injected failures, interrupted-process recovery, and
unsafe paths. Their installed-runtime test uses actual isolated npm dependencies,
a headless browser, synthetic saved state, image attachment, and validated local
download bytes. No real account, headed login, or paid model is involved.

Linux-only virtual-display tests require Xvfb. On other hosts they remain explicit
skips; macOS results do not establish successful Linux display execution. Live
account login and site-specific access remain separate human-authorized checks.

### 2026-10-20 Import Qualification (Historical)

On macOS with Node 24.15.0:

| Check | Passed | Skipped |
| --- | --- | --- |
| `npm test` | 66 | 3 Linux/Xvfb cases |
| `npm run test:controller` | 109 | 0 |
| `npm run test:controller:native` | 13 | 0 |

The browser suite includes 16 migration/profile tests. All five runtime files
also passed a namespace-normalized comparison with the source checkout. The
installed smoke test used synthetic account state and verified attachment and
download bytes. This qualification did not modify the active global profile or
restart its services. Live-account and Linux display qualification remain open.

### 2026-10-20 Runtime Settings Qualification

The runtime interface is now version 1.1.0. On macOS ARM64 with Node 24.15.0,
Playwright 1.63.0, and installed Chrome 156.0.8078.47:

| Check | Passed | Failed | Skipped |
| --- | --- | --- | --- |
| `PROMETHEUS_TEST_BROWSER_CHANNEL=chrome npm test` | 79 | 0 | 3 Linux/Xvfb cases |
| `npm run test:controller` | 109 | 0 | 0 |
| `npm run test:controller:native` | 0 | 13 | 0 |

The native controller checks failed because their isolated OpenCode service
reported 2.1.1 while the controller requires 2.0.29. No controller compatibility
guard or installed OpenCode version was changed. These failures do not establish
a browser runtime failure or a successful native qualification.

The browser checks cover configured launch/context settings, fixed keyboard-event
delay, explicit readiness signals, HTTP 200 challenge reporting, and denial
precedence over saved-account verification. The installed-runtime test performs
real isolated dependency installation and verified transfers with synthetic state.
The display check observed the configured geometry, pixel density, language,
timezone, color scheme, and motion preference in installed headless Chrome.

The first focused run hit macOS's socket-path limit in the longer test temporary
directory. It passed with the normal macOS temporary path. The first full run
also caught a test attempting arbitrary evaluation after saved-state hydration;
the test now measures geometry before loading private state. The production
evaluation restriction remains unchanged.

This update did not change package versions, the active global browser settings,
saved accounts, workflow rules, or active services. The active installation still
requires a quiescent installer update and an OpenCode restart. No denied public
site was retried, and no Cloudflare access fix is claimed.
## Research profile selection

The runtime supports 241 source-backed or explicitly labeled synthetic/legacy
presets. Set `profile` to an ID such as `pw-pixel-7` in the shared browser settings,
or use seeded filters for reproducible sampling. Browse the catalog with
`npm run browser:profiles -- list`. See [BROWSER-PROFILES.md](BROWSER-PROFILES.md)
in the source repository for configuration, engine requirements and identity limitations.
