# Managed Browser Reference

Workflow selection and shared safeguards live in `../rules/resource-selection.md`.
Read the relevant tool procedures before using `prometheus-browser`, including in user/project-selected workflows. Apply the managed mode and login procedures only when that policy selects the default managed workflow.

The managed Playwright runtime uses configured `headless` or `virtual-display` task mode and a separate headed human-login window.

## 1. Shared Settings

The MCP server and login helper read `<config_dir>/prometheus-browser.json` (which overrides `PROMETHEUS_BROWSER_*` environment variables):

| Key | Accepted Values | Notes |
| --- | --- | --- |
| `channel` | `"default"`, `"chromium"`, `"chrome"`, `"msedge"` | Required. `default` uses headless shell in headless mode; `chrome` uses installed Google Chrome. |
| `executionMode` | `"headless"`, `"virtual-display"`, `"external-cdp"` (`"cdp"`) | Defaults to `headless`. Linux `virtual-display` requires `xvfb-run` and `xauth`. |
| `automationCompatibility` | Boolean | Chromium-only. Omits `--enable-automation`, disables `AutomationControlled`, and strips `HeadlessChrome`. |
| `humanize` | Boolean | Enables simulated typing jitter, curved mouse moves, and navigation delays. Default `false`. |
| `profile` | Profile ID or `{ seed, engine?, os?, deviceClass?, orientation?, legacy? }` | Selects a catalog emulation preset. Mutually exclusive with `identityProfile` and `external-cdp`. |
| `identityProfile` | Boolean, `"random"`, or profile ID | Legacy JavaScript-only platform/WebGL override. |
| `launchOptions` | `{ chromiumSandbox?: boolean, slowMo?: 0..1000, timeout?: 1..120000 }` | Explicit browser startup options. |
| `contextOptions` | `{ viewport, screen, deviceScaleFactor, locale, timezoneId, colorScheme, reducedMotion, userAgent }` | Viewport/screen `1..16384` px; scale `(0, 8]`. `screen` and `deviceScaleFactor` require a fixed `viewport`. |
| `cdpOptions` | `{ port?: 0..65535, endpoint?: string, userDataDir?: string, timeout?: 1..120000 }` | Loopback remote debugging options for `external-cdp`. |

Do not change settings or switch modes to retry an access denial.

## 2. Browser Profiles

`scripts/browser-profiles.mjs` provides 241 read-only presets from pinned Playwright 1.63.0 descriptors (207 upstream devices, 30 desktop OS/display variants, and 4 legacy Chrome 124 presets).

```sh
npm run browser:profiles -- list --engine chromium --os Linux --legacy false
npm run browser:profiles -- show desktop-linux-chrome-fhd
npm run browser:profiles -- sample campaign-001 --engine chromium --os Linux --device-class desktop
```

- If `profile` and `identityProfile` are omitted, the runtime keeps the native host browser identity.
- A `profile` sets user agent, viewport, screen, scale, mobile, and touch options together. Conflicting `contextOptions` fail validation.
- Firefox and WebKit presets require `channel: "default"`. Edge presets select `msedge`.
- GPU, architecture, platform, and network headers remain native under `profile`. Record the profile ID, `catalogSHA256`, and running `browserVersion` from `browser_status` or `collectBrowserProfileEvidence(page)`.

## 3. Navigation, Readiness, and Input

- `browser_navigate`: defaults to `wait_until: "load"`. Accepts `commit`, `domcontentloaded`, `load`, or `networkidle`, plus optional `ready_selector` and `timeout` (seconds). A readiness timeout leaves the page open.
- `browser_reload`: waits up to 2 seconds for active network requests to settle, then reloads.
- `browser_type`: appends text. Accepts `delay_ms` (`0..1000`, default `0`) or `humanize: true`. Inspect the field before retrying after a timeout.
- `browser_configure`: toggles session `humanize` without restarting the server.

## 4. Login Handoff and State (`opencode-browser-login.mjs`)

1. Try the task in the task browser first, reusing approved state for the target origin.
2. If login is required, name the site and obtain user approval for a headed login window.
3. Start the login worker, ask the user to log in, and end the turn. Do not poll or set a human deadline:

```sh
node "$HOME/.config/opencode/prometheus-browser/opencode-browser-login.mjs" start --config-dir "$HOME/.config/opencode" --name site --url https://example.com/ --origin https://example.com
```

4. Only after the user's reply, capture state and close the login window:

```sh
node "$HOME/.config/opencode/prometheus-browser/opencode-browser-login.mjs" complete --config-dir "$HOME/.config/opencode" --name site
```

5. Verify task access in a fresh task browser context. Do not complete the task in the login window.

- **CDP Login:** Ordinary `default`, `chromium`, and `chrome` logins on macOS and Linux use CDP when no profile, custom launch/context options, or virtual display is configured. With `cdpOptions.endpoint`, the helper opens and closes only its own tab in a dedicated automation browser.
- **Saved State:** Stored as mode-0600 JSON files under `<config_dir>/prometheus-sessions/<name>.json`, scoped to approved HTTPS origins. Capture reads cookies and `localStorage` (plus `--session-storage` when requested) from existing approved-origin tabs without calling `context.storageState()`.
- **Privacy:** State values never enter model context, logs, screenshots, or tool output. `browser_evaluate` is disabled while saved state is loaded.

## 5. File Transfers and Failure Handling

- **Uploads (`browser_upload_image`):** Pass an absolute `path` and a visible file input or chooser button `ref`/`selector`. Accepts nonempty regular PNG, JPEG, WebP, or GIF files ($\le 20\text{ MiB}$) outside `<config_dir>`. Verify page attachment state before submitting.
- **Downloads (`browser_download`, `browser_save_media`):** Confirm the output belongs to the current request. Save to a new path and verify nonzero bytes, MIME type, `signature_hex`, or `expected_sha256`. A page preview is not a delivered file, and an existing image is not success.
- **Interruptions and Denial:** Treat HTTP 401/403 and Cloudflare challenges as access denial and report a blocker. Record intent before non-idempotent actions. If an action is interrupted, mark the outcome unknown, inspect the page, and never repeat an unknown action automatically.
