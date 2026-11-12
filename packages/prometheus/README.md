# OpenCode Prometheus Package

Prometheus adds `/spike`, `/grill-me`, `prometheus_record`, and `prometheus_verify` to OpenCode V2.
Licensed under [GPL-3.0-only](../../LICENSE).

## Compatibility and Installation

Require stable OpenCode **>=2.2.1 <3.0.0** and Node **>=22.22.2 <25**.
`@opencode/plugin` and `@opencode/client` are pinned to `2.2.1`.

```sh
npm ci --prefix packages/prometheus --ignore-scripts
```

Add the package path to `opencode.json` or `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/prometheus/packages/prometheus"]
}
```

Run `/reload` in OpenCode if needed. For a packed archive, run `npm pack`, extract `package/`, and register that directory.

## Commands and Tools

- `/spike <question>`: investigate with permitted native tools in the current session.
- `/grill-me [instructions]`: resolve consequential user decisions.
- `prometheus_record`:
  - `finding`: `{ observations, interpretation, limitations, outcome: "supported" | "disproved" | "inconclusive" }`
  - `decision`: `{ decision, rationale }`
  - `status`: `{}`
- `prometheus_verify`:
  - `start`: `{ criteria: [{ id, description, validator? }] }` (requires Build, `subagent`, and `read` permissions)
  - `report`: `{ verificationID, results: [{ id, status: "pass" | "fail" | "unresolved", explanation, evidence: [{ messageID, toolCallID }] }] }`
  - `status`: `{ verificationID? }`

See the [runtime reference](../../docs/PROMETHEUS.md) for manifest exclusions, evidence rules, and interruption behavior.

## Migration from 0.1

1. Stop active v0.1 controller runs.
2. Install v0.2. Remove obsolete `stateDirectory`, `limits`, and `protectedPaths` plugin options when convenient.
3. Start new work with native prompts or native `/goal <objective>`.
4. Inspect historical v0.1 SQLite records in read-only mode:

```sh
node packages/prometheus/src/admin.mjs inspect /absolute/path/to/legacy/state
```

## Checks

```sh
npm test
npm run test:native
npm run qualification:catalog
```

See the [verification guide](../../docs/VERIFICATION.md) for scenarios and live-model procedures.
