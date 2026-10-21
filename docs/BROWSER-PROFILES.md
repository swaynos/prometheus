# Research browser profiles

`scripts/browser-profiles.mjs` exports 241 immutable presets:

| Source | Count | Status |
| --- | ---: | --- |
| Playwright 1.63.0 device registry | 207 | Upstream emulation presets, including landscape variants |
| Windows/macOS/Linux desktop and HD/FHD/HiDPI displays | 30 | Explicitly synthetic emulation presets |
| Original Chrome 124 identity experiments | 4 | Unverified legacy presets |

The upstream set includes Pixel, Galaxy, Fold/Flip cover displays, Android tablets,
iPhone, iPad, legacy devices, and desktop Chromium, Edge, Firefox and WebKit presets.
Landscape and cover-display entries are configurations, not additional physical devices.

## Inspect and select

These commands are read-only and do not launch browsers:

```sh
npm run browser:profiles -- list --engine chromium --os Android --legacy false
npm run browser:profiles -- show pw-pixel-7
npm run browser:profiles -- sample campaign-001 --engine chromium --device-class phone
```

Filter keys in the module API are `engine`, `os`, `deviceClass`, `orientation`, and
`legacy`. CLI equivalents are `--engine`, `--os`, `--device-class`, `--orientation`,
and `--legacy true|false`. Values are case-sensitive. Legacy classification is a
curated compatibility label, **not** an authoritative vendor support lifecycle.

`getBrowserProfile(id)` returns the exact immutable definition. Without an ID,
it samples non-legacy presets; pass `{ seed, ...filters }` as its second argument
for reproducibility. `listBrowserProfiles(filters)` lists definitions without sampling.
`browserProfileInfo(id)` returns a detached copy including provenance, limitations,
catalog version, and SHA-256. Unknown IDs, invalid filters, and empty selections fail.

## Configure managed sessions

Set `profile` in `prometheus-browser.json`, alongside the existing `channel`:

```json
{
  "channel": "default",
  "profile": "pw-pixel-7",
  "contextOptions": { "locale": "en-GB", "timezoneId": "Europe/London" }
}
```

Alternatively, use a deterministic selection in the settings file:

```json
{
  "channel": "default",
  "profile": {
    "seed": "campaign-001",
    "engine": "chromium",
    "os": "Android",
    "orientation": "portrait",
    "legacy": false
  }
}
```

Without a settings file, `PROMETHEUS_BROWSER_PROFILE=pw-pixel-7` selects an ID.
Settings-file precedence is unchanged. Seeded selectors normalize to an explicit ID.
No profile is selected by default; existing browser behavior is unchanged.

Profiles apply UA, viewport/screen, pixel density, mobile mode, and touch settings
as a unit. Conflicting `contextOptions` fail rather than silently changing the
experiment. Locale, timezone, and media preferences can be set independently.
Firefox and WebKit profiles require `channel: default` and their corresponding
installed Playwright engines. Edge profiles select installed `msedge`. Missing
engines/channels fail at launch; there is no fallback to a different browser.
Install only the required engines using Playwright's normal installation workflow.
Task and headed-login launches share engine selection. Existing virtual-display
requirements still apply. Profiles are rejected with external CDP, because an
already-running context cannot reliably accept the profile's creation settings.

## Reproducibility and evidence

`browserRuntimeInfo(config)` includes the resolved definition and catalog hash.
`createTaskContext()` additionally returns `runtime` for profile-backed sessions,
including the actual browser version. The MCP status reports this launch metadata
once a session exists. Metadata before launch describes configuration, not observations.

For approved test pages, `collectBrowserProfileEvidence(page)` collects UA,
low-entropy client hints (if available), platform, display/touch values and optional
WebGL1/WebGL2 renderer information. It does not read storage, cookies, credentials,
or page content. Compare this evidence with server-observed HTTP headers; neither
the profile nor a JavaScript observation alone proves network consistency.

Persist the resolved ID, catalog hash, actual runtime version, and observed evidence
with each research run. Seeds are stable within a catalog, not across catalog updates.
Unseeded sampling is for exploration, not reproducible experiments.

## Identity limitations and legacy compatibility

**These are emulation presets, not captured complete browser fingerprints.** The UA
does not install the browser release it names. Chromium is not Firefox or Safari;
therefore profiles select real engine families rather than just changing their UA.
WebKit emulation is not the shipping Safari browser or real iOS hardware.

GPU, architecture, navigator platform, and client hints remain native or unavailable
under `profile`. The catalog records unknown GPU/architecture/client-hint data as
`null`; it does not manufacture observations. Native HTTP hints may differ from an
emulated UA. Use actual devices/OS runtimes when complete identity fidelity matters.

The existing `identityProfile` option remains supported. Explicit new preset IDs
use their emulation settings. `true`/`random` deliberately retain the original four
legacy candidates; for reproducible broad selection use seeded `profile` instead.
For original legacy IDs, `identityProfile` retains the earlier JavaScript-only
platform/client-hint/WebGL overrides. These are **unverified experiments**, not
coherent hardware identities: HTTP hints, worker APIs, actual capabilities, and
rendered output are not guaranteed to match. `profile` and enabled `identityProfile`
are mutually exclusive. `automationCompatibility` remains Chromium-only for profiles.

## Sources and updates

- [Pinned Playwright descriptors (Apache-2.0)](https://github.com/microsoft/playwright/blob/v1.63.0/packages/isomorphic/deviceDescriptorsSource.json)
- [Playwright emulation behavior](https://playwright.dev/docs/emulation)
- [Chrome User-Agent Client Hints](https://developer.chrome.com/docs/privacy-security/user-agent-client-hints)
- [ANGLE backend/platform support](https://github.com/google/angle)
- [WebGL renderer information and availability](https://developer.mozilla.org/en-US/docs/Web/API/WEBGL_debug_renderer_info)

Descriptors come from the exact pinned local Playwright dependency, with no runtime
network fetch. The module refuses an unreviewed dependency version. When updating
Playwright, review descriptor changes, update the version guard/source revision,
bump the catalog version, and update count/hash expectations and fixtures. Synthetic
desktop variants declare their derivation. Legacy GPU strings have no verified source;
they are preserved for compatibility only. Do not add guessed GPU combinations as
observed data. Any future captured hardware dataset needs explicit provenance,
capture date/runtime, redistribution permission, and independent validation.
