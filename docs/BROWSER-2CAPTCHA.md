# 2captcha integration

## Purpose and support

The provider adapter validates requests and responses for **64 canonical task types and two aliases** from 2captcha's API v2 catalog, including reCAPTCHA, Turnstile, and image and audio recognition.
Controlled fixtures exercise the catalog; they do not establish acceptance by the live provider.

The executable catalog is `CAPTCHA_TYPES` in `opencode-browser-captcha-types.mjs`.
The adapter rejects unknown task names and fields before they reach the provider.
This versioned catalog does not automatically support future additions or legacy API v1 methods.

To resolve inconsistent provider naming, the adapter recognizes two aliases.
The adapter converts `GridTaskProxyless` to `GridTask` and `IncapsulaTask` to `ImpervaTask`, as used in concrete request examples.

**Provider support does not imply automatic browser detection.**
Automatic detection requires one visible standalone Turnstile or reCAPTCHA v2/Enterprise widget.
Its `data-callback` must name a simple own-global function.
Other variants require an explicitly configured trusted site adapter.
Stop on managed/full-page access denial, including Google's unusual-traffic pages.
Provider support does not remove that restriction.

Solving remains disabled without a complete `captcha` policy and an explicitly initialized ledger.
Every solve also requires explicit paid authorization and limits.
Use read-only `browser_challenge_inspect` to identify candidates; its results do not guarantee solvability or ledger availability.
Navigation never starts a solve.
A provider solution does not prove site acceptance.

## Proxy routing and disclosure

Store browser proxy credentials in `<config_dir>/proxies.txt`, not the API-key file.
Use one `HOST:PORT:USER:PASS` record per line and file mode `0600`.
See [proxy setup](BROWSER-OPERATIONS.md#proxy-setup-and-session-lifecycle).

The Node connection to `api.2captcha.com` uses a **separate direct service channel**.
Configure the solving worker's route separately:

- `captcha.proxyMode: "browser"` permits disclosure of the pinned upstream proxy endpoint and credentials to 2captcha for supported network tasks.
  The adapter selects the documented proxy task counterpart when one exists.
  It never sends the loopback relay.
  It verifies ownership and generation again before using the pinned capability.
  Pages cannot supply or replace the proxy.
- `captcha.proxyMode: "proxyless"` permits the worker to use its own IP while the browser retains its pinned proxy.
  IP binding can make the answer unusable.
- Without `proxyMode`, network solves from a proxied browser stop before dispatch with `proxy_disclosure_required`.
  A configured `proxies.txt` does not authorize third-party credential disclosure.
- Documented reCAPTCHA v3, including Enterprise through `isEnterprise`, is **proxyless-only**.
  `"browser"` routing returns `proxy_not_supported`.
  It does not fall back.
- Proxy-required types need `"browser"` and an owned browser proxy.
  Recognition-only tasks, such as image, text, and audio, do not navigate on the worker.
  They need no proxy disclosure.

Browser routing supports HTTP upstream proxies only; this integration does not add SOCKS browser routing.
For independent internal callers, the provider validator accepts documented `http`, `socks4`, and `socks5` task fields.

## Coverage matrix

All rows have synthetic request/response validation and controlled Chromium site-adapter tests.
**These tests do not qualify live paid solves.**
Acceptance of fixture data does not prove acceptance by the real CAPTCHA vendor.

| Family | API v2 task names | Worker proxy | Browser application |
| --- | --- | --- | --- |
| reCAPTCHA v2 | `RecaptchaV2Task[Proxyless]` | Either | Automatic visible standalone callback or site adapter |
| reCAPTCHA v2 Enterprise | `RecaptchaV2EnterpriseTask[Proxyless]` | Either | Automatic visible standalone callback or site adapter |
| reCAPTCHA v3 / Enterprise | `RecaptchaV3TaskProxyless` (`isEnterprise`) | Proxyless only | Site adapter with explicit action and score |
| Turnstile | `TurnstileTask[Proxyless]` | Either | Automatic visible standalone callback or site adapter |
| Arkose/FunCaptcha | `FunCaptchaTask[Proxyless]` | Either | Site adapter |
| GeeTest v3/v4 | `GeeTestTask[Proxyless]` (`version: 4`, `initParameters`) | Either | Site adapter. Requires a fresh v3 challenge. |
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
| DataDome | `DataDomeSliderTask` | Required | Site adapter. Stop on managed denial. |
| CaptchaFox | `CaptchaFoxTask` | Required | Site adapter |
| VK | `VKCaptchaTask` | Required | Site adapter |
| Hunt | `HuntTask` | Required | Site adapter |
| TSPD / Imperva | `TspdTask`, `ImpervaTask` | Required | Site adapter. Stop on managed denial. |
| Image/text/audio | `ImageToTextTask`, `TextCaptchaTask`, `AudioTask` | Not applicable | Site adapter |
| Rotation/click/grid | `RotateTask`, `CoordinatesTask`, `GridTask` | Not applicable | Site adapter. reCAPTCHA/FunCaptcha grids use `imgType`. |
| Drawing/boxes/drag | `DrawAroundTask`, `BoundingBoxTask`, `DragAndDropTask` | Not applicable | Site adapter |
| Image variants | `TemuImageTask`, `VKCaptchaImageTask`, `SmartCaptchaTask`, `PazlCaptchaTask` | Not applicable | Site adapter |

`[Proxyless]` indicates both a base task name and a name with that suffix.
The validator checks each solution by family rather than assuming every answer contains `solution.token`.
Families include tokens, text, rotations, points, grid selections, polygons, boxes, GeeTest fields, and cookie/domain structures.

The adapter converts example aliases `websiteUrl` and `UserCertifyId` to `websiteURL` and `userCertifyId`.
Duplicate spellings stop validation.
Network URLs require HTTPS and must not contain credentials or fragments.

| Data | Limit |
| --- | --- |
| Each complete input or response | 16 MiB |
| Each encoded media field | 10 MiB |
| Each decoded instruction image | 100 KiB |

## Credentials

### Environment file

1. In a source checkout, create `.env` at the project root with mode `0600`.
2. Add `TWOCAPTCHA_API_KEY=your-key`. See `.env.example`.
   Git ignores the file. Never commit or share it.
3. Start the browser runtime with the project root as its working directory.
4. For another working directory or an installed runtime, configure an absolute `captcha.envFile` path to the intended `.env`.

By default, the adapter reads only `.env` in the process working directory, without searching ancestors.
The file must be a regular file owned by the current user, with one link and owner-only access.
It must not be a symlink.
Protect its directories from untrusted writes.

The adapter reads the requested key without importing other variables.
It accepts comments and single-line values, quoted or unquoted.
Malformed lines or duplicate key assignments stop validation.
Import and validation never call the provider.

### Key selection

Internal callers enable the adapter with `{enabled: true, provider: '2captcha', timeoutMs, pollIntervalMs}`.
There is no endpoint override.
The key source priority is:

1. Process environment `TWOCAPTCHA_API_KEY`.
   A present but blank value fails rather than selecting another source.
2. Explicit legacy `keyFile`.
3. Configured `envFile`, or `.env` in the working directory.

Do not configure both `envFile` and `keyFile`.
Legacy `keyFile` requires an absolute path outside all Git repositories.
The file must be regular, current-user-owned, single-link, and not a symlink.
Group and others must have no access.
Its immediate parent must be a real directory owned by the current user, also inaccessible to group and others.
Protect all ancestors from untrusted changes.

Repository detection is conservative.
A non-repository directory with both `HEAD` and `objects` can appear to be a repository.
Use a dedicated private directory without those entries.
Do not weaken the check.

## Provider task lifecycle

Each `createCaptchaTask(config, task, {proxy?, languagePool?})` object copies and validates the complete task, then permits one `solve` attempt.
`onReady(solution, signal)` receives a private, immutable, typed solution.
The public result contains only status and outcome.
`createTurnstileTask` retains the compatible token-string interface.
For recognition tasks, optional `languagePool` accepts `en` or `rn` at the top level of the provider request.
Do not place it inside the task.

Before dispatch, both authorization and reservation hooks must explicitly return `true`.
The MCP owner supplies a durable reservation hook.
Permissive hooks from other internal callers do not provide that protection.

An ambiguous create response means `unknown`; the adapter never retries it automatically.
Polling failure after creation means `submitted`, which does not authorize resubmission.
The adapter does not persist or expose provider task IDs.
A lost create response requires external operator evidence for reconciliation.

Errors contain only fixed codes and outcome, never provider messages or payloads.
The runtime registers task strings, solution strings, and shared proxy values for MCP text redaction.
This includes console and DOM/evaluate output.
Redaction cannot prevent a page from transforming, splitting, or exporting a value.
It cannot prevent disclosure through images, files, or network requests.
Do not use untrusted site callbacks.
See [2captcha API documentation](https://2captcha.com/api-docs).

## Trusted site adapters

If automatic widget handling is insufficient, configure an adapter under an approved policy site:

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

The callback names refer to **trusted own-global functions in your application**.
They are not expressions or code supplied through MCP.
`getCaptchaTask()` returns the exact provider task synchronously:

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
  // Submit to the application's verification endpoint.
  // Show #site-confirmed only after the server accepts the solution.
  verifyOnYourServer(solution.gRecaptchaResponse || solution.token);
};
```

For recognition tasks, return bounded base64 image/audio data in the documented fields.
Read data that is already available.
Do not generate a new challenge through a network request on each read.
Immediately before applying a solution, the runtime rereads the task and requires an exact match.
Do not return cookies or authentication unrelated to the CAPTCHA.
The owner binds proxy fields privately; the page must not return them.
If present, `websiteURL` or `redirectUri` must exactly match the active document.
Another origin or page is not permitted.

The widget must be visible and unique.
Until application, the widget, document, callback identities, task data, and owner binding must remain unchanged.
The runtime does not invent missing adapters through site crawling or guessed callbacks.
Asynchronous solution callbacks may submit to your server.
Acceptance must become visible on the original document within the single deadline.
Navigation invalidates the solve.
Cookie answers are data only.
The runtime does not automatically import provider cookies into other origins.
Your trusted adapter must apply and verify the supported answer.

## Policy and accounting

### Initialization

1. Create an owner-only directory outside all Git repositories.
   Protect its ancestors.
2. From the source checkout, initialize the ledger once:

   ```sh
   node scripts/browser-budget.mjs init /absolute/private/directory
   ```

   For an installed runtime, use:

   ```sh
   node <config_dir>/prometheus-browser/browser-budget.mjs init /absolute/private/directory
   ```

3. Add a policy to the browser `captcha` object alongside the key settings.
   Replace every example value:

```json
"policy": {
  "ledgerDir": "/absolute/private/directory",
  "sites": [{ "origin": "https://approved.example", "acceptSelector": "#site-confirmed" }],
  "estimateMicros": 3000,
  "dailyTasks": 10, "lifetimeTasks": 100,
  "dailyMicros": 30000, "lifetimeMicros": 300000
}
```

The runtime never automatically resets an existing or corrupt ledger.

### Reservation limits

Amounts are integer millionths of USD.
Set a conservative estimate from current provider prices.
This integration has no provider-enforced per-task price cap.
**An actual charge can exceed the estimate and configured caps.**
Caps limit reservations, not provider charges.
The ledger records higher reported actual charges and blocks further reservations when required.
Per-call `max_cost_usd` must cover the estimate.
It does not guarantee a maximum charge.
Each call submits at most one task.

Reservations run in sequence across processes.
The runtime uses `fsync` before dispatch.
**Each ledger permits at most one unresolved reservation.**
An unknown actual charge blocks every new reservation.
This restriction survives process restart and a UTC day boundary.

Unknown charges can follow timeout, crash, missing or malformed cost, or failed receipt persistence.
They can also follow a task stopped before dispatch.
The restriction exists because an unrecorded actual charge can exceed the estimate.

The ledger charges task counts and `max(estimate, actual)` against lifetime limits and the UTC creation day.
It never automatically releases the estimate.
That applies after a lower actual charge, rejection, cancellation, or unknown response.

The same document/task/proxy-generation hash cannot receive a second reservation in one ledger, even after restart.
Changed task data creates a different identity, but does not prove that an earlier task was free.
The ledger rejects a UTC day before the last reservation day to prevent clock-rollback resets.

A missing, unsafe, full, locked, or corrupt ledger stops the operation.
There is no automatic reset or built-in release.
Before changing budgets, archiving or replacing a ledger, or removing storage, explicitly review all unresolved tasks and charges.
Never discard unknown commitments to make capacity available.

### Reconciliation

Once you have an independently verified external receipt, record the actual charge:

```sh
node scripts/browser-budget.mjs reconcile /absolute/private/directory OPERATION_HASH ACTUAL_MICROS
```

Find the operation hash only in the private ledger.
For an installed runtime, use `node <config_dir>/prometheus-browser/browser-budget.mjs` instead.
Reconciliation records the actual once.
Do not guess zero to remove the unknown-charge barrier.

Reconciliation resolves that entry's unknown charge, but never reduces the retained reservation or task count.
An actual charge above the caps continues to block new reservations.
The runtime rounds `getTaskResult.cost` upward to microdollars.
An absent or malformed cost remains unknown.
Do not put provider task IDs, tokens, keys, or proxy credentials in the ledger.

### Acceptance and cancellation

Configure only a trustworthy site-specific acceptance selector.
Its signal must be absent before the callback and newly visible afterward.
The owner binds the solve to the active document, context, and proxy session generation.
External-CDP contexts are ineligible because the runtime does not own them exclusively.

Cancellation can leave dispatched provider or browser operations unknown.
MCP operations run in sequence.
Cancellation notifications can interrupt a pending solve.
The runtime cannot undo or safely replay a page callback after dispatch.

The internal lifecycle accepts an `AbortSignal` at inspection.
One `timeoutMs` deadline covers inspection through verification.
Before callback dispatch, the runtime verifies the supported visible widget and managed-challenge policy again.
Before reporting acceptance, it inspects managed-denial evidence again.

A cancelled or timed-out browser evaluation cannot be undone after dispatch.
Its application outcome is unknown.
Do not report acceptance on that basis.
Inspect the result instead of retrying automatically.
Provider `submitted` means provider submission, not callback execution or site acceptance.

Main-frame navigation or page/context closure immediately aborts a pending provider wait.
The task can still have an unknown outcome and a charge.
Do not treat cancellation as evidence that the task was free or retry it automatically.

## Qualification

Run from the repository root:

```sh
node --test tests/integration/browser_2captcha.test.mjs tests/integration/browser_captcha_catalog.test.mjs tests/integration/browser_captcha_adapters.test.mjs tests/integration/browser_captcha_mcp.test.mjs tests/integration/browser_challenge.test.mjs tests/integration/browser_budget.test.mjs
```

These tests use synthetic data and a loopback provider transport, without a real API key or paid solve.
Coverage includes:

- All 64 canonical types and both documented aliases.
- Additional conditional variants.
- Automatic standalone reCAPTCHA and Turnstile.
- Configured typed adapters.
- Authenticated upstream proxy selection in an installed MCP process.
- Disclosure refusal and no proxyless fallback.
- Durable receipts, stale callbacks, denial, and redaction.

Live qualification requires a separately approved controlled site.
It also requires explicit paid authorization and limits, a trustworthy acceptance signal, and successful receipt reconciliation.
