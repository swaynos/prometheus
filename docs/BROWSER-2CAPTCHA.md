# 2captcha integration

`scripts/opencode-browser-2captcha.mjs` implements **64 canonical task types plus two documented aliases** from 2captcha's API v2 catalog, reviewed 2026-11-15. This includes reCAPTCHA v2/v3 and Enterprise, Turnstile, image/audio recognition, and structured/cookie answers. The executable catalog is `CAPTCHA_TYPES` in `opencode-browser-captcha-types.mjs`; unknown task names and fields fail closed rather than becoming unchecked API passthrough. This is a versioned catalog, not a promise of automatic support for future provider additions or legacy API v1 methods. The docs inconsistently mention `GridTaskProxyless` and `IncapsulaTask`; these aliases normalize to their concrete request-example names, `GridTask` and `ImpervaTask`.

**Provider support is not universal browser autodetection.** The browser automatically recognizes a single visible standalone Turnstile or reCAPTCHA v2/Enterprise widget with a simple own-global `data-callback`. Other variants require an explicitly configured trusted site adapter, described below. Managed/full-page access denials, including Google's unusual-traffic pages, remain stop conditions, regardless of provider support.

Solving is disabled unless the `captcha` setting includes a complete policy and the operator explicitly initializes its ledger; every solve also requires explicit paid authorization and limits. `browser_challenge_inspect` is read-only and reports candidates, not guaranteed solvability or ledger availability. Navigation never initiates solving. A provider solution is not proof of site acceptance.

## Proxy routing and disclosure

Browser proxy credentials belong in `<config_dir>/proxies.txt` (`HOST:PORT:USER:PASS` per line, `0600`), not the API-key file. See [proxy setup](BROWSER-OPERATIONS.md#proxy-setup-and-session-lifecycle).

The Node connection to `api.2captcha.com` is a **separate direct service channel**. The worker's route is configured independently:

- `captcha.proxyMode: "browser"` explicitly permits sending the browser's pinned upstream proxy endpoint and credentials to 2captcha for supported network tasks. Proxyless task names with a documented proxy counterpart are converted to that counterpart. The loopback relay is never sent. Ownership and generation are rechecked before using the pinned capability; pages cannot supply or replace its proxy.
- `captcha.proxyMode: "proxyless"` explicitly allows the worker to use its own IP while the browser remains on its pinned proxy. IP binding can make the result unusable.
- With a proxied browser and no `proxyMode`, network solves fail before dispatch with `proxy_disclosure_required`. Merely configuring `proxies.txt` never authorizes third-party credential disclosure.
- reCAPTCHA v3 (including Enterprise via `isEnterprise`) is **proxyless-only** in the documented API. `"browser"` routing fails with `proxy_not_supported`, without fallback.
- Proxy-required types need `"browser"` and an owned browser proxy. Image, text, audio and other recognition-only tasks do not navigate on the worker and need no proxy disclosure.

The browser currently supports HTTP upstream proxies only; this integration does not add SOCKS support to browser routing. The low-level provider validator accepts the documented `http`, `socks4`, and `socks5` task fields for independent internal callers.

## Coverage matrix

All rows have synthetic request/response validation and controlled Chromium site-adapter tests. **None is live paid-solve qualified by these tests.** A controlled callback accepting fixture data is not evidence of acceptance by the real CAPTCHA vendor.

| Family | API v2 task names | Worker proxy | Browser application |
| --- | --- | --- | --- |
| reCAPTCHA v2 | `RecaptchaV2Task[Proxyless]` | Either | Automatic visible standalone callback or site adapter |
| reCAPTCHA v2 Enterprise | `RecaptchaV2EnterpriseTask[Proxyless]` | Either | Automatic visible standalone callback or site adapter |
| reCAPTCHA v3 / Enterprise | `RecaptchaV3TaskProxyless` (`isEnterprise`) | Proxyless only | Site adapter (action/score supplied explicitly) |
| Turnstile | `TurnstileTask[Proxyless]` | Either | Automatic visible standalone callback or site adapter |
| Arkose/FunCaptcha | `FunCaptchaTask[Proxyless]` | Either | Site adapter |
| GeeTest v3/v4 | `GeeTestTask[Proxyless]` (`version: 4`, `initParameters`) | Either | Site adapter; fresh v3 challenge required |
| Capy | `CapyTask[Proxyless]` | Either | Site adapter |
| KeyCAPTCHA | `KeyCaptchaTask[Proxyless]` | Either | Site adapter |
| Lemin | `LeminTask[Proxyless]` | Either | Site adapter |
| Amazon AWS WAF | `AmazonTask[Proxyless]` | Either | Site adapter on an eligible standalone document only |
| CyberSiARA | `AntiCyberSiAraTask[Proxyless]` | Either | Site adapter |
| MTCaptcha | `MtCaptchaTask[Proxyless]` | Either | Site adapter |
| Cutcaptcha | `CutCaptchaTask[Proxyless]` | Either | Site adapter |
| Friendly Captcha v1/v2 | `FriendlyCaptchaTask[Proxyless]` | Either | Site adapter |
| atbCAPTCHA | `AtbCaptchaTask[Proxyless]` | Either | Site adapter |
| Tencent | `TencentTask[Proxyless]` | Either | Site adapter |
| Prosopo | `ProsopoTask[Proxyless]` | Either | Site adapter |
| Altcha | `AltchaTask[Proxyless]` | Either | Site adapter |
| Yidun | `YidunTask[Proxyless]` | Either | Site adapter |
| Binance | `BinanceTask[Proxyless]` | Either | Site adapter |
| Basilisk | `BasiliskTask[Proxyless]` | Either | Site adapter |
| Alibaba | `AlibabaTask[Proxyless]` | Either | Site adapter |
| Yandex SmartCaptcha | `YandexSmartCaptchaTask[Proxyless]` | Either | Site adapter |
| DataDome | `DataDomeSliderTask` | Required | Site adapter; managed denial still stops |
| CaptchaFox | `CaptchaFoxTask` | Required | Site adapter |
| VK | `VKCaptchaTask` | Required | Site adapter |
| Hunt | `HuntTask` | Required | Site adapter |
| TSPD / Imperva | `TspdTask`, `ImpervaTask` | Required | Site adapter; managed denial still stops |
| Image/text/audio | `ImageToTextTask`, `TextCaptchaTask`, `AudioTask` | Not applicable | Site adapter |
| Rotation/click/grid | `RotateTask`, `CoordinatesTask`, `GridTask` | Not applicable | Site adapter; reCAPTCHA/FunCaptcha grids use `imgType` |
| Drawing/boxes/drag | `DrawAroundTask`, `BoundingBoxTask`, `DragAndDropTask` | Not applicable | Site adapter |
| Image variants | `TemuImageTask`, `VKCaptchaImageTask`, `SmartCaptchaTask`, `PazlCaptchaTask` | Not applicable | Site adapter |

`[Proxyless]` means both the base and suffixed names exist. Solutions are validated by family: tokens, text, numeric rotations, points, grid selections, polygons, boxes, GeeTest fields, or cookie/domain structures—not assumed to contain `solution.token`. Documented example aliases `websiteUrl` and `UserCertifyId` normalize to `websiteURL` and `userCertifyId`; ambiguous duplicate spellings reject. Network URLs remain HTTPS-only without credentials/fragments. Inputs and responses are bounded to 16 MiB total, individual media fields to 10 MiB encoded and instruction images to 100 KiB decoded.

## Credentials

For a checkout, create a project-root `.env` with mode `0600` and add `TWOCAPTCHA_API_KEY=your-key` (see `.env.example`); it is Git-ignored. Never commit or share it. Start the browser runtime with the project root as its working directory. The default is exactly `.env` in the process working directory, with no ancestor search. For an installed runtime or another working directory, set an absolute `envFile` in the `captcha` configuration to the intended `.env` path. The file must be an owner-only, single-link regular file owned by the current user, not a symlink; its directories must not be writable by untrusted users. Other variables in the file are not imported. Single-line quoted and unquoted values and comments are supported; malformed lines or duplicate key assignments fail closed. The adapter never calls the provider on import or validation.

Internal callers opt in with `{enabled: true, provider: '2captcha', timeoutMs, pollIntervalMs}`; there is no endpoint override. Precedence is `TWOCAPTCHA_API_KEY` in the process environment (even if blank, which fails), then an explicitly configured legacy `keyFile`, otherwise `envFile` or the working-directory `.env`. `envFile` and `keyFile` cannot both be configured. Legacy `keyFile` must be an absolute path outside any Git repository, a non-symlink, single-link regular file owned by the current user and inaccessible to group or others. Its immediate parent must also be a non-symlink directory owned by the current user and inaccessible to group or others; protect all ancestor directories from untrusted changes.

Repository detection is conservative: even a non-repository directory containing both `HEAD` and `objects` can be rejected as repository-shaped. Use a dedicated private directory without those entries rather than weakening the check.

Each `createCaptchaTask(config, task, {proxy?, languagePool?})` object deep-snapshots and validates its task and permits one `solve` attempt. `onReady(solution, signal)` receives a private, immutable, typed solution; the public result contains only status/outcome. `createTurnstileTask` remains a compatible token-string wrapper. Optional `languagePool` (`en` or `rn`) is a top-level provider request field for recognition tasks, not a task field.

Authorization and reservation hooks must both explicitly return `true` before a request is sent. The MCP owner supplies a durable reservation hook; arbitrary internal callers supplying permissive hooks do not acquire that protection. An ambiguous create response is `unknown`, never automatically retried. Polling failure after creation is `submitted`, not authorization to resubmit. Provider task IDs are not persisted or exposed; reconciliation of a lost create response requires external operator evidence.

Errors contain fixed codes and outcome only, not provider messages or payloads. Task strings, solution strings and shared proxy values are registered for MCP text redaction, including console and DOM/evaluate output. This cannot prevent a page deliberately transforming, splitting, or exfiltrating a value, or placing it in images/files/network requests. Do not use untrusted site callbacks. See [2captcha's API documentation](https://2captcha.com/api-docs).

## Trusted site adapters

Configure an adapter under an approved policy site when automatic widget handling is insufficient:

```json
{
  "origin": "https://approved.example",
  "acceptSelector": "#site-confirmed",
  "challenge": {
    "type": "RecaptchaV3TaskProxyless",
    "widgetSelector": "#captcha-area",
    "taskCallback": "getCaptchaTask",
    "solutionCallback": "applyCaptchaSolution"
  }
}
```

These are names of **trusted own-global functions on your application**, not arbitrary expressions or code supplied through MCP. `getCaptchaTask()` synchronously returns the exact provider task, for example:

```js
window.getCaptchaTask = () => ({
  type: 'RecaptchaV3TaskProxyless',
  websiteURL: location.href,
  websiteKey: 'your-public-sitekey',
  minScore: 0.9,
  pageAction: 'form',
  isEnterprise: true,
});
window.applyCaptchaSolution = solution => {
  // Submit to your application's verification endpoint. Only show
  // #site-confirmed after your server has actually accepted the solution.
  verifyOnYourServer(solution.gRecaptchaResponse || solution.token);
};
```

For recognition tasks return bounded base64 image/audio data in their documented fields. Extraction must be a read of already-available data, not a network operation that generates a new challenge on every call. The task is re-read immediately before application and must still match. Do not return cookies/authentication unrelated to the CAPTCHA. The page must not return proxy fields; the owner binds them privately. If `websiteURL` or `redirectUri` is present it must exactly match the active document, not another origin or page.

The widget must be visible and unique. The widget, document, callback identities, task data and owner binding must remain unchanged until application. An absent/unconfigured site adapter is not synthesized by crawling arbitrary sites or guessing callbacks. Asynchronous solution callbacks may submit to your server, but acceptance must become visible within the single deadline on the original document; navigation invalidates the solve. Cookie answers are data only: the runtime never blindly imports provider cookies into other origins. Your trusted adapter must apply/verify the supported answer appropriately.

## Policy and accounting

Create an owner-only directory outside all Git repositories, with protected ancestors. Explicitly initialize once with `node scripts/browser-budget.mjs init /absolute/private/directory` from the source checkout, or `node <config_dir>/prometheus-browser/browser-budget.mjs init /absolute/private/directory` in an installed runtime; an existing or corrupt ledger is never automatically reset. Configure the browser `captcha` object with the existing key settings plus this example shape (replace every value):

```json
"policy": {
  "ledgerDir": "/absolute/private/directory",
  "sites": [{ "origin": "https://approved.example", "acceptSelector": "#site-confirmed" }],
  "estimateMicros": 3000,
  "dailyTasks": 10, "lifetimeTasks": 100,
  "dailyMicros": 30000, "lifetimeMicros": 300000
}
```

Amounts are integer millionths of USD. Set the estimate conservatively from the provider's current pricing; the provider does not offer a per-task price cap in this integration, so **an actual charge can exceed the estimate and configured caps**. The cap bounds reservations, not an independently enforceable provider charge ceiling. A higher reported actual is recorded and blocks further reservations as appropriate. The per-call `max_cost_usd` must cover the estimate; it is not a provider-enforced maximum charge. Each call submits at most one task.

Reservations are serialized across processes and fsynced before dispatch. **At most one unresolved reservation is permitted per ledger.** Every new reservation is blocked while any entry has an unknown actual charge, even across process restart or a UTC day boundary; this includes timeouts, crashes, missing/malformed costs, failed receipt persistence and potentially tasks stopped before dispatch. The barrier exists because an unrecorded actual may exceed the estimate. Counts and `max(estimate, actual)` are charged to both lifetime and the UTC creation day. The estimate is never automatically released even for a lower actual, rejection, cancellation, or unknown response. The same document/task/proxy-generation hash cannot be reserved twice in the same ledger, including after restart; changed task data is a different identity, not proof that an earlier task was free. A UTC day before the last reservation day is rejected to avoid rollback resets. A missing, unsafe, full, locked, or corrupt ledger fails closed. There is no automatic reset and no built-in release; changing budgets, archiving/replacing a ledger, or manually removing storage requires explicit operator review of all unresolved tasks and charges. Never discard unknown commitments to make capacity available.

When a trustworthy external receipt is available, `node scripts/browser-budget.mjs reconcile /absolute/private/directory OPERATION_HASH ACTUAL_MICROS` records the actual once; find the hash only in the private ledger. In an installed runtime, run `node <config_dir>/prometheus-browser/browser-budget.mjs` instead. Reconcile only with independently verified evidence; do not guess zero to clear the barrier. Reconciliation removes the unknown-actual barrier for that entry but never reduces the retained reservation or task count; an actual exceeding the caps continues to block new reservations. A receipt from `getTaskResult.cost` is rounded upward to microdollars; absent or malformed cost remains unknown. Do not put provider task IDs, tokens, keys, or proxy credentials in the ledger.

Only configure a selector that is a trustworthy site-specific acceptance signal, absent before callback and visible freshly afterward. The owner binds the solve to its active document/context and proxy session generation; external-CDP contexts are not eligible because they are not exclusively owned. Cancellation may leave already-dispatched provider or browser operations unknown. The MCP is serialized, and cancellation notifications can interrupt an outstanding solve; an already-dispatched page callback cannot be undone or safely replayed.

The internal lifecycle accepts an `AbortSignal` at inspection and uses one `timeoutMs` deadline from inspection through verification. The supported visible widget and managed-challenge policy are checked again before callback dispatch, and managed-denial evidence is checked again before reporting acceptance. A cancelled or timed-out browser evaluation already dispatched cannot be undone: its application outcome is unknown, never verified on that basis, and must be inspected rather than retried automatically. Provider `submitted` describes provider submission, not proof of callback or site acceptance.

Main-frame navigation or page/context closure aborts a pending provider wait immediately. This does not establish that a dispatched task was free: its outcome may remain unknown, and it must not be retried automatically.

## Qualification

Run `node --test tests/integration/browser_2captcha.test.mjs tests/integration/browser_captcha_catalog.test.mjs tests/integration/browser_captcha_adapters.test.mjs tests/integration/browser_captcha_mcp.test.mjs tests/integration/browser_challenge.test.mjs tests/integration/browser_budget.test.mjs`.

The tests use synthetic data and a loopback provider transport, never the real API key or a paid solve. They cover all 64 canonical types, both documented aliases, additional conditional variants, automatic standalone reCAPTCHA/Turnstile, configured typed adapters, authenticated upstream proxy selection in an installed MCP process, proxy-disclosure refusal, no proxyless fallback, durable receipts, stale callbacks, denial, and redaction. Live qualification requires a separately approved controlled site, explicit paid authorization and limits, a trustworthy site acceptance signal, and successful receipt reconciliation. Do not use artificial Google traffic or YouTube view generation as a CAPTCHA integration test.
