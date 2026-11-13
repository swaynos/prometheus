# Browser Proxy Pool Specification

**Status:** Proposed; not implemented.

**Associated design:** [Browser Proxy Low-Level Design](BROWSER-PROXY-LLD.md).

## 1. Purpose

Allow the managed Prometheus Browser to use a user-configured pool of proxies. A named browser session receives one proxy in round-robin order and retains it across browser closures, runtime restarts, and extended inactivity. Login, subsequent browsing, and supported browser-mediated transfers use that same assignment.

This specification describes a planned addition. Existing browser tools, authentication safeguards, file-transfer validation, and non-proxy behavior remain in force.

## 2. Scope and terminology

- **Proxy pool:** An ordered list of uniquely identified proxy endpoints in browser configuration.
- **Browser session:** A persistent, user-named routing identity; it is not an OpenCode conversation, browser process, tab, or login record.
- **Generation:** A version of a browser session's proxy assignment. Explicit rotation starts a new generation.
- **Authentication record:** Existing private, origin-scoped saved login state. It is separate from the browser session and must be explicitly associated with a proxy-enabled session.
- **Assignment:** The proxy ID and endpoint identity pinned to a particular session generation.

Initial protocol support is HTTP proxies, with optional username/password authentication, including HTTPS destinations via HTTP CONNECT. HTTPS-to-proxy transport and SOCKS5 are out of scope until separately qualified. Proxying is optional globally, but mandatory for a session configured to use a proxy.

## 3. Functional requirements

### 3.1 Pool and selection

1. The user configures an ordered list of proxies with stable, unique IDs. Credentials are stored separately from ordinary browser settings.
2. Creating a browser session atomically assigns the next pool member and advances the persistent cursor. For `[A, B, C]`, successive allocations are A, B, C, A.
3. Allocation is reserved even if a subsequent browser launch fails. Concurrent allocations must not lose or duplicate cursor updates, although wraparound can intentionally assign the same proxy to different sessions.
4. Reopening a session reuses its assignment; browser closure, process restarts, elapsed time, tabs, requests, navigation, and login do not advance the cursor.
5. Only explicit session creation or rotation advances the cursor. Rotation assigns the next proxy and creates a new generation; it is refused while the session has an active owner or login helper.
6. Reordering or extending the pool does not change an existing assignment. Removing the assigned proxy or changing its endpoint makes the session unavailable until explicit reconciliation or rotation. Credential replacement is allowed on the next launch without rotation.
7. No operation silently skips an unhealthy proxy or falls back to a direct connection.

### 3.2 Session and authentication lifecycle

1. A proxy-enabled task browser selects a named session before starting. The selected generation remains fixed for its lifetime.
2. A login helper joins the task session via an explicit handoff and uses the same assignment. It does not consume another proxy.
3. Saved authentication and proxy assignments remain separate. Proxy-enabled sessions restore only explicitly associated authentication records, and only for their approved origins; all existing origin and verification safeguards apply.
4. Rotation does not automatically carry authentication associations into the new generation. An explicit retention option may carry the associations, with a warning that the changed route may require renewed verification. Rotation never deletes or rewrites saved cookies.
5. Existing saved records are preserved. Enabling proxies requires explicit association before those records can be restored in a proxy-enabled session.
6. Closing a browser releases runtime resources but neither deletes a session nor rotates its proxy.

### 3.3 Routing and safety

1. The selected proxy is used for supported managed task browsers, login windows, tabs, frames, popups, and browser-mediated transfers. Every transfer implementation must be audited; a path that cannot honor the route must fail rather than bypass it.
2. Proxy-enabled automatic login must not use the existing CDP shortcut unless its routing is qualified. Initial support uses a managed launch. Proxy configuration with external CDP is rejected.
3. Proxy credentials, endpoints, and sensitive connection details must not appear in public status, logs, errors, generated probes, or model-facing output. Status may show the session, generation, proxy ID, and that routing is configured; it must not claim proof of the public exit IP.
4. On proxy connection failure or HTTP 407, report the failure and retain the assignment. On target 401/403 or challenge, preserve existing access-denial rules. Do not rotate to bypass denial.
5. An interrupted non-idempotent action has an unknown outcome: inspect before any retry. Do not automatically replay actions, change route, or weaken TLS verification.
6. Do not contact a public IP-check service automatically. Any external verification endpoint requires explicit approval.

## 4. Interface and operations

Provide explicit commands to create, list, inspect, and rotate named browser sessions and to bind authentication records. Commands display only sanitized metadata. A session is selected by configuration; changes to that selection do not mutate a running browser.

The registry and credentials live outside repositories in owner-only storage. Rotation state survives restarts and is updated atomically with bounded concurrency control. Unsafe files, invalid configuration, corrupt state, and ambiguous ownership stop the operation; none authorize direct routing or silent recovery.

Installer probes, validation, status, and list commands do not allocate a session or advance rotation. Installation and deployment are separate from implementation; stop active browser tasks and login helpers before staged deployment and restart.

## 5. Acceptance criteria

- A session can log in, close, reopen days later, and browse through the same configured proxy assignment.
- New sessions follow round-robin order across restarts and concurrent allocation; explicit rotation advances once and changes generation.
- Proxy failure cannot cause a direct connection, automatic proxy switch, or replay of a submission within supported paths.
- Login and task browsing use the same generation; unassociated saved authentication is not restored.
- Credentials do not appear in model-facing output, errors, logs, or installer probes.
- Existing non-proxy workflows and their tests continue to pass.
- Controlled fixtures verify browser routing, authentication, CONNECT, transfers, failure handling, and staged installation. Linux and macOS qualification is reported separately; unavailable configurations are unverified, not passing.

## 6. Limits and non-goals

This is not an OS-wide network sandbox or a guarantee about every DNS, WebRTC, extension, or browser networking surface. A configured endpoint does not guarantee a stable public IP: a provider can rotate exits or expire sticky sessions. Document known engine-specific limitations and do not claim leak-proof routing.

Timed or per-request rotation, health-based failover, geographic selection, provider APIs, fingerprint changes, public IP checks, external-CDP proxy support, SOCKS5, and HTTPS proxy transport are out of scope for the initial release.
