# Browser Operations Guide

The managed browser runtime supports macOS and Linux. It is separate from Prometheus goal execution.
See the [browser reference](RESOURCE-SELECTION.md) for settings, profiles, login handoff, and tool procedures.

Paid standalone Turnstile solving is opt-in, never triggered by navigation, and requires explicit user authorization for each call, an approved origin, trusted acceptance evidence, and an initialized private durable ledger. Reservation limits are estimates, not a provider-enforced maximum charge; any unresolved charge blocks further submissions until trustworthy reconciliation. Provider requests use a separate direct service channel, not the browser proxy. See [2captcha policy and accounting](BROWSER-2CAPTCHA.md) before enabling it. Access denial and managed challenges remain stop conditions; do not rotate or fall back to direct browsing.

## Installed Layout

| Surface | Location or Name |
| --- | --- |
| MCP server & tools | `prometheus-browser` (`prometheus-browser_browser_*`) |
| Runtime & dependencies | `<config_dir>/prometheus-browser/` |
| Instruction rule | `<config_dir>/prometheus-browser/rules/resource-selection.md` |
| Reference docs | `<config_dir>/prometheus-browser/docs/` |
| Shared settings | `<config_dir>/prometheus-browser.json` |
| Saved sessions (0600) | `<config_dir>/prometheus-sessions/` |
| Login sockets (0700) | `<config_dir>/prometheus-logins/` |
| Proxy session registry & owners (0700/0600) | `<config_dir>/prometheus-proxy-sessions/` |
| Proxy credential files (0700/0600) | `<config_dir>/prometheus-proxy-secrets/` (recommended) |
| Proxy session CLI | `npm run browser:sessions` |
| Optional CAPTCHA ledger CLI | `node <config_dir>/prometheus-browser/browser-budget.mjs` (see [accounting](BROWSER-2CAPTCHA.md)) |
| Migration receipt & backups | `<config_dir>/prometheus-browser-migration.json`, `<config_dir>/prometheus-browser-backups/` |

## Installation and Migration

1. Use Node `>=22.22.2 <25`. Run `npm ci` from the repository root.
2. Install the browser (`npx playwright install chromium` or Google Chrome). Install `xvfb` and `xauth` on Linux for `virtual-display`.
3. Stop active browser tasks, login helpers, and affected OpenCode services.
4. Run the installer (`--quiescent` asserts that active work is stopped; add `--migrate` to cut over from `cuddly-winner-browser`):

```sh
node scripts/browser-profile.mjs install --config-dir "$HOME/.config/opencode" --quiescent
node scripts/browser-profile.mjs status --config-dir "$HOME/.config/opencode"
```

The installer stages dependencies, verifies a blank-page launch without loading accounts or proxy credentials/sessions, checks that no active login helpers or proxy session owners remain, registers `/browser`, and preserves JSONC comments and unrelated config. Restart OpenCode after installation.

CAPTCHA solving is optional and disabled when its configuration is omitted; installing the runtime does not initialize a paid-solve ledger. See [2captcha accounting](BROWSER-2CAPTCHA.md) and the [manual shopping workflow](BROWSER-SHOPPING-WORKFLOW.md). The installed runtime includes their scripts and documentation; provision optional CAPTCHA credentials separately. Local installer fixtures use disposable roots and do not qualify a real headed desktop or Linux/Xvfb.

## Proxy Setup and Session Lifecycle

Proxy support is optional and initially covers managed Chromium-engine browsers with HTTP proxies, including HTTPS destinations through CONNECT. It does not support external CDP, SOCKS5, or HTTPS-to-proxy transport.

1. Merge a `proxy` block into your existing `<config_dir>/prometheus-browser.json`. Preserve unrelated settings. This example uses placeholder endpoints, not working proxies:

```json
{
  "channel": "chrome",
  "executionMode": "headless",
  "proxy": {
    "session": "shopping",
    "strategy": "round-robin",
    "pool": [
      { "id": "proxy-a", "server": "http://proxy-a.example:8000", "credentialsFile": "prometheus-proxy-secrets/proxy-a.json" },
      { "id": "proxy-b", "server": "http://proxy-b.example:8000" }
    ]
  }
}
```

2. For authenticated proxies, create an owner-only `0700` credentials directory outside the repository. Use a private editor to write a `0600` JSON file containing `username` and `password`; do not put values in shell command arguments, chat, logs, or committed settings. Credential paths are relative to `<config_dir>`; symlinks and hard links are rejected. The configuration root must be owned by you and not writable by others. A credential file directly in that root requires the root itself to be `0700`. Omit `credentialsFile` for unauthenticated proxies.
3. From the repository root, create the named routing session and check local configuration:

```sh
export PROMETHEUS_CONFIG_DIR="$HOME/.config/opencode"
npm run browser:sessions -- create shopping
npm run browser:sessions -- doctor
npm run browser:sessions -- show shopping
```

For the installed runtime, replace `npm run browser:sessions --` with `node "$PROMETHEUS_CONFIG_DIR/prometheus-browser/browser-sessions.mjs"`. Every command also accepts `--config-dir <dir>`. Creating a session reserves its assignment even if a later browser launch fails; do not recreate it on each task.

4. Restart the MCP service after changing settings. Browsing and reopening `shopping` reuse its proxy and generation. When login is required, get approval for the named site, pause automation during human control, and follow the login handoff procedure in the [browser reference](RESOURCE-SELECTION.md). Include the configured session:

```sh
node "$PROMETHEUS_CONFIG_DIR/prometheus-browser/opencode-browser-login.mjs" start --config-dir "$PROMETHEUS_CONFIG_DIR" --session shopping --name store-login --url https://example.com/ --origin https://example.com
```

The helper creates a private signed handoff internally; do not print or manually share it. Only after the user's reply, capture state and close the window:

```sh
node "$PROMETHEUS_CONFIG_DIR/prometheus-browser/opencode-browser-login.mjs" complete --config-dir "$PROMETHEUS_CONFIG_DIR" --name store-login
```

Successful capture binds `store-login` to the session generation. Alternatively, explicitly bind an existing approved authentication record with `npm run browser:sessions -- bind-auth shopping store-login`. Verify task access in a fresh task context; saved state alone is not proof of access.

5. To rotate, first close the task browser and finish or close all login helpers. Rotation is an explicit operator action, never a response to target 401/403 or a challenge:

```sh
npm run browser:sessions -- rotate shopping
npm run browser:sessions -- doctor
```

Rotation consumes the **shared global cursor** and increments generation. It may select the same proxy again after other sessions consume the pool, and always does so with a single-member pool. It does not guarantee a new endpoint or exit IP. Authentication associations are cleared even when the same proxy is selected; saved cookies are not deleted. Use `--retain-associations` only intentionally and heed the verification warning. Closing the browser, elapsed time, tabs, navigation, and process restarts do not rotate.

### Local Diagnostics and Recovery

`doctor` reads and validates local configuration, credential files, registry assignments, locks, and ownership records. It does not contact proxies or external IP-check services, read saved authentication values, launch a browser, acquire a lock, prune dead records, or change permissions/cursor/state. Output contains sanitized IDs and fixed codes, not endpoints, credential paths, or secrets. Exit `1` means detected errors; exit `0` means no detected local errors, not working connectivity or permission to rotate. Warnings describe active locks or dead records. Results can change during concurrent activity. `show` can prune conclusively dead ownership records; use `doctor` when inspection must not mutate files.

| Diagnostic code | Operator action |
| --- | --- |
| `registry-missing`, `selected-session-missing` | Check the selected configuration directory/session. Run `create <session>` only if intentionally creating a new session. |
| `cursor-proxy-missing` | Review the pool edit, then explicitly choose the next allocation with `reconcile-cursor <proxy-id>`. Existing assignments do not change. |
| `proxy-missing`, `endpoint-changed` | Restore the intended configuration, or use `reconcile-session <session> <proxy-id>` while inactive to accept an explicit assignment. This does not advance the pool cursor. |
| `credentials-invalid` | Privately inspect the configured file's existence, ownership, permissions, link safety, and JSON shape. Replace credentials safely; the next launch uses them without rotation. |
| `ownership-dead`, `lock-dead` | Doctor leaves records untouched. Normal lifecycle operations can reclaim conclusively dead records using OS process identity, never age alone. |
| `lock-alive` | Another registry operation is active. Wait for that operation to finish, then request a fresh diagnostic if needed. |
| `ownership-ambiguous`, `lock-ambiguous`, `registry-invalid` | Stop affected work and investigate locally. Do not delete locks, overwrite corrupt state, or reset the registry to force progress. Restore from a trusted private backup only after ownership and inactivity are established. |

Reconciliation that changes a proxy ID **or endpoint** increments generation and clears auth associations by default. Explicit `--retain-associations` retains them with a warning. Reconciliation of an unchanged assignment does nothing. No recovery command authorizes routing around a target denial, direct fallback, or replay of an interrupted action.

### Qualification and Deferred Work

Local qualification on 2026-11-13 used macOS arm64, Node `24.22.1`, and Playwright `1.63.0`:

| Host / channel / task mode | Browser version | Evidence |
| --- | --- | --- |
| macOS / default Chromium / headless | `153.0.8010.12` | Full browser suite and local proxy/session fixtures passed. |
| macOS / installed Chrome / headless | `157.0.8103.51` | Full browser suite and local proxy/session fixtures passed. |
| Linux / default Chromium and Chrome / headless and virtual-display | Not yet measured | Workflow added; execution and review still required. |

Linux/Xvfb-only tests were skipped on macOS, not counted as passing qualification. Controller regressions also passed. These results do not qualify live-provider routing or interactive human login.

- Linux CI is defined in `.github/workflows/browser-proxy.yml` for Playwright Chromium and installed Chrome in headless and Xvfb modes. Linux remains **unverified until those runs complete successfully and are reviewed**; creating the workflow is not a passing result.
- CI uses controlled local proxy/destination fixtures and synthetic login capture. Real-provider connectivity, provider sticky-session behavior, and human-operated graphical login require separately approved host/provider testing. No live-provider or public exit-IP check runs automatically.
- Session deletion remains deferred. There is no supported deletion command; do not edit the registry manually to remove old entries. A future deletion API needs inactive-owner checks and explicit handling of pending handoffs while preserving saved authentication records.
- Specific proxy selection is already supported by `reconcile-session <session> <proxy-id>`; a second selection API is unnecessary.
- Timed/per-request rotation, automatic health-based failover, geographic/provider APIs, SOCKS5, HTTPS-to-proxy transport, and external-CDP proxying remain out of scope. They need separate routing and authentication designs and qualification, not silent fallback.

## Updates, Rollback, and Recovery

- **Lost task context:** Check `browser_status`; an observed closed context or disconnected browser reports `contextOpen: false` and requests explicit navigation. Treat an interrupted action as unknown and inspect its original page or independent application evidence if available; a new context cannot reconstruct that outcome. Do not replay it automatically. When appropriate, request a fresh `browser_navigate` in the same configured mode. A pinned proxy session is reacquired on its existing generation, not rotated. If a human takeover or handback inspection lost its original session, first explicitly `browser_close`; do not claim the original handback succeeded. An attached CDP browser must be dedicated to automation, and its unrelated tabs and profile remain externally owned. Never use recovery as a response to 401/403, a challenge, or proxy denial.
- **Update:** Run `install --quiescent` from an updated checkout. Unchanged files no-op after a readiness check; changed files publish a staged update and archive the prior runtime under `prometheus-browser-backups/`.
- **Rollback or Remove:** Stop affected work and run:

```sh
node scripts/browser-profile.mjs rollback --config-dir "$HOME/.config/opencode" --quiescent
node scripts/browser-profile.mjs remove --config-dir "$HOME/.config/opencode" --quiescent
```

- **Drift and Interrupted Runs:** Modified owned files or config fields report `drift` and block overwrite. An interrupted transaction leaves `prometheus-browser-pending.json`; inspect `status` and run `rollback --quiescent` to recover.

## Verification

```sh
node --test tests/integration/browser_profile.test.mjs
npm test
```

Set `PROMETHEUS_TEST_BROWSER_CHANNEL=chrome` to include installed Chrome in channel and installed-runtime tests.

For action outcomes, frames, records, change observation, and profile evidence run:

```sh
node --test tests/integration/browser_observations.test.mjs
node --test tests/integration/browser_proxy.test.mjs
node --test tests/integration/browser_sessions.test.mjs
```

Qualify installed Chrome separately on Linux and macOS. Record the browser and Playwright versions and the selected channel and mode. A missing browser or display dependency is an unverified configuration, not a passing result. Profile evidence is for controlled fixtures; it is not a claim of anonymity or access to a protected site. Similarly, proxy session pinning records the configured pool assignment (`routing: "configured"`), not proof of external exit IP: upstream proxy providers may rotate exit IPs or expire sticky sessions independently, and initial Chromium-engine proxy support does not provide OS-wide DNS or WebRTC leak containment.

On a Linux host with Playwright browsers, `xvfb`, and `xauth` installed, reproduce virtual-display proxy qualification with:

```sh
PROMETHEUS_TEST_PROXY_MODE=virtual-display xvfb-run --auto-servernum --server-args='-screen 0 1280x1024x24 -nolisten tcp' env PROMETHEUS_VIRTUAL_DISPLAY=1 node --test --test-timeout=300000 tests/integration/browser_sessions.test.mjs tests/integration/browser_proxy.test.mjs
```

Add `PROMETHEUS_TEST_BROWSER_CHANNEL=chrome` to qualify installed Chrome separately. Proxy fixtures print the tested platform, architecture, Node, Playwright, browser version, channel, and task mode. The Xvfb login fixture is headed for this run, but does not qualify a human-accessible desktop.
