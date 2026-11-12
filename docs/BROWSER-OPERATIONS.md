# Browser Operations Guide

The managed browser runtime supports macOS and Linux. It is separate from Prometheus goal execution.
See the [browser reference](RESOURCE-SELECTION.md) for settings, profiles, login handoff, and tool procedures.

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

The installer stages dependencies, verifies a blank-page launch without loading accounts, registers `/browser`, and preserves JSONC comments and unrelated config. Restart OpenCode after installation.

## Updates, Rollback, and Recovery

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
