# Browser profiles

A profile is a set of browser emulation settings. It is not a verified hardware identity.
Browser execution supports macOS and Linux, not Windows.

## Available profiles

`scripts/browser-profiles.mjs` supplies these read-only presets:

| Source | Count | Type |
| --- | ---: | --- |
| Playwright device registry | 207 | Device and desktop emulation |
| Desktop OS and display variants | 30 | Synthetic emulation |
| Chrome 124 identity presets | 4 | Unverified legacy settings |

Landscape entries are settings for a device, not separate physical devices.
The `legacy` label is a catalog classification, not a vendor support statement.

Inspect profiles without starting a browser:

```sh
npm run browser:profiles -- list --engine chromium --os Linux --legacy false
npm run browser:profiles -- show desktop-linux-chrome-fhd
npm run browser:profiles -- sample campaign-001 --engine chromium --os Linux --device-class desktop
```

Filters are `--engine`, `--os`, `--device-class`, `--orientation`, and `--legacy true|false`.
Values are case-sensitive. Unknown IDs, invalid filters, and empty selections cause an error.

## Configure a profile

Set `profile` in `prometheus-browser.json`. Use an ID for an exact choice:

```json
{
  "channel": "default",
  "profile": "desktop-linux-chrome-fhd"
}
```

Use a seed and filters to select from several profiles.
A seed is text that makes the selection repeatable:

```json
{
  "channel": "default",
  "profile": {
    "seed": "campaign-001",
    "engine": "chromium",
    "os": "Linux",
    "deviceClass": "desktop",
    "legacy": false
  }
}
```

The same seed and catalog select the same ID. Another seed can select another ID.
A catalog update can change the selection. Record the selected ID and catalog hash.
Without a settings file, `PROMETHEUS_BROWSER_PROFILE` can select an ID.
The settings file takes precedence over environment settings.

A profile sets the user agent, viewport, screen size, pixel density, mobile mode, and touch settings together.
Conflicting `contextOptions` cause an error. You can set locale, timezone, and media preferences separately.
The profile's browser version describes its source. It does not install or pin that browser release.

Firefox and WebKit profiles require `channel: "default"` and the corresponding installed Playwright engine.
Edge profiles select installed `msedge`.
A missing browser causes launch failure. The runtime does not select another browser automatically.
For profiles, `automationCompatibility` is supported only with Chromium.

## Default login and explicit variation

If `profile` is omitted, the runtime does not automatically select a preset from the full catalog.
Managed task contexts can select a random legacy identity when no profile option or display override is set.

Ordinary login uses CDP on macOS and Linux for `default`, `chromium`, and `chrome`.
This applies when no enabled profile, context options, launch options, or virtual-display mode is selected.
The channel stays unchanged. No preset or fixed browser version is added.
The helper starts a headed browser with its native user agent unless an override is configured.
See the [CDP login procedure](RESOURCE-SELECTION.md#cdp-login-handoff) for startup, attachment, and cleanup.

An explicit profile selects a managed context for emulation instead of default CDP login.
Profiles cannot be combined with `external-cdp`. An existing context cannot reliably accept their creation-time settings.
Task and login launches use the same profile engine selection. Virtual-display requirements still apply.

## Identity limits

Under `profile`, GPU details, architecture, navigator platform, and client hints remain native or unavailable.
Unknown catalog values are `null`. Native HTTP hints can differ from the profile's user agent.
WebKit emulation is not the shipping Safari browser or physical iOS hardware.
Use the actual device and operating system when full identity accuracy is required.

`identityProfile` also accepts explicit profile IDs. `true` or `"random"` selects from the four legacy identity presets.
Legacy identities add JavaScript-only platform, client-hint, and WebGL overrides.
Those overrides do not guarantee matching network headers, worker APIs, hardware capabilities, or rendered output.
Use seeded `profile` selection for repeatable emulation.
Do not combine `profile` with an enabled `identityProfile`.

## Record evidence

For each run, retain the selected ID, catalog hash, actual browser version, and observations.
`browserRuntimeInfo(config)` reports the selected profile and catalog hash.
For profile sessions, `createTaskContext()` also returns runtime metadata with the actual browser version.
MCP status reports that metadata after launch. Before launch, metadata describes configuration only.

On approved test pages, use `collectBrowserProfileEvidence(page)` to collect observations.
It reads the user agent, available client hints, platform, display, touch, and WebGL renderer data.
It does not read cookies, storage, credentials, or page content.
Compare these observations with server-observed HTTP headers. JavaScript values alone do not prove network consistency.

## Module API

| Function | Result |
| --- | --- |
| `listBrowserProfiles(filters)` | Matching definitions without selection. |
| `getBrowserProfile(id)` | One read-only definition. Without an ID, selects a non-legacy preset. |
| `getBrowserProfile(undefined, { seed, ...filters })` | A repeatable selection within the catalog. |
| `browserProfileInfo(id)` | A separate copy with source details, limits, catalog version, and hash. |

API filter names are `engine`, `os`, `deviceClass`, `orientation`, and `legacy`.
Unseeded selection is not repeatable.

## Catalog maintenance

Profiles use the pinned local Playwright descriptors. The runtime does not fetch them from the network.
The module rejects an unreviewed Playwright version.
When updating Playwright, review descriptor changes, update the guard and source revision, and increase the catalog version.
Update count, hash, and test expectations together.

Synthetic profiles must state how they were derived. Legacy GPU strings have no verified source.
Do not label guessed hardware combinations as observations.
A captured hardware dataset needs a source, capture date, runtime identity, redistribution permission, and independent validation.

Sources: [pinned descriptors](https://github.com/microsoft/playwright/blob/v1.63.0/packages/isomorphic/deviceDescriptorsSource.json), licensed under Apache-2.0; [Playwright emulation](https://playwright.dev/docs/emulation).
