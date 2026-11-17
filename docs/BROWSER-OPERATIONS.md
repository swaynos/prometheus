# Browser operations guide

## Purpose and restrictions

Use this guide to install, configure, and maintain the managed browser runtime on macOS or Linux.
The runtime operates separately from Prometheus goal execution.
See the [browser reference](RESOURCE-SELECTION.md) for settings, profiles, login, and tool procedures.

Paid CAPTCHA solving is optional and never starts from navigation.
Each paid call requires explicit user authorization, an approved origin, trusted acceptance evidence, and an initialized private durable ledger.
Automatic handling covers visible standalone Turnstile and reCAPTCHA v2 callbacks.
Other API v2 types require a configured trusted site adapter.

Reservation limits are estimates, not provider-enforced charge ceilings.
An unresolved charge blocks further submissions until trustworthy reconciliation.
Provider API requests use a separate direct service connection.
Disclosure of the pinned browser proxy to the worker requires explicit `captcha.proxyMode: "browser"` policy.
Before enabling solves, read [coverage, policy, and accounting](BROWSER-2CAPTCHA.md).

Stop on access denial and managed challenges.
Do not rotate or use direct routing to bypass denial.

## Installed layout

| Component | Location or name |
| --- | --- |
| MCP server and tools | `prometheus-browser` (`prometheus-browser_browser_*`) |
| Runtime and dependencies | `<config_dir>/prometheus-browser/` |
| Instruction rule | `<config_dir>/prometheus-browser/rules/resource-selection.md` |
| Reference documents | `<config_dir>/prometheus-browser/docs/` |
| Shared settings | `<config_dir>/prometheus-browser.json` |
| Saved authentication files, mode `0600` | `<config_dir>/prometheus-sessions/` |
| Login socket directory, mode `0700` | `<config_dir>/prometheus-logins/` |
| Proxy registry and owners, modes `0700`/`0600` | `<config_dir>/prometheus-proxy-sessions/` |
| Default proxy list, mode `0600` | `<config_dir>/proxies.txt`, normally `~/.config/opencode/proxies.txt` |
| Placeholder list example | `<config_dir>/prometheus-browser/proxies.txt.example` |
| Optional legacy credential storage, modes `0700`/`0600` | `<config_dir>/prometheus-proxy-secrets/` |
| Proxy session CLI | `npm run browser:sessions` |
| Optional CAPTCHA ledger CLI | `node <config_dir>/prometheus-browser/browser-budget.mjs` |
| Migration receipt | `<config_dir>/prometheus-browser-migration.json` |
| Runtime backups | `<config_dir>/prometheus-browser-backups/` |

## Installation and migration

### Prerequisites

- Node `>=22.22.2 <25`.
- Full Chromium for login and the headless shell for headless tasks.
- Installed Google Chrome for `channel: "chrome"`.
- Linux `xvfb` and `xauth` for `virtual-display`.

### Procedure

1. From the repository root, run `npm ci`.
2. For bundled Chromium, run `npx playwright install chromium` from the same directory.
   This installs full Chromium and the headless shell.
3. Stop active browser tasks, login helpers, and affected OpenCode services.
4. Run the installer:

   ```sh
   node scripts/browser-profile.mjs install --config-dir "$HOME/.config/opencode" --quiescent
   node scripts/browser-profile.mjs status --config-dir "$HOME/.config/opencode"
   ```

   `--quiescent` declares that active work has stopped.
   To migrate from `cuddly-winner-browser`, also supply `--migrate`.
5. Reload OpenCode if necessary.
   Reconnect the browser MCP so it uses the installed runtime.

The installer stages dependencies and verifies a blank-page launch.
The probe loads no accounts, proxy credentials, or proxy sessions.
The installer verifies that no active login helpers or proxy owners remain.
It registers `/browser` and preserves JSONC comments and unrelated configuration.

Installation includes the optional CAPTCHA scripts and documents, but does not initialize a paid-solve ledger.
Solving remains disabled without CAPTCHA configuration.
Provision credentials separately before following the ledger setup procedure.
See [CAPTCHA accounting](BROWSER-2CAPTCHA.md) and [manual shopping](BROWSER-SHOPPING-WORKFLOW.md).

### Missing bundled browsers

Playwright stores bundled browsers in a cache outside the runtime.
Cache cleanup can remove them after a successful installation.

For `default` and `chromium`, `browser_status` reports `browserInstall`.
It lists required browsers, pinned revisions, cache directories, and installation status.
This marker-based check neither launches a browser nor verifies executable integrity or system dependencies.

If a required browser is missing, task launch and login `start` stop before launch.
Login `start` also stops before creating a worker.
The error identifies the missing browser and revision, then supplies an `installCommand` for the runtime's own Playwright installation.
Run that command rather than `npx playwright install` from an unrelated directory, which can install a different revision.

This check does not inspect installed Chrome, Edge, non-Chromium profiles, or existing CDP browsers.
It does not automatically download or repair files.
Proxy session `doctor` does not verify browser installation.

## Proxy setup and session lifecycle

### Supported routes

Optional proxy support covers managed Chromium-engine browsers with HTTP proxies.
HTTPS destinations use CONNECT.
External CDP, SOCKS5, and HTTPS-to-proxy transport are unsupported.

### Create the private list

1. Privately edit `~/.config/opencode/proxies.txt`.
   For a custom configuration directory, use `<config_dir>/proxies.txt`.
2. Put one authenticated HTTP proxy on each line.
   Do not include a URL scheme:

   ```text
   HOST:PORT:USER:PASS
   HOST:PORT:USER:PASS
   ```

3. Use your actual values locally.
   Never paste credentials into chat, shell arguments, logs, or a repository.
   The checkout and installed runtime include placeholder `proxies.txt.example`.
   Do not overwrite an existing list with the example.
4. Protect the actual file:

   ```sh
   chmod 600 "$HOME/.config/opencode/proxies.txt"
   ```

The list must meet all these conditions:

- Regular file, not a symlink.
- One hardlink.
- Owned by the current user.
- File mode exactly `0600`.
- Outside all Git repositories.

The configuration root can have mode `0755`.
It must belong to the current user and prohibit writes by group and others.
Ancestors must be real directories with trusted owners and protection from untrusted writes.
Fixtures may use root-owned sticky temporary ancestors.
The runtime rejects unsafe files. It never repairs permissions automatically.
You do not need a separate secrets directory or individual JSON credential files.

### Configure the route

1. Merge this `proxy` block into `<config_dir>/prometheus-browser.json`.
   Preserve unrelated settings:

   ```json
   {
     "channel": "chrome",
     "executionMode": "headless",
     "proxy": {
       "session": "main",
       "strategy": "round-robin"
     }
   }
   ```

2. From the repository root, create the named session and inspect local configuration:

   ```sh
   export PROMETHEUS_CONFIG_DIR="$HOME/.config/opencode"
   npm run browser:sessions -- create main
   npm run browser:sessions -- doctor
   npm run browser:sessions -- show main
   ```

3. Reload or reconnect the browser MCP after settings changes.
   If the installed runtime lacks this capability, stop affected tasks and helpers.
   Then update through the staged installer.
   Checkout edits alone do not update an installation.

Without `pool`, the configuration selects `proxies.txt`; there is no `poolFile` setting.
Without `proxy`, the runtime retains direct routing and ignores the list.
An explicit empty or invalid `pool` stops validation.

For the installed runtime, replace `npm run browser:sessions --` with:

```sh
node "$PROMETHEUS_CONFIG_DIR/prometheus-browser/browser-sessions.mjs"
```

Every command also accepts `--config-dir <dir>`.
Session creation reserves an assignment even if a later launch fails.
Reuse the session for later tasks rather than creating it again.
Reopening `main` retains its proxy and generation.

### Login with the session

1. Obtain approval for the named site.
2. Start the login helper with the configured session:

   ```sh
   node "$PROMETHEUS_CONFIG_DIR/prometheus-browser/opencode-browser-login.mjs" start --config-dir "$PROMETHEUS_CONFIG_DIR" --session main --name store-login --url https://example.com/ --origin https://example.com
   ```

3. Pause automation during human control.
   Follow the [login handoff procedure](RESOURCE-SELECTION.md).
   The helper creates a private signed handoff.
   Do not print or manually share it.
4. Only after the user's reply, capture state and close the window:

   ```sh
   node "$PROMETHEUS_CONFIG_DIR/prometheus-browser/opencode-browser-login.mjs" complete --config-dir "$PROMETHEUS_CONFIG_DIR" --name store-login
   ```

5. Verify task access in a fresh task context.
   Saved state alone does not prove access.

Successful capture binds `store-login` to the session generation.
Alternatively, explicitly bind an existing approved record:

```sh
npm run browser:sessions -- bind-auth main store-login
```

### Explicit rotation

1. Close the task browser.
2. Finish or close all login helpers.
3. Only for an explicitly requested rotation, run:

   ```sh
   npm run browser:sessions -- rotate main
   npm run browser:sessions -- doctor
   ```

Never rotate in response to target HTTP 401/403 or a challenge.

Rotation consumes the **shared global cursor** and increments generation.
It can select the same proxy again after other allocations.
With one pool member, it always selects the same proxy.
Rotation does not guarantee a new endpoint or exit IP.

By default, rotation clears authentication associations even if the proxy stays the same, without deleting saved cookies.
Use `--retain-associations` only when you intend to preserve those associations, and heed the renewed-verification warning.
Browser closure, elapsed time, tabs, navigation, and process restarts do not rotate the assignment.

### Text format and pool edits

| Input | Rule |
| --- | --- |
| Encoding | Strict UTF-8. An initial BOM is optional. |
| Lines | LF or CRLF. Ignore blank lines and full-line `#` comments. |
| Host | Hostname, IPv4, or bracketed IPv6, such as `[::1]:8000:USER:PASS`. |
| Port | Decimal integer from `1` through `65535`. |
| Transport | Implicit HTTP proxy. HTTPS destinations use CONNECT. |
| Username | Nonempty. No colon. |
| Password | Nonempty. Includes the entire remainder after the username delimiter. |
| Credential characters | Preserve literal `:`, `#`, `@`, and spaces. Do not trim or URL-decode. |
| Limits | At most 1 MiB and 4096 proxies. |

The parser rejects control characters, malformed records, invalid UTF-8, empty lists, and duplicate canonical endpoint/username identities.
Different passwords do not make duplicate identities valid.

File order controls future round-robin allocations.
Opaque `file-…` IDs derive from the canonical endpoint and username, excluding passwords and line numbers.
Different usernames on one gateway have different identities.
Reordering and password replacement preserve assignments; host, port, or username changes require explicit reconciliation.

The runtime reads the list during creation, rotation, reconciliation, launch, login handoff, generation verification, and `doctor`.
It does not reconfigure an active route from file edits.
Invalid edits can block later validation or handoffs.
Before identity changes, close affected browsers and helpers.

After removing an assigned identity or cursor member, inspect `doctor` locally.
Its ordered `proxies` array lists sanitized IDs in file order.
Explicitly reconcile the session or cursor with those IDs.
Never delete the registry or switch routes silently.

### Existing JSON pools and migration

An explicit `proxy.pool` array takes priority, so the runtime does not read the default text file.
A legacy entry has this shape:

```json
{ "id": "proxy-a", "server": "http://host:8000", "credentialsFile": "prometheus-proxy-secrets/proxy-a.json" }
```

For unauthenticated proxies, `credentialsFile` is optional.
Legacy credential JSON contains `username` and `password`.
It requires mode `0600` under protected `0700` directories relative to `<config_dir>`.
Only legacy credentials require that private parent.
Credentials directly under the configuration root require that root to have mode `0700`.

To migrate an existing session:

1. Stop its browser and login helpers.
2. Populate `proxies.txt` privately.
3. Remove `pool` from settings.
4. Run `doctor`.
5. Select the matching generated ID through `reconcile-session <session> <file-id>`.
6. If necessary, reconcile the global cursor through `reconcile-cursor <file-id>`.
7. Keep old credential files until you independently establish that they are unnecessary.

Generated IDs differ from handwritten legacy IDs, even for the same endpoint.
Reconciling a changed assignment increments generation and clears authentication associations by default, while preserving saved authentication records.
Do not migrate or reset assignments silently.

### Local diagnostics and recovery

`doctor` reads and validates local configuration, credentials, registry assignments, locks, and owner records.
It makes no requests to proxies or public IP-check services and never reads saved authentication values or launches a browser.
It neither acquires locks nor prunes records, and it leaves permissions, cursor, and state unchanged.
Output contains sanitized IDs and fixed codes, not endpoints, credential paths, or secrets.

- Exit `1`: detected local errors.
- Exit `0`: no detected local errors. This does not prove connectivity or authorize rotation.
- Warnings: active locks or dead records.

Concurrent activity can invalidate the result.
`show` can prune conclusively dead owner records.
For inspection without mutation, use `doctor`.

| Code | Operator action |
| --- | --- |
| `proxy-list-missing` | Create the intended list privately. Do not use direct routing. |
| `proxy-list-unsafe`, `proxy-list-in-repository` | Verify exact mode `0600`, owner, single-link regular file, safe directories, and location outside repositories. Do not repair automatically. |
| `proxy-list-invalid-record`, `proxy-list-duplicate` | Privately inspect the reported line number. Reports omit its contents. |
| `proxy-list-empty`, `proxy-list-invalid-encoding`, `proxy-list-too-large`, `proxy-list-too-many-records` | Supply a nonempty UTF-8 list within 1 MiB and 4096 records. |
| `registry-missing`, `selected-session-missing` | Verify the directory and session. Use `create <session>` only for an intended new session. |
| `cursor-proxy-missing` | Review the pool edit. Explicitly select the next allocation through `reconcile-cursor <proxy-id>`. Existing assignments stay unchanged. |
| `proxy-missing`, `endpoint-changed` | Restore the intended configuration, or explicitly use `reconcile-session <session> <proxy-id>` while inactive. The cursor stays unchanged. |
| `credentials-invalid` | Privately verify existence, ownership, permissions, link safety, and JSON structure. Safe replacement applies at the next launch without rotation. |
| `ownership-dead`, `lock-dead` | Leave diagnostic records unchanged. Normal lifecycle operations reclaim conclusively dead records through OS identity, never age alone. |
| `lock-alive` | Wait for the active registry operation. Then request a new diagnostic if necessary. |
| `ownership-ambiguous`, `lock-ambiguous`, `registry-invalid` | Stop affected work. Investigate locally. Do not delete locks, overwrite corrupt state, or reset the registry. |

Restore a trusted private backup only after establishing ownership and inactivity.
Reconciliation of a changed proxy ID **or endpoint** increments generation and clears associations by default.
Explicit `--retain-associations` preserves them with a warning.
An unchanged assignment causes no update.
No recovery command authorizes bypass of denial, direct fallback, or replay of an interrupted action.

### Current limits

- There is no supported session deletion command.
  Do not edit the registry manually to remove entries.
- Timed rotation, per-request rotation, health failover, geographic selection, and provider APIs remain outside scope.
  SOCKS5, HTTPS-to-proxy transport, and external-CDP proxy routing also remain outside scope.
  The browser does not silently fall back to another route.

## Updates, rollback, and recovery

### Lost task context

1. Inspect `browser_status`.
   An observed closed context or disconnected browser reports `contextOpen: false` and requires explicit navigation.
2. Treat an interrupted action as unknown.
   Inspect its original page or independent application evidence if available.
   A new context cannot reconstruct the old outcome.
   Do not replay automatically.
3. If human takeover or handback inspection lost its original session, explicitly call `browser_close` first.
   Do not report successful original handback.
4. When appropriate, request fresh `browser_navigate` in the same configured mode.

Recovery reacquires the pinned proxy session on its existing generation without rotation.
An attached CDP browser must be dedicated to automation.
Its unrelated tabs and profile remain externally owned.
Never use recovery after HTTP 401/403, challenge, or proxy denial as a way to retry access.

### Update

Stop affected tasks and login helpers.
From an updated checkout, run `install --quiescent`.
Unchanged files require only a readiness check.
Changed files publish through a staged update.
The installer archives the prior runtime under `prometheus-browser-backups/`.

### Rollback or removal

Stop affected work first.
Run the required operation:

```sh
node scripts/browser-profile.mjs rollback --config-dir "$HOME/.config/opencode" --quiescent
node scripts/browser-profile.mjs remove --config-dir "$HOME/.config/opencode" --quiescent
```

### Drift or interrupted installation

If owned files or configuration fields have changed, the installer reports `drift` and blocks overwrite.
An interrupted transaction leaves `prometheus-browser-pending.json`.
Inspect `status`, then run `rollback --quiescent` for recovery.

## Verification

Run from the repository root:

```sh
node --test tests/integration/browser_profile.test.mjs
npm test
```

Set `PROMETHEUS_TEST_BROWSER_CHANNEL=chrome` to include installed Chrome in channel and installed-runtime tests.
For action outcomes, frames, records, change observation, profiles, and proxy sessions, run:

```sh
node --test tests/integration/browser_observations.test.mjs
node --test tests/integration/browser_proxy.test.mjs
node --test tests/integration/browser_proxy_list.test.mjs
node --test tests/integration/browser_sessions.test.mjs
```

Qualify installed Chrome separately on Linux and macOS.
Record browser and Playwright versions, channel, and mode.
Missing browser or display dependencies mean unverified, not passing.
Profile evidence from controlled fixtures does not establish anonymity or access to a protected site.

Proxy pinning reports `routing: "configured"`, not a verified exit IP.
Providers can rotate exits or expire sticky sessions independently.
Initial Chromium support does not contain all OS-wide DNS or WebRTC leaks.

### Linux virtual-display verification

Require a Linux host with Playwright browsers, `xvfb`, and `xauth`.
Run:

```sh
PROMETHEUS_TEST_PROXY_MODE=virtual-display xvfb-run --auto-servernum --server-args='-screen 0 1280x1024x24 -nolisten tcp' env PROMETHEUS_VIRTUAL_DISPLAY=1 node --test --test-timeout=300000 tests/integration/browser_proxy_list.test.mjs tests/integration/browser_sessions.test.mjs tests/integration/browser_proxy.test.mjs
```

Add `PROMETHEUS_TEST_BROWSER_CHANNEL=chrome` for separate installed-Chrome qualification.
Fixtures print platform, architecture, Node, Playwright, browser version, channel, and task mode.
The Xvfb login fixture uses headed mode.
It does not qualify a human-accessible desktop.
