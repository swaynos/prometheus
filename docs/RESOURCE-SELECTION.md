# Managed Browser Reference

Workflow selection and shared safeguards live in `../rules/resource-selection.md`.
Read the relevant tool procedures before using `prometheus-browser`, including
in user/project-selected workflows. Apply the managed mode and login procedures
only when that policy selects the default managed workflow.
The installer deploys this reference under `<config_dir>/prometheus-browser/docs/`
without adding it to OpenCode's always-loaded instructions. The compact rule is
installed under `<config_dir>/prometheus-browser/rules/`.

The managed Playwright runtime uses configured `headless` or `virtual-display`
task mode and a separate headed human-login window. These mode and login
procedures do not constrain user/project-selected workflows. Tool requirements
still apply whenever those workflows use `prometheus-browser`.

### Shared settings

The MCP and login helper read `<config_dir>/prometheus-browser.json`:

```json
{
  "channel": "default",
  "executionMode": "headless",
  "automationCompatibility": false
}
```

`channel` accepts `default`, `chromium` (full Chromium), or `chrome` (installed
Google Chrome). `executionMode` defaults to `headless`; `automationCompatibility`
defaults to false. When enabled, compatibility mode omits `--enable-automation`
and adds `--disable-blink-features=AutomationControlled` for both login and task
browsers. It adds no JavaScript webdriver override or user-agent spoofing.

The settings file takes precedence over inherited environment values. Without
it, `PROMETHEUS_BROWSER_CHANNEL`, `PROMETHEUS_BROWSER_EXECUTION_MODE`, and
`PROMETHEUS_BROWSER_AUTOMATION_COMPATIBILITY=true|false` supply these settings.
Malformed settings fail before launch. Both task modes default to a 1280x1024
viewport. Existing settings keep their behavior.

Optional `launchOptions` and `contextOptions` configure supported browser assembly
settings without changing the execution mode or package versions:

```json
{
  "channel": "chrome",
  "executionMode": "headless",
  "launchOptions": { "slowMo": 0, "timeout": 15000 },
  "contextOptions": {
    "viewport": { "width": 1440, "height": 900 },
    "screen": { "width": 1440, "height": 1000 },
    "deviceScaleFactor": 1,
    "locale": "en-GB",
    "timezoneId": "Europe/London",
    "colorScheme": "light",
    "reducedMotion": "no-preference"
  }
}
```

Use these options for the application's display and timing requirements. Do not
change them to retry an access denial. Unspecified options keep Playwright's
defaults. The task browser and the human login browser use the same configured
context options. The human login window remains headed.

| Setting | Accepted values |
| --- | --- |
| `launchOptions.chromiumSandbox` | Boolean; omitted by default. |
| `launchOptions.slowMo` | Fixed operation delay, 0–1000 milliseconds; omitted by default. |
| `launchOptions.timeout` | Browser startup timeout, 1–120000 whole milliseconds. The installer probe still has a 30-second limit. |
| `contextOptions.viewport` | Width and height, each 1–16384 whole pixels; or `null` to use the host window size. |
| `contextOptions.screen` | Width and height, each 1–16384 whole pixels. |
| `contextOptions.deviceScaleFactor` | Number greater than 0 and at most 8. |
| `contextOptions.locale` | Valid language tag. |
| `contextOptions.timezoneId` | Valid timezone name. |
| `contextOptions.colorScheme` | `light`, `dark`, `no-preference`, or `null` for system defaults. |
| `contextOptions.reducedMotion` | `reduce`, `no-preference`, or `null` for system defaults. |

`screen` and `deviceScaleFactor` require a fixed viewport. Display options emulate
page-visible geometry; they do not change the Linux Xvfb screen. Arbitrary launch
arguments, user-agent overrides, proxy credentials, and raw storage state are not
accepted in these option objects. Approved saved state still uses the private
origin-scoped restoration path.

`channel: "chrome"` uses installed Chrome. Current Chrome uses modern headless
with Playwright's `--headless` argument. `channel: "chromium"` selects full bundled
Chromium. An omitted/default channel selects the separate headless shell in
headless mode. These are different executable selections, not just window flags.

Install dependencies and the selected browser from the repository root first:

```sh
npm ci
npx playwright install chromium
```

Use installed Google Chrome instead when `channel` is `chrome`. Linux
`virtual-display` mode also requires `xvfb` and `xauth`. Then install the managed
profile outside the repository:

```sh
node scripts/browser-profile.mjs install --config-dir "$HOME/.config/opencode" --quiescent
```

Stop browser tasks, login helpers, and affected OpenCode servers before installation.
The `--quiescent` flag records your assertion. It does not detect active work.
The installer preserves the shared settings file. Restart OpenCode after changes
to runtime files, settings, or agent instructions. MCP configuration reports
`configured`; `browser_status` reports the selected execution mode, applied launch
options, browser version, virtual display, and page health. It also reports the
Playwright and Node versions, platform, architecture, configured distribution,
and context options. Status does not launch a browser. The browser version is
`null` until a browser is running. Reported launch options are the wrapper's
explicit options, not the full list of Playwright's internal Chromium arguments.

For an existing `cuddly-winner-browser` registration, add `--migrate`. See the
[operations and recovery guide](BROWSER-OPERATIONS.md) in the source checkout for
cutover, update, rollback, and qualification procedures. Installation launches a
blank task browser to check readiness. It never opens a login window or loads
saved authentication during that check.

The installer registers `/browser <request>` as a human-invoked Build prompt
command. Use it in a separate native conversation. The controller does not
install this command, and enrolled Prometheus sessions do not receive browser
tools. Project configuration can override global commands and MCP registrations.

### Virtual-display execution

On Debian-based Linux, install `xvfb` and `xauth`. The managed MCP launches itself
through `xvfb-run --auto-servernum` on an isolated 1280x1024x24 screen with TCP
disabled, then starts headed Chrome/Chromium. Each service owns its display.
EOF and termination close the browser and display. Missing dependencies fail
without using the physical desktop or switching modes.

Xvfb and compatibility settings do not guarantee site access. Never switch modes
or retry a denied request automatically. Human login still opens on the person's
physical desktop, not inside the task display.

## Page Readiness And Input Timing

`browser_navigate` keeps `wait_until: "load"` as its default. Agents can choose
`commit`, `domcontentloaded`, `load`, or `networkidle`. A page with continuous
network activity may never reach `networkidle`.

Use `ready_selector` when the application has a visible readiness signal. The
optional `timeout` is in seconds. The navigation and selector wait share that
budget, capped by the existing transport-safe wait limit. No fixed post-navigation
sleep is added. A readiness timeout leaves the page open for inspection.

```json
{
  "url": "https://example.com/",
  "wait_until": "domcontentloaded",
  "ready_selector": "#application-ready",
  "timeout": 10
}
```

`browser_type` accepts optional `delay_ms` from 0 to 1000 milliseconds. The delay
is fixed, not random. Its default remains 0. Use it when the application requires
spaced keyboard events. The existing action timeout still applies. After an
interrupted typing action, inspect the field before adding more text.

`browser_fill` is unchanged. No automatic mouse-path simulation, user-agent
spoofing, or new navigator/WebGL override is installed.

## Browser Actions And Login

1. Try the requested action in the task browser, reusing approved state for the
   target origin first. A sign-in link alone does not prove login is required.
2. If login is required, name the site and obtain approval for headed Playwright.
3. Start the visible window, ask the user to log in, leave it open, and reply.
   End the turn. Do not poll, guess a completion selector, or impose a countdown.
4. After the reply, complete capture and close the login window.
5. Load the saved state in a fresh task context, verify account or requested task
   access, and continue there. Do not complete the task in the login window.

Use the same configuration root and state name for the handoff. Substitute the
selected config directory for `$HOME/.config/opencode` if it differs:

```sh
node "$HOME/.config/opencode/prometheus-browser/opencode-browser-login.mjs" start --config-dir "$HOME/.config/opencode" --name site --url https://example.com/ --origin https://example.com
# End the turn; capture only after the user's reply:
node "$HOME/.config/opencode/prometheus-browser/opencode-browser-login.mjs" complete --config-dir "$HOME/.config/opencode" --name site
```

`start` returns `awaiting-user`; its detached worker survives between turns.
`cancel` closes without saving. `pending` is a metadata-only recovery check, not
a polling loop. A second `start` refuses to replace a live worker. Startup and
state reads have bounded operation timeouts; the person has no login deadline.
A closed window cannot be captured or overwrite an existing record.

Report a blocker if the required login has no graphical session, the browser
cannot start, or saved state cannot be reused. Neither capture nor a redirect
proves authentication. A challenge or access denial does not justify new login.

## Login State

Saved state belongs outside repositories, with mode-0600 files under
`<config_dir>/prometheus-sessions/`. Each record is scoped to approved HTTPS
origins and a site/account name. Never use a personal everyday browser profile.
Use ephemeral contexts by default; persistent login state is opt-in saved state,
not a continuously running browser profile. Removal affects only the named record.

Capture reads cookies and local storage from existing approved-origin tabs,
including popups. It never calls `context.storageState()` in the visible login
context or opens synthetic tabs. IndexedDB and closed-tab storage are not
captured. Use `--session-storage` only when the site requires it. Restoration
runs before page scripts and only on the stored origins. Missing or foreign-origin
records are skipped; records without verification metadata cannot authenticate.

New captures store `verification: {"method":"user-confirmed"}`. This authorizes
restoration and inspection, not an authenticated verdict. The agent checks the
actual account UI or task access. Selector-based records require their account
selector before the runtime labels them authenticated. A composer alone is not
proof of login. State values never enter model context, logs, screenshots, or
tool output. The installed helpers manage private worker and socket records.

## Image Uploads

Use `browser_upload_image` with the user-requested absolute `path` and an observed
visible `ref` or `selector`. The target can be a visible file input or a control
that opens a file chooser. Open an attachment menu first if needed; the upload
tool clicks its chooser control. Never target a hidden fallback input directly.

The tool accepts nonempty regular PNG, JPEG, WebP, or GIF files, checks their byte
signatures, and rejects symlink leaves and paths inside the private config root.
The default size limit is 20 MiB (`PROMETHEUS_BROWSER_MAX_UPLOAD_BYTES`). It
returns basename, MIME type, byte count, and SHA-256 after verifying selection.

Record intent before attaching: selection may start a server upload. Inspect
the attachment preview, filename, and site errors before submitting the prompt.
Selection alone is not server acceptance. If the input resets or the operation
times out, inspect the page before retrying. Upload never submits a prompt.

## Downloads And Generated Files

A page result and a local delivery are separate outcomes:

1. Confirm the output belongs to the current request, not an older page item.
2. Use `browser_download` with a visible control's `ref` or `selector`, or its
   `url` option for retrieval through the same authenticated task context.
3. Save without replacing an unrelated file.
4. Validate nonzero size, file type, and required signature, hash, or content.
5. Report success only after page association and local-byte checks pass.

Supply `expected_content_type`, `signature_hex`, and `expected_sha256` when known.
The download action preserves original bytes. When no download control exists,
`browser_save_media` saves visible image/canvas pixels as PNG without exposing
the source URL. It can reject a prior source fingerprint as stale. Neither action
overwrites an existing destination; a page preview is not a delivered file.

For generation, confirm the final prompt before submission, preserve the
conversation address, and associate the new output with that submission.
An existing image is not success.

## Failure Handling And Interrupted Actions

Use short bounded waits that leave the browser usable. Explicit navigation may
recreate a closed page. Treat HTTP 401/403 and Cloudflare challenges as access
denial: report the blocker rather than automatically navigating, recapturing
login, restarting, or changing browser settings to bypass it.
Navigation reports denial before checking saved-account evidence or an optional
readiness selector. Recognized challenge pages can be reported even with HTTP
200. An ordinary page that mentions Cloudflare is not sufficient challenge
evidence. These reports do not add a new workflow-switch or tool-use gate.

Record intent before sending, publishing, purchasing, or starting generation.
After an interruption, mark the outcome unknown and inspect the original page
before considering a retry. Never repeat an unknown action automatically.
Record only the stage, safe page address, mode, and possible action outcome,
not credentials or page secrets. Stop if output association or local validation
cannot establish success.
