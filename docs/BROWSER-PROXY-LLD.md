# Browser Proxy Pool: Low-Level Design

**Status:** Proposed; not implemented.

**Requirements:** [Browser Proxy Pool Specification](BROWSER-PROXY-SPEC.md). This document proposes implementation details; the specification controls in case of conflict.

## 1. Current integration points

- `scripts/opencode-browser-runtime.mjs` validates a strict configuration allowlist, builds launch/context options, and creates task contexts.
- `scripts/opencode-playwright-mcp.mjs` lazily creates one task context in `ensureContext()`, clears it in `closeBrowser()`, exposes status, and manages saved-state hydration and transfer tools.
- `scripts/opencode-browser-login.mjs` independently launches a headed persistent context or automatically selects CDP. It must receive the task's session assignment, not allocate one.
- `scripts/opencode-browser-state.mjs` owns origin-scoped private authentication records. Its record name is not a browser-session name.
- `scripts/browser-profile.mjs` owns the staged runtime inventory and runs an installation probe that serializes browser configuration. New files and secret-handling rules must be accounted for there.

The existing modifications in the working tree are not part of this proposal to replace or discard. Preserve their interfaces and behavior.

## 2. Configuration and validation

Extend the top-level browser configuration with the following proposed shape:

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

The optional credentials file contains `{ "username": "...", "password": "..." }`. This example contains placeholders, not credentials. Resolve credential paths under the private configuration directory; reject absolute paths, traversal, unsafe parent components, symlinks, nonregular files, unexpected ownership or permissions, and hard links. Open and validate files in a race-resistant manner and fail closed if the platform cannot establish the required properties. Never print file contents.

Validate nonempty unique IDs with a bounded safe-name grammar; require `strategy: "round-robin"`; accept only explicitly specified `http://host:port` endpoints. Reject userinfo, paths other than the empty/root form, query strings, fragments, invalid ports, and unsupported schemes. Canonicalize endpoints before comparing them. Reject `proxy` with `external-cdp` and reject unsupported engine/mode combinations instead of pretending the route is enforced. Validate without allocating a session or reading secrets unless launch requires them.

No `proxy` key means existing behavior. A present `proxy` requires a configuration directory and an already-created named session. Do not treat configuration-file errors or an absent registry as an instruction to connect directly.

## 3. Persistent registry

Add a private session module and a registry beneath the configuration directory, separate from `prometheus-sessions/` authentication records. Example logical structure:

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

The cursor references a stable proxy ID rather than an array index. On creation or rotation, select `nextProxyId` and store the successor in the current pool order. If the cursor's ID was removed, fail with an actionable reconciliation error rather than guessing a successor. Pool reordering does not affect existing assignments; it affects subsequent successors after the current cursor is consumed. A new registry starts at the first configured proxy. An absent assigned ID or endpoint fingerprint mismatch blocks session launch. Credentials are deliberately excluded from the endpoint fingerprint so they can be updated independently.

Validate schema and names on every read. An invalid or corrupt registry stops operations; never auto-reset it. Use owner-only `0700` directories and `0600` files with safe ownership and link checks. Write a uniquely named same-directory temporary file, flush as appropriate, atomically rename, and sync the directory where supported. Reject unsafe existing targets.

### Atomic allocation and locking

Use a single interprocess registry lock across read/validate/mutate/commit, with bounded acquisition and clear errors. Select and advance within one transaction. Hold no lock across browser launch or network activity. Implement locking with a platform-appropriate primitive whose ownership and crash recovery can be established; do not remove a lock solely because of age. If ownership is ambiguous, require explicit operator recovery. Test killed writers, contention, corrupt state, and crash boundaries. A failed launch after commit does not roll back allocation.

## 4. Session ownership and generation

Use a separate per-session ownership mechanism for the lifetime of a task browser and any login handoff. An owner record must identify the session, generation, and process instance using a non-reusable identity, not PID alone. The login helper receives an authenticated local handoff or capability tied to that owner and generation; the capability is private, short-lived, and never displayed or logged. The helper joins rather than allocates.

Serialize create, rotate, acquire, and release operations against the registry and ownership state so rotation cannot race startup or login. A rotate request fails while an owner or helper is active. A process must check its generation before launching or accepting a handoff; stale generations must not resume. Do not infer death from elapsed time. If OS/process identity or ownership cannot be established, fail safely and require operator reconciliation. Define crash cleanup and lock ordering in implementation and test them on each supported platform before enabling concurrency there.

The ownership mechanism must account for an active login helper if its task owner exits; it must not permit rotation while the helper can still use the old route. Browser close releases ownership only once the browser and joined helpers are closed or conclusively stopped. Registry metadata and authentication remain.

## 5. Session management interface

Add a dedicated CLI and package entry, with final flag syntax documented before release. Intended operations:

```sh
npm run browser:sessions -- create shopping
npm run browser:sessions -- list
npm run browser:sessions -- show shopping
npm run browser:sessions -- bind-auth shopping store-login
npm run browser:sessions -- rotate shopping
```

Create reserves a proxy under the registry lock. Show/list are read-only and sanitized. Bind verifies that the existing authentication record exists and changes only associations, not saved state. Rotate requires an inactive session, atomically allocates the next proxy, increments generation, and clears authentication associations by default. Provide an explicit retain-associations option with a warning. Configuration chooses the session; an in-flight browser does not change session when configuration changes.

## 6. Launch, login, and hydration

1. Task startup validates configuration, acquires ownership, resolves the stored assignment against the configured pool, and reads credentials privately.
2. Build an internal Playwright proxy option from the endpoint and optional credentials. Pass it at the appropriate launch/context layer for each qualified engine and managed mode. Keep it out of `browserRuntimeInfo`, `browser_status`, serializable configuration, generated launch summaries, and errors.
3. Create the browser and context. On failure, close partial resources and release ownership without changing the committed assignment.
4. The login helper accepts a distinct browser-session selector and authenticated handoff, validates generation, resolves the same proxy, and uses the managed persistent-context path. Disable automatic CDP selection when proxying. Reject explicit external CDP with proxy configuration.
5. Bind login capture to the session only after successful capture. Retain existing user approval, scoped state capture, private file handling, and task-context authentication verification.
6. In the MCP hydration path, filter candidates to the current generation's associated authentication records before applying existing origin checks. No global scan of unrelated records for proxy-enabled sessions. Non-proxy behavior remains unchanged.
7. On close, release the ownership only after cleanup. Reopening resolves the same registry assignment.

Do not rely on the currently generated installer probe's `JSON.stringify(config)` for secrets. The probe must not resolve credentials, create sessions, advance the cursor, or leak secrets. Separate static configuration validation from any explicitly requested proxy-enabled qualification.

## 7. Routing, diagnostics, and redaction

Audit all task and login network paths, including navigation, popups, page `fetch`, browser download events, authenticated retrieval, and media saves. Confirm which requests use the browser context rather than Node's network stack; route or reject every supported path. Ensure proxy authentication reaches the proxy only, never the destination. Do not promise OS-wide fail-closed behavior: document qualified surfaces and known DNS/WebRTC limitations.

Maintain separate internal and public representations. Public status may include `{ enabled, session, generation, proxyId, routing: "configured" }`; it is configuration evidence, not exit-IP verification. Wrap Playwright, network, CLI, and filesystem errors at boundaries so credentials and endpoint details cannot leak. Test redaction with deliberately distinctive test secrets, including launch errors and installer diagnostics.

Classify connection/tunnel failures and HTTP 407 as proxy failures where observable; distinguish target access denial where evidence supports it. Preserve unknown outcome semantics when a dispatched action is interrupted. Never automatically retry, rotate, bypass, or relax TLS checks.

## 8. Testing and qualification

Add local fixtures for an authenticated HTTP forward proxy, CONNECT tunnels, destination servers, and controlled failures. Exercise both success and failure without depending on third-party proxy or IP-check services.

Required coverage:

- Config schema, URL validation, credential safety, secret redaction, and compatibility without proxies.
- Cursor order, wraparound, restart persistence, pool reorder/removal/endpoint change, concurrent allocations, interrupted writes, corrupt registry, and stale/ambiguous locks.
- Generation and ownership races, active rotation rejection, login handoff, and helper surviving owner failure.
- Login and later browsing through the same proxy; explicit auth bindings and rotation behavior; origin scoping and verification remain intact.
- HTTP and HTTPS CONNECT, credentials not forwarded to destinations, tabs/frames/popups, uploads, download and media paths, and proxy-down direct-connection checks.
- 407 and target denial classification; interrupted non-idempotent actions are not replayed.
- Staged install/update inventory, read-only installer probes, no rotation on status, and existing transfer and authentication regressions.

Run `npm test`, `npm run test:controller`, and `PROMETHEUS_TEST_BROWSER_CHANNEL=chrome npm test`. Qualify Linux headless and virtual-display, plus macOS when available. Document engine and Playwright/browser versions; unavailable configurations are unverified. Include explicit provider-side rotating-IP limitations in operational guidance.

## 9. Delivery sequence

1. Add validation, credential handling, registry, locking, and focused tests.
2. Add session CLI, ownership and generation semantics, with concurrency tests.
3. Integrate managed task launch and sanitized status.
4. Integrate login handoff and explicit authentication bindings.
5. Audit transfers, failure handling, and redaction with local proxies.
6. Update installer inventory, documentation, and staged-install tests; run the full regression matrix.
7. Deploy only on separate authorization after active browser tasks and login helpers are stopped.
