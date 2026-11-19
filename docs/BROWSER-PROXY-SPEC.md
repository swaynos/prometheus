# Browser proxy pool specification

**Design:** [Proxy low-level design](BROWSER-PROXY-LLD.md).

## 1. Purpose

The managed Prometheus browser must support a user-configured proxy pool.
Round-robin selection assigns one proxy to each named session.
The session retains that assignment across browser closure, runtime restart, and extended inactivity.
Login, later task browsing, and supported browser-mediated transfers use the same assignment.

Existing tools, authentication safeguards, transfer validation, and direct-routing behavior remain in force.

## 2. Scope and terms

| Term | Meaning |
| --- | --- |
| Proxy pool | Ordered proxy identities from default `<config_dir>/proxies.txt` or an explicit legacy JSON pool |
| Proxy session | Persistent named route. Interfaces also call it a browser session. It is not a conversation, process, tab, or login record. |
| Generation | Version of a session assignment. Explicit rotation starts a new generation. |
| Authentication record | Private saved login state for approved origins. Association with a proxy session is explicit. |
| Assignment | Proxy ID and endpoint identity pinned to one session generation |

Initial support covers HTTP proxies, with optional username/password authentication.
HTTPS destinations use HTTP CONNECT.
HTTPS-to-proxy transport and SOCKS5 require separate qualification and remain outside scope.
Proxy support is optional, but routing through the assigned proxy is mandatory for every configured proxy session.

## 3. Functional requirements

### 3.1 Pool and selection

1. The primary input is `<config_dir>/proxies.txt`, normally `~/.config/opencode/proxies.txt`.
   Each line contains `HOST:PORT:USER:PASS`.
   The primary format must work without `poolFile`, a separate secrets directory, or individual credential JSON files.
   Require explicit `proxy.session` and `strategy: "round-robin"`.
   Without `pool`, select the text file.
   An explicit legacy JSON `pool` takes priority without reading the text file.
   Without `proxy`, retain existing direct-routing behavior.
2. Session creation must atomically assign the next member and advance the persistent cursor.
   For `[A, B, C]`, allocations follow A, B, C, A.
3. A failed later browser launch must not release that allocation.
   Concurrent allocations must not lose or duplicate cursor updates.
   Pool wraparound can intentionally assign one proxy to different sessions.
4. Reopening must reuse the assignment.
   Closure, restarts, elapsed time, tabs, requests, navigation, and login must not advance the cursor.
5. Advance the cursor only for explicit creation or rotation.
   Rotation consumes the shared global cursor and increments generation.
   Reject rotation while the session has an active owner or login helper.
   Other allocations can return the cursor to the session's current proxy.
   A single-member pool always selects the same proxy.
   Rotation must still apply generation and authentication-reset rules.
   It does not guarantee a different endpoint or exit IP.
6. Text-backed IDs must survive reordering and password changes.
   Different usernames on one canonical endpoint must have different identities.
   Removed identities or changed hosts, ports, or usernames must block the affected session until explicit reconciliation or rotation.
   Password replacement must apply at the next launch without rotation.
   Retain legacy ID and credential-update compatibility.
   Migration from handwritten JSON IDs requires explicit inactive-session and cursor reconciliation.
   Do not rewrite the registry automatically.
7. Operations must not silently skip an unhealthy proxy or use a direct connection instead.
8. The parser must accept:
   - Strict UTF-8 and optional initial BOM.
   - LF/CRLF, blank lines, and full-line `#` comments.
   - Hostnames, IPv4, and bracketed IPv6.
   - Literal colons in passwords.
   It must not trim or URL-decode credentials.
   It must reject malformed or empty records, control characters, invalid ports, duplicate identities, invalid UTF-8, and empty lists.
   Reject files above 1 MiB or 4096 entries.
   Diagnostics may identify line numbers, never record contents.

### 3.2 Session and authentication lifecycle

1. Before startup, a proxy-enabled task browser must select a named session.
   Its generation remains fixed for that browser's lifetime.
2. A login helper must join through an explicit handoff.
   It must use the task assignment without allocating another proxy.
3. Saved authentication and proxy assignments must remain separate.
   Restore only explicitly associated records for the selected generation and approved origins.
   Retain all existing origin and verification safeguards.
4. Rotation must clear authentication associations by default.
   Changed-ID or changed-endpoint reconciliation must do the same.
   An explicit retention option may preserve associations.
   It must warn that the changed route can require renewed verification.
   Rotation and reconciliation must not delete or rewrite saved cookies.
5. Enabling proxies must preserve existing saved records.
   Restoration into a proxy session requires explicit association.
6. Browser closure must release runtime resources without deleting the session or rotating the proxy.

### 3.3 Routing and safety

1. Supported managed task browsers, login windows, tabs, frames, popups, and browser-mediated transfers must use the selected proxy.
   Audit every transfer implementation.
   If a path cannot honor the route, it must fail instead of bypassing the proxy.
2. Proxy-enabled automatic login must not use the CDP shortcut without separate routing qualification.
   Initial support uses a managed launch.
   Reject proxy configuration with external CDP.
3. Public status, logs, errors, probes, and model-facing output must omit credentials, endpoints, and sensitive connection details.
   Status may show session, generation, proxy ID, and configured routing.
   It must not claim verified public exit IP.
4. On connection failure or HTTP 407, report proxy failure and retain the assignment.
   On target HTTP 401/403 or other challenge, inspect `lastDenial` (`retryable`, `suggestions`) and use `browser_rotate_proxy` if changing proxy; when a proxy is configured or user-requested, never bypass it to direct routing.
5. After an interrupted non-idempotent action, mark the outcome unknown.
   Inspect before any retry.
   Do not automatically replay actions, change routes, or weaken TLS verification.
6. Do not contact public IP-check services automatically.
   External verification endpoints require explicit approval.

## 4. Interface and operations

Provide explicit commands for creation, listing, inspection, rotation (CLI `rotate` when idle, or MCP `browser_rotate_proxy` which atomically closes the task context first), and authentication association.
Return sanitized metadata only.
Configuration selects the session.
Changes to selection must not alter an active browser.

### Read-only diagnostics

Provide a local `doctor` command for registry, assignment, credential safety, lock, and ownership checks.
It may validate proxy credential files privately, but must not return their contents or paths.
It must not:

- Read saved authentication values.
- Acquire locks or create files.
- Prune owners or repair state.
- Launch browsers or contact endpoints.

Return fixed codes and a nonzero exit status for detected errors.
Results describe a local snapshot, not verified connectivity, exit IP, or browser readiness.

### Storage and file safety

Registry and credentials must remain outside repositories in owner-only storage.
The default text list must be current-user-owned, regular, single-link, and not a symlink.
Require exact file mode `0600`.
The configuration root can have owner-controlled mode `0755`.
Require real ancestor directories with trusted ownership and no untrusted write access.
Permit root-owned sticky temporary ancestors.

Validate open descriptors.
After a bounded read, verify file and directory identities and metadata again.
Reject platforms that cannot enforce these properties.
Retain existing legacy credential-directory permission rules.

Rotation state must survive restart through atomic updates and bounded concurrency control.
Unsafe files, invalid configuration, corrupt state, or ambiguous ownership must stop the operation.
They do not authorize direct routing or silent recovery.

### Installation and static inspection

Installer probes, static validation, status, and list commands must not open the proxy list or allocate a session.
They must not advance rotation.
Lifecycle operations and generation checks resolve the list privately.
Explicit `doctor` validates it without network requests or repairs.

Never insert credentials into serializable configuration, IPC options, registries, probes, receipts, or reports.
Implementation is separate from deployment.
Before staged deployment, stop affected tasks and login helpers.
Reconnect the browser MCP afterward.

## 5. Acceptance criteria

- Login, closure, and later reopening retain the same configured assignment, including after days of inactivity.
- New sessions follow round-robin order across restart and concurrent allocation.
- Explicit rotation advances once and increments generation.
- Proxy failure cannot cause direct routing, automatic proxy switching, or submission replay on supported paths.
- Login and task browsing use the same generation.
- Unassociated saved authentication is not restored.
- Credentials do not appear in public output, errors, logs, or probes.
- Existing non-proxy workflows and tests continue to pass.
- Controlled fixtures verify routing, authentication, CONNECT, transfers, failures, and staged installation.
- Report Linux and macOS qualification separately. Unavailable configurations remain unverified.
- Diagnostics preserve contents, permissions, owners, and cursor, including for stale, unsafe, or corrupt state.
- Same-proxy and single-member rotations still increment generation and reset associations.
- Default text lists support browsing, login, authenticated HTTP/CONNECT, transfers, reopen/restart persistence, and failure without fallback.
- Text-list operation needs no individual credential JSON files.
- Parser and storage errors remain sanitized, including line-number diagnostics.
- Legacy JSON pools retain the same routing-fixture coverage.

## 6. Limits and non-goals

Proxy routing is not an OS-wide network sandbox and does not contain every DNS, WebRTC, extension, or browser network path.
A configured endpoint does not guarantee a stable public IP.
Providers can rotate exits or expire sticky sessions.
Document engine limits. Do not claim leak-proof routing.

Initial scope excludes:

- Timed or per-request rotation.
- Health-based failover.
- Geographic selection and provider APIs.
- Fingerprint changes and public IP checks.
- External-CDP proxy support.
- SOCKS5 and HTTPS-to-proxy transport.
