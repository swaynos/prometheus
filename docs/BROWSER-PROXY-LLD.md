# Browser Proxy Pool: Low-Level Design

**Status:** Implemented (`scripts/opencode-browser-proxy-list.mjs`, `scripts/opencode-browser-sessions.mjs`, `scripts/browser-sessions.mjs`, `npm run browser:sessions`).

**Requirements:** [Browser Proxy Pool Specification](BROWSER-PROXY-SPEC.md). This document describes implementation details; the specification controls in case of conflict.

## 1. Current integration points

- `scripts/opencode-browser-runtime.mjs` validates a strict configuration allowlist, builds launch/context options, and creates task contexts.
- `scripts/opencode-browser-proxy-list.mjs` securely reads the default text file and parses private runtime entries, credentials, stable IDs, and redaction literals.
- `scripts/opencode-playwright-mcp.mjs` lazily creates one task context in `ensureContext()`, clears it in `closeBrowser()`, exposes status, and manages saved-state hydration and transfer tools.
- `scripts/opencode-browser-login.mjs` independently launches a headed persistent context or automatically selects CDP. It must receive the task's session assignment, not allocate one.
- `scripts/opencode-browser-state.mjs` owns origin-scoped private authentication records. Its record name is not a browser-session name.
- `scripts/browser-profile.mjs` owns the staged runtime inventory and runs an installation probe that serializes browser configuration. New files and secret-handling rules must be accounted for there.

Preserve existing browser, authentication, and transfer interfaces and safeguards.

## 2. Configuration and validation

The primary top-level browser configuration is:

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

Omitting `pool` selects `<config_dir>/proxies.txt` (normally `~/.config/opencode/proxies.txt`), with one `HOST:PORT:USER:PASS` record per line. There is no `poolFile` setting or required separate credential directory. Explicit `pool` arrays retain the legacy `{ id, server, credentialsFile? }` shape and take precedence without reading the default file. Explicit empty/invalid pools fail; they are not a fallback instruction.

`validateProxyConfig()` remains a static, non-reading operation. `resolveProxyConfig()` privately loads text entries when a lifecycle operation requires the pool. Resolved entries must never be fed back into browser configuration. Config copies share a process-private `WeakMap` redaction context; credentials and original-record/endpoint literals are retained only there and in private runtime entries, never as enumerable config properties. JSON and login IPC carry only source configuration.

`readProxyList()` opens real ancestor directories with `O_DIRECTORY | O_NOFOLLOW`, holds their descriptors, and enforces trusted ownership and no untrusted write permissions. The config root is owned by the current user and may be `0755`; root-owned sticky temporary ancestors are allowed. Reject repository-shaped ancestors. Open the list with `O_NOFOLLOW | O_NONBLOCK`, require a current-user-owned single-link regular file with exact `0600` mode, and read at most 1 MiB plus one overflow byte. Recheck the file's identity, owner, mode, link count, size, modification/change times, and all held directory identities/modes before decoding. Unsupported platforms and unsafe files fail closed with fixed codes, never filesystem messages or file paths.

`parseProxyList()` accepts strict UTF-8 with optional initial BOM, LF/CRLF, blank lines, and full-line `#` comments. Recognize bracketed IPv6 or an unbracketed hostname/IPv4, a decimal port `1..65535`, a nonempty colon-free username, and a nonempty password comprising the entire remainder. Preserve credential spaces, colons, `#`, and `@`; do not URL-decode. Reject control characters, malformed/empty records, duplicate endpoint/username identities, and more than 4096 entries. Parser errors expose only a fixed code and optional 1-based line number.

Each text entry receives `file-` plus the first 32 hexadecimal characters of SHA-256 over `JSON.stringify([canonicalServer, username])`. Passwords and line numbers are excluded. Reordering or refreshing a password preserves identity; different usernames on one gateway remain distinct. Hashes are opaque change/identity keys, not a secrecy boundary. Explicitly migrating legacy hand-written IDs to these generated IDs requires session/cursor reconciliation; never silently rewrite the registry.

Legacy credential JSON still contains `{ "username": "...", "password": "..." }`. Its existing relative-path, `0700` credential-parent, `0600` file, ownership, and link-safety checks remain unchanged. Unauthenticated proxies remain available through explicit JSON pools.

Require `strategy: "round-robin"` and valid session names; legacy entries also require unique safe IDs and explicit `http://host:port` URLs. Reject unsupported protocols, embedded credentials, URL paths/query/fragment, external CDP, and non-Chromium profiles. No `proxy` key means existing non-proxy behavior, even when a list exists. A present `proxy` requires a config directory and explicitly created named session. Missing/invalid lists, configuration errors, or absent registries must never become direct-routing instructions.

## 3. Persistent registry

The private session module stores a registry beneath the configuration directory, separate from `prometheus-sessions/` authentication records. Example logical structure:

```json
{
  "version": 1,
  "nextProxyId": "proxy-b",
  "sessions": {
    "shopping": {
      "generation": 1,
      "proxyId": "proxy-a",
      "endpointFingerprint": "sha256-of-canonical-endpoint",
      "authRecords": ["store-login"],
      "createdAt": "2026-01-01T00:00:00.000Z",
      "rotatedAt": null
    }
  }
}
```

These are logical fields, not permission to expose a fingerprint or timestamps in public output. Store no credentials, cookies, endpoint URLs, or page data in the registry. A plain endpoint fingerprint is a change detector, not a secrecy boundary; protect the registry as private data.

The cursor references a stable proxy ID rather than an array index. On creation or rotation, select `nextProxyId` and store the successor in the current pool order. If the cursor's ID was removed, fail with an actionable reconciliation error rather than guessing a successor. Pool reordering does not affect existing assignments; it affects subsequent successors after the current cursor is consumed. A new registry starts at the first configured proxy. An absent assigned ID or endpoint fingerprint mismatch blocks session launch. Credentials are excluded from the endpoint fingerprint; text-backed IDs separately include the username so password updates preserve identity but username changes require explicit reconciliation.

Validate schema and names on every read. An invalid or corrupt registry stops operations; never auto-reset it. Use owner-only `0700` directories and `0600` files with safe ownership and link checks. Write a uniquely named same-directory temporary file, flush as appropriate, atomically rename, and sync the directory where supported. Reject unsafe existing targets.

### Atomic allocation and locking

Use a single interprocess registry lock across read/validate/mutate/commit, with bounded acquisition and clear errors. Select and advance within one transaction. Hold no lock across browser launch or network activity. Implement locking with a platform-appropriate primitive whose ownership and crash recovery can be established; do not remove a lock solely because of age. If ownership is ambiguous, require explicit operator recovery. Test killed writers, contention, corrupt state, and crash boundaries. A failed launch after commit does not roll back allocation.

## 4. Session ownership and generation

Use a separate per-session ownership mechanism for the lifetime of a task browser and any login handoff. An owner record must identify the session, generation, and process instance using a non-reusable identity, not PID alone. The login helper receives an authenticated local handoff or capability tied to that owner and generation; the capability is private, short-lived, and never displayed or logged. The helper joins rather than allocates.

Serialize create, rotate, acquire, and release operations against the registry and ownership state so rotation cannot race startup or login. A rotate request fails while an owner or helper is active. A process must check its generation before launching or accepting a handoff; stale generations must not resume. Do not infer death from elapsed time. If OS/process identity or ownership cannot be established, fail safely and require operator reconciliation. Define crash cleanup and lock ordering in implementation and test them on each supported platform before enabling concurrency there.

The ownership mechanism must account for an active login helper if its task owner exits; it must not permit rotation while the helper can still use the old route. Browser close releases ownership only once the browser and joined helpers are closed or conclusively stopped. Registry metadata and authentication remain.

## 5. Session management interface

The dedicated CLI is available through the package entry. Supported operations:

```sh
npm run browser:sessions -- create [shopping]
npm run browser:sessions -- list
npm run browser:sessions -- doctor
npm run browser:sessions -- show [shopping]
npm run browser:sessions -- bind-auth [shopping] <auth-record>
npm run browser:sessions -- unbind-auth [shopping] <auth-record>
npm run browser:sessions -- rotate [shopping] [--retain-associations]
npm run browser:sessions -- reconcile-cursor <proxy-id>
npm run browser:sessions -- reconcile-session [shopping] [proxy-id] [--retain-associations]
```

Commands accept the applicable `--session <name>`, `--name <auth-record>`, and `--proxy-id <id>` flags, plus `--config-dir <dir>`. `doctor` accepts only `--config-dir` and checks all registered sessions and configured pool entries.

Create reserves a proxy under the registry lock. Show/list return sanitized metadata without advancing the cursor; list is read-only, while show can prune dead ownership records. Bind verifies that the existing authentication record exists and changes only associations, not saved state. Rotate requires an inactive session, atomically allocates the next proxy, increments generation, and clears authentication associations by default. Provide an explicit retain-associations option with a warning. Configuration chooses the session; an in-flight browser does not change session when configuration changes.

Rotation uses the global cursor, not a per-session successor, and may select the current proxy again (including in single-member pools). Generation and association-reset rules still apply. `reconcile-session <session> <proxy-id>` explicitly chooses a configured pool member without advancing the cursor. A changed ID or endpoint increments generation, clears associations by default, and warns when `--retain-associations` is used; unchanged reconciliation is a no-op.

`diagnoseSessions()` implements `doctor` without calling the pruning ownership inspectors or acquiring the registry lock. It uses strict file readers and liveness classification, reports only fixed codes and sanitized IDs/counts, and never repairs files. Credential values remain private and are excluded from reports. Text-load failures return a failing report with `proxy-list-*` issue codes and optional line numbers; no registry operation is attempted after an invalid list. Valid-file reports list opaque proxy IDs in source order. Active locks and dead records produce warnings; unsafe/corrupt state, ambiguous ownership, missing configured sessions, removed IDs, endpoint drift, and invalid credentials produce errors. CLI status is `1` for errors and `0` otherwise. Concurrent activity can invalidate the snapshot immediately; `ok` is not permission to rotate or proof of routing. Unlike `doctor`, `show` may prune conclusively dead ownership records as part of inspection; neither command changes the registry cursor.

## 6. Launch, login, and hydration

1. Task startup statically validates configuration, resolves the pool privately, and acquires ownership against the stored assignment. Text credentials come from that validated snapshot; legacy credentials are read outside the registry lock.
2. Start an owner-local HTTP relay on `127.0.0.1` that injects upstream proxy authentication. Playwright receives only the relay URL in its launch proxy option, not upstream credentials. Keep upstream connection details out of `browserRuntimeInfo`, `browser_status`, serializable configuration, generated launch summaries, and errors.
3. Create the browser and context. On failure, close partial resources and release ownership without changing the committed assignment.
4. The login helper accepts a distinct browser-session selector and authenticated handoff, validates generation, resolves the same proxy, and uses the managed persistent-context path. Disable automatic CDP selection when proxying. Reject explicit external CDP with proxy configuration.
5. Bind login capture to the session only after successful capture. Retain existing user approval, scoped state capture, private file handling, and task-context authentication verification.
6. In the MCP hydration path, filter candidates to the current generation's associated authentication records before applying existing origin checks. No global scan of unrelated records for proxy-enabled sessions. Non-proxy behavior remains unchanged.
7. On close, release the ownership only after cleanup. Reopening resolves the same registry assignment. Text-file edits do not hot-reconfigure an existing relay. Lifecycle/generation checks reread the file and reject removed identities or invalid edits; close task/helper contexts before identity changes.

Do not rely on the currently generated installer probe's `JSON.stringify(config)` for secrets. The probe must not resolve credentials, create sessions, advance the cursor, or leak secrets. Separate static configuration validation from any explicitly requested proxy-enabled qualification.

## 7. Routing, diagnostics, and redaction

Audit all task and login network paths, including navigation, popups, page `fetch`, browser download events, authenticated retrieval, and media saves. Confirm which requests use the browser context rather than Node's network stack; route or reject every supported path. Ensure proxy authentication reaches the proxy only, never the destination. Do not promise OS-wide fail-closed behavior: document qualified surfaces and known DNS/WebRTC limitations.

Maintain separate internal and public representations. Public status may include `{ enabled, session, generation, proxyId, routing: "configured" }`; it is configuration evidence, not exit-IP verification. Wrap Playwright, network, CLI, and filesystem errors at boundaries so credentials and endpoint details cannot leak. Test redaction with deliberately distinctive test secrets, including launch errors and installer diagnostics.

Classify connection/tunnel failures and HTTP 407 as proxy failures where observable; distinguish target access denial where evidence supports it. Preserve unknown outcome semantics when a dispatched action is interrupted. Never automatically retry, rotate, bypass, or relax TLS checks.

## 8. Testing and qualification

Add local fixtures for an authenticated HTTP forward proxy, CONNECT tunnels, destination servers, and controlled failures. Exercise both success and failure without depending on third-party proxy or IP-check services.

Required coverage:

- Config schema, strict text parsing/limits/line diagnostics, URL validation, secure file reads/path-swap rejection, credential safety, secret redaction, and compatibility with legacy JSON pools and without proxies.
- Cursor order, wraparound, restart persistence, pool reorder/removal/endpoint change, concurrent allocations, interrupted writes, corrupt registry, and stale/ambiguous locks.
- Generation and ownership races, active rotation rejection, login handoff, and helper surviving owner failure.
- Login and later browsing through the same proxy; explicit auth bindings and rotation behavior; origin scoping and verification remain intact.
- HTTP and HTTPS CONNECT, credentials not forwarded to destinations, tabs/frames/popups, uploads, download and media paths, and proxy-down direct-connection checks.
- 407 and target denial classification; interrupted non-idempotent actions are not replayed.
- Staged install/update inventory, read-only installer probes, no rotation on status, and existing transfer and authentication regressions.

`tests/integration/browser_proxy_list.test.mjs` covers the text parser, bounded secure reads (including file/directory swaps), stable identities, read-only diagnostics, source precedence, fresh-process CLI use, invalidated handoffs, and installer privacy. `browser_proxy.test.mjs` runs the same HTTP/CONNECT/transfer/login fixture scenarios for both JSON and text sources, removing per-proxy JSON credential files in the text variants. `packages/prometheus/test/artifacts.test.mjs` verifies that real `proxies.txt` files are excluded from candidate enumeration/manifests while the placeholder example remains visible.

Run `npm test`, `npm run test:controller`, and `PROMETHEUS_TEST_BROWSER_CHANNEL=chrome npm test`. Qualify Linux headless and virtual-display, plus macOS when available. Document engine and Playwright/browser versions; unavailable configurations are unverified. Include explicit provider-side rotating-IP limitations in operational guidance.

`.github/workflows/browser-proxy.yml` runs proxy/session fixtures on Ubuntu 24.04 for Playwright Chromium and installed Chrome in headless and Xvfb virtual-display modes. `PROMETHEUS_TEST_PROXY_MODE` selects actual task launch mode; the login fixture also launches headed under Xvfb in virtual-display jobs. Separate virtual-display tests exercise the managed service launcher, concurrent displays, and cleanup. Tests report Node, platform/architecture, Playwright, channel, mode, and browser versions. Workflow definition alone does not qualify Linux: retain the unverified status until its runs are reviewed. These local fixtures do not qualify a real provider or an interactive human login desktop.

## 9. Delivery sequence

1. Add validation, credential handling, registry, locking, and focused tests.
2. Add session CLI, ownership and generation semantics, with concurrency tests.
3. Integrate managed task launch and sanitized status.
4. Integrate login handoff and explicit authentication bindings.
5. Audit transfers, failure handling, and redaction with local proxies.
6. Update installer inventory, documentation, and staged-install tests; run the full regression matrix.
7. Deploy only on separate authorization after active browser tasks and login helpers are stopped.
