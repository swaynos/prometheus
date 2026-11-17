# Browser proxy pool: low-level design

**Status:** Implemented in `scripts/opencode-browser-proxy-list.mjs`, `scripts/opencode-browser-sessions.mjs`, and `scripts/browser-sessions.mjs`.
Use `npm run browser:sessions` for the command-line interface.

**Requirements:** [Proxy specification](BROWSER-PROXY-SPEC.md).
The specification takes precedence if the two documents conflict.

## 1. Integration points

| Module | Responsibility |
| --- | --- |
| `scripts/opencode-browser-runtime.mjs` | Validate permitted configuration fields, build launch/context options, and create task contexts. |
| `scripts/opencode-browser-proxy-list.mjs` | Read and parse the private list, stable IDs, credentials, and redaction literals. |
| `scripts/opencode-playwright-mcp.mjs` | Create the context on demand through `ensureContext()`. Clear it through `closeBrowser()`. Manage status, hydration, and transfers. |
| `scripts/opencode-browser-login.mjs` | Launch a headed persistent context or select CDP automatically where supported. Join the task assignment without allocation. |
| `scripts/opencode-browser-state.mjs` | Store private authentication for approved origins. Authentication record names differ from proxy session names. |
| `scripts/browser-profile.mjs` | Control staged runtime inventory and installation probes. Account for new files and secret-handling rules. |

Preserve existing browser, authentication, and transfer interfaces and safeguards.

## 2. Configuration and validation

The primary browser configuration is:

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

Without `pool`, select `<config_dir>/proxies.txt`, normally `~/.config/opencode/proxies.txt`.
Each line contains `HOST:PORT:USER:PASS`.
There is no `poolFile` setting or required separate credential directory.
Explicit legacy `pool` arrays use `{ id, server, credentialsFile? }`.
They take priority without reading the default list.
Empty or invalid explicit pools stop validation.

### Static and private representations

`validateProxyConfig()` performs static validation without file reads.
`resolveProxyConfig()` privately loads text entries for lifecycle operations.
Never feed resolved entries back into browser configuration.

Configuration copies share a process-private `WeakMap` redaction context.
Credentials and original record/endpoint literals remain there and in private runtime entries.
They never become enumerable configuration properties.
JSON and login IPC carry source configuration only.

### Secure text-file read

`readProxyList()` performs these operations:

1. Open real ancestors with `O_DIRECTORY | O_NOFOLLOW`.
2. Hold their descriptors.
3. Enforce trusted ownership and protection from untrusted writes.
   The configuration root must belong to the current user.
   It can have mode `0755`.
   Permit root-owned sticky temporary ancestors.
4. Reject repository-shaped ancestors.
5. Open the list with `O_NOFOLLOW | O_NONBLOCK`.
6. Require a current-user-owned regular file, one hardlink, and exact mode `0600`.
7. Read at most 1 MiB plus one overflow byte.
8. Before decoding, verify file identity, owner, mode, link count, size, modification time, and change time again.
9. Verify every held directory identity and mode again.

Unsupported platforms and unsafe files fail closed.
Return fixed codes, not filesystem messages or file paths.

### Parser and identity

`parseProxyList()` accepts strict UTF-8, optional initial BOM, LF/CRLF, blank lines, and full-line `#` comments.
It recognizes bracketed IPv6 or unbracketed hostname/IPv4.
The port is a decimal integer from `1` through `65535`.
The username must be nonempty and contain no colon.
Everything after its delimiter forms the password, which must also be nonempty.
Preserve spaces, colons, `#`, and `@` in credentials.
Do not URL-decode them.

Reject control characters, malformed or empty records, duplicate endpoint/username identities, and more than 4096 entries.
Parser errors expose only fixed codes and optional 1-based line numbers.

Each text ID is `file-` followed by 32 hexadecimal SHA-256 characters.
Hash input is `JSON.stringify([canonicalServer, username])`.
Exclude password and line number.
Reordering or password replacement preserves identity.
Different usernames on one gateway remain distinct.
These opaque hashes identify changes; they do not protect secrets.
Migration from handwritten IDs requires explicit session/cursor reconciliation.
Never rewrite the registry silently.

### Legacy credentials and restrictions

Legacy JSON contains `{ "username": "...", "password": "..." }`.
Retain relative-path, private-parent `0700`, file `0600`, ownership, and link-safety checks.
Explicit JSON pools can contain unauthenticated proxies.

Require `strategy: "round-robin"` and valid session names.
Legacy entries also require unique safe IDs and explicit `http://host:port` URLs.
Reject unsupported protocols, embedded credentials, URL paths, queries, fragments, external CDP, and non-Chromium profiles.
Without `proxy`, retain direct routing even if a list exists.
With `proxy`, require a configuration directory and an explicitly created named session.
Missing lists, invalid configuration, and absent registries must never authorize direct routing.

## 3. Persistent registry

Store the registry under the configuration directory, separate from `prometheus-sessions/`.
The logical structure is:

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

This example does not permit public disclosure of fingerprints or timestamps.
Store no credentials, cookies, endpoint URLs, or page data.
An endpoint fingerprint detects changes. It does not provide secrecy.
Keep the registry private.

The cursor references a stable ID, not an array index.
On creation or rotation, select `nextProxyId`.
Store its successor from the current pool order.
If the cursor ID is missing, require explicit reconciliation.
Do not guess a successor.

Reordering leaves existing assignments intact and affects only successors chosen after the current cursor is consumed.
A new registry starts with the first configured proxy.
A missing assigned ID or endpoint fingerprint mismatch blocks launch.
Endpoint fingerprints exclude credentials, while text IDs include usernames.
Password changes therefore preserve identity, but username changes require reconciliation.

Validate schema and names on every read.
Corrupt state stops operations. Never reset it automatically.
Use owner-only `0700` directories and `0600` files with safe ownership and link checks.
Write a unique temporary file in the same directory.
Flush it, rename atomically, and sync the directory where supported.
Reject unsafe existing targets.

### Atomic allocation and locking

Use one interprocess lock for registry read, validation, mutation, and commit.
Bound acquisition time and report clear errors.
Select and advance within one transaction.
Do not hold the lock during browser launch or network activity.

Use a platform-appropriate primitive with established ownership and crash recovery.
Do not remove a lock based only on age.
Ambiguous ownership requires explicit operator recovery.
Test killed writers, contention, corrupt state, and crash boundaries.
A failed launch after commit does not undo allocation.

## 4. Session ownership and generation

Use separate per-session ownership for the task browser lifetime and login handoffs.
Owner records identify the session, generation, and process instance.
Use a non-reusable process identity, not PID alone.

A helper joins the existing assignment through an authenticated local handoff tied to the owner and generation.
Keep the handoff private and short-lived; never display or log it.
Joining must not allocate another proxy.

Serialize creation, rotation, acquisition, and release against registry and ownership state.
Rotation must not race startup or login.
Reject rotation while an owner or helper remains active.
Before launch or handoff acceptance, verify generation.
Stale generations must not resume.

Do not infer process death from elapsed time.
If process identity or ownership cannot be established, stop and require operator reconciliation.
Define crash cleanup and lock order, then test both on each supported platform before enabling concurrency.

If the task owner exits, an active helper must still prevent rotation.
Browser close releases ownership only after the browser and joined helpers close or conclusively stop.
Preserve registry metadata and authentication.

## 5. Session management interface

The CLI provides:

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

Commands accept applicable `--session <name>`, `--name <auth-record>`, `--proxy-id <id>`, and `--config-dir <dir>` options.
`doctor` accepts only `--config-dir`.
It evaluates all registered sessions and configured pool entries.

| Operation | Behavior |
| --- | --- |
| Create | Reserve a proxy under the registry lock. |
| List | Return sanitized metadata without mutation or cursor advance. |
| Show | Return sanitized metadata. May prune conclusively dead owners. Never advance the cursor. |
| Bind | Require an existing authentication record. Change associations, not saved state. |
| Rotate | Require inactivity. Allocate atomically, increment generation, and clear associations by default. |
| Retain associations | Require the explicit option and issue a warning. |
| Reconcile session | Select a configured pool member without advancing the cursor. |

Configuration selects the session at startup; later edits do not change an active browser's session.
Rotation uses the global cursor, not a per-session successor.
It can select the current proxy, including with single-member pools.
Generation and association-reset rules still apply.
`reconcile-session <session> <proxy-id>` selects a member explicitly.
Changed-ID or changed-endpoint reconciliation increments generation and clears associations by default.
An unchanged assignment causes no update.

### Diagnostic implementation

`diagnoseSessions()` implements `doctor` through strict readers and process-liveness classification.
It neither acquires the registry lock nor calls inspectors that prune dead owners.
Reports contain fixed codes and sanitized IDs/counts only.
Never retain credentials in reports or repair files.

Text-load failure returns `proxy-list-*` issues and optional line numbers.
Do not attempt registry operations after an invalid list.
For a valid list, report opaque IDs in source order.

- Active locks and dead records produce warnings.
- Unsafe or corrupt state, ambiguous ownership, missing sessions, removed IDs, endpoint drift, and invalid credentials produce errors.
- CLI status is `1` for errors, otherwise `0`.

Concurrent activity can immediately invalidate a result.
`ok` does not authorize rotation or prove routing.
Unlike `doctor`, `show` can prune conclusively dead owners.
Neither changes the cursor.

## 6. Launch, login, and hydration

1. Statically validate task configuration.
2. Resolve the pool privately and acquire ownership against the stored assignment.
   Use text credentials from that validated snapshot.
   Read legacy credentials outside the registry lock.
3. Start an owner-local HTTP relay on `127.0.0.1`.
   It injects upstream proxy authentication.
   Playwright receives only the relay URL, not upstream credentials.
   Keep upstream details out of `browserRuntimeInfo`, `browser_status`, serializable configuration, launch summaries, and errors.
4. Create the browser and context.
   On failure, close partial resources and release ownership.
   Preserve the committed assignment.
5. For login, require a separate proxy-session selector and authenticated handoff.
   Verify generation and resolve the same proxy.
   Use the managed persistent-context path.
   Disable automatic CDP selection with proxies.
   Reject explicit external CDP with proxy configuration.
6. Bind authentication only after successful capture.
   Retain user approval, origin-limited capture, private storage, and task-context access verification.
7. Before hydration, restrict candidates to the current generation's associated records.
   Then apply existing origin checks.
   Do not scan unrelated records for a proxy session.
   Non-proxy behavior stays unchanged.
8. On close, release ownership only after cleanup.
   Reopening resolves the same registry assignment.
   Text edits do not reconfigure an existing relay.
   Lifecycle and generation checks reread the list.
   Removed identities or invalid edits stop validation.
   Before identity changes, close task and helper contexts.

The installer probe serializes configuration through `JSON.stringify(config)`.
It must not resolve credentials, create sessions, advance the cursor, or expose secrets.
Keep static validation separate from explicitly requested proxy qualification.

## 7. Routing, diagnostics, and redaction

Audit task and login navigation, popups, page `fetch`, download events, authenticated retrieval, and media saves.
Identify requests that use browser contexts and those that use Node networking.
Route or reject every supported path.
Send proxy authentication only to the proxy, never the destination.
Do not promise OS-wide containment.
Document qualified paths and DNS/WebRTC limits.

Maintain separate private and public representations.
Public status may contain `{ enabled, session, generation, proxyId, routing: "configured" }`.
That is configuration evidence, not exit-IP verification.
Wrap Playwright, network, CLI, and filesystem errors before public output.
Prevent disclosure of credentials and endpoint details.
Test with distinctive synthetic secrets, including launch errors and installer diagnostics.

Where observable, classify connection/tunnel errors and HTTP 407 as proxy failure.
Distinguish target denial when evidence supports it.
After interruption of a dispatched action, preserve the unknown outcome.
Never retry, rotate, bypass, or relax TLS automatically.

## 8. Testing and qualification

Use local authenticated HTTP proxies, CONNECT tunnels, destination servers, and controlled failures.
Exercise success and failure without third-party proxies or public IP services.

Required coverage:

- Configuration schema, text parsing, limits, and line diagnostics.
- URL validation, secure reads, path swaps, credential safety, and redaction.
- Legacy JSON and non-proxy compatibility.
- Cursor order, wraparound, restart, reorder, removal, and endpoint changes.
- Concurrent allocation, interrupted writes, corrupt state, and stale or ambiguous locks.
- Generation/ownership races, active-rotation rejection, and login handoffs.
- Helpers that survive owner failure.
- Login and later browsing through one proxy.
- Explicit authentication associations, rotation, origin limits, and verification.
- HTTP/CONNECT, destination credential isolation, tabs, frames, popups, uploads, downloads, and media.
- Proxy-down detection without direct routing.
- HTTP 407 and target-denial classification.
- No replay after interrupted non-idempotent actions.
- Staged inventory, read-only probes, no status-triggered rotation, and transfer/authentication regressions.

| Test file | Coverage |
| --- | --- |
| `tests/integration/browser_proxy_list.test.mjs` | Parser, secure bounded reads, path swaps, identities, diagnostics, precedence, fresh-process CLI, invalidated handoffs, and installer privacy |
| `tests/integration/browser_proxy.test.mjs` | Shared HTTP/CONNECT/transfer/login scenarios for JSON and text sources. Text cases remove individual credential JSON files. |
| `packages/prometheus/test/artifacts.test.mjs` | Secret-list exclusion from candidate manifests. Placeholder examples remain included. |

Run from the repository root:

```sh
npm test
npm run test:controller
PROMETHEUS_TEST_BROWSER_CHANNEL=chrome npm test
```

`.github/workflows/browser-proxy.yml` defines Ubuntu 24.04 tests for Chromium and Chrome in headless and Xvfb modes.
`PROMETHEUS_TEST_PROXY_MODE` selects the actual task launch mode.
Virtual-display jobs also run the login fixture headed under Xvfb.
Separate tests cover the managed service launcher, concurrent displays, and cleanup.
Tests report Node, platform, architecture, Playwright, channel, mode, and browser versions.
Assess results separately for each platform, browser, and mode; a workflow definition alone does not establish a passing result.
Local fixtures do not qualify a real provider or human login desktop.
