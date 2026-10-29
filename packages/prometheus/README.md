# OpenCode Prometheus

Prometheus provides `/spike`, `/grill-me`, record storage, and independent verification.
OpenCode provides `/goal`, tool execution, permissions, cancellation, and continuation.

## Compatibility

Require stable OpenCode **>=2.2.1 <3.0.0**.
The package metadata declares this policy. The plugin and client dependencies are pinned to 2.2.1.
An accepted version is not a claim that every release passed integration checks.

There is no custom process runner or macOS requirement.
Native tools run on the platforms supported by OpenCode and the selected tools.

## Installation

From the repository root:

```sh
npm ci --prefix packages/prometheus --ignore-scripts
```

Add the package directory to your OpenCode V2 configuration. Preserve unrelated settings.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/prometheus/packages/prometheus"]
}
```

OpenCode reloads plugins after a configuration change. Use `/reload` if needed.
Check plugin status. Loading this package must not replace the built-in `/goal`.
For a packaged installation, use `npm pack`, extract the archive, and configure its `package` directory.

## Commands and tools

- `/spike <question>`: investigate in the current native session.
- `/grill-me [instructions]`: resolve consequential user decisions.
- `prometheus_record`: record a finding or decision, or read records with `status`.
- `prometheus_verify`: request verification with `start`, report evaluator results with `report`, or inspect `status`.

Commands preserve attachments, delivery, agent, model, and permissions.
They do not start implementation or invoke native `/goal`.
Native `/goal <objective>` requires an explicit objective. It owns pause, resume, and clear.

Example verification tool input:

```json
{
  "action": "start",
  "data": {
    "criteria": [
      {"id": "tests", "description": "The agreed behavior passes the project tests.", "validator": "Run npm test and inspect its results."}
    ]
  }
}
```

Start requires Build and native subagent permission. Candidate hashing requires native read permission.
The evaluator inherits session restrictions. It gets a fresh conversation and uses normal tools.
A pass must cite completed native tool results from the evaluator's own session.
Acceptance remains an evaluator judgment. A successful tool call does not by itself prove the criterion.
The verification tool waits for the native evaluator. It does not run its own continuation loop.

Reports remain available through `status` if notification delivery fails.
Reports do not automatically resume the origin or dispatch repairs.
After interruption or reload, request a new verification explicitly.

## Candidate and permission limits

Verification hashes the current workspace. It does not copy it into an isolated sandbox.
The manifest excludes `.git`, `.opencode`, `node_modules`, `.env`, `.env.*`, and `.DS_Store`.
Excluded files and external outcomes need separate evidence.
Hashes detect changed files; they do not prevent changes or establish operating-system isolation.
Native permissions remain authoritative for tools and delegation.
The evaluator is instructed not to edit files, but there is no plugin-owned read-only process boundary.

## Migration from 0.1

1. Stop old controller work and inspect any uncertain external effects before changing the active installation.
2. Install this version. Prometheus no longer registers `/goal` or `prometheus_control`.
3. Remove obsolete plugin options `stateDirectory`, `limits`, and `protectedPaths` from configuration when convenient.
4. Use `prometheus_record` with `status` to read migration information.
5. Start new work through normal native prompts or native `/goal <objective>`.

Old controller databases and artifacts are not opened or changed at plugin startup.
Old runs do not resume, and old allowances do not authorize new work.
New records use native plugin storage. There is no automatic conversion of old run states.

To inspect a specific old database directory without changing it:

```sh
node src/admin.mjs inspect /absolute/path/to/legacy/project-state
```

The old `grant` operation and campaign manifests are retired.
Native `/goal` has its own continuation limits. This plugin no longer supplies aggregate request,
cost, deadline, or process-isolation guarantees for execution.

## Verification

```sh
npm test
npm run test:native
npm run qualification:catalog
```

Native tests use isolated services and local scripted responses, not paid models.
They establish integration mechanics, not real-model reliability.
See [qualification](qualification/README.md) for the remaining live checks.
