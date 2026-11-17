# OpenCode Prometheus package

Use Prometheus to investigate questions, clarify decisions, and verify candidates with OpenCode V2.
It provides `/spike`, `/grill-me`, `prometheus_record`, and `prometheus_verify` under the [GPL-3.0-only license](../../LICENSE).

## Compatibility and installation

Use stable OpenCode **>=2.2.1 <3.0.0** and Node **>=22.22.2 <25**.
The package pins `@opencode/plugin` and `@opencode/client` to `2.2.1`.

1. From the repository root, install dependencies:

   ```sh
   npm ci --prefix packages/prometheus --ignore-scripts
   ```

2. Add the package path to `opencode.json` or `opencode.jsonc`:

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": ["/absolute/path/to/prometheus/packages/prometheus"]
   }
   ```

3. If necessary, run `/reload` in OpenCode. Check that `/spike` and `/grill-me` are available.

To install from an archive, run `npm pack` in the package directory and extract the archive. Run `npm install --omit=dev --ignore-scripts` in the extracted `package/` directory, then register its absolute path as above.

## Commands and tools

- `/spike <question>` investigates with permitted native tools in the current session.
- `/grill-me [instructions]` helps resolve decisions that affect the result or permitted work.
- `prometheus_record` stores or reads records without executing work.
- `prometheus_verify` requests independent verification without starting a goal or repair loop.

### Record inputs

| Action | Data |
| --- | --- |
| `finding` | `{ observations, interpretation, limitations, outcome: "supported" \| "disproved" \| "inconclusive" }` |
| `decision` | `{ decision, rationale }` |
| `status` | `{}` |

### Verification inputs

| Action | Data |
| --- | --- |
| `start` | `{ criteria: [{ id, description, validator? }] }` |
| `report` | `{ verificationID, results: [{ id, status: "pass" \| "fail" \| "unresolved", explanation, evidence: [{ messageID, toolCallID }] }] }` |
| `status` | `{ verificationID? }` |

`start` requires Build, `subagent` permission, and `read` permission.
See the [runtime reference](../../docs/PROMETHEUS.md) for manifest exclusions, evidence rules, and interruption behavior.

## Migration from 0.1

1. Stop active v0.1 controller runs.
2. Install v0.2.
3. Remove obsolete `stateDirectory`, `limits`, and `protectedPaths` plugin options when convenient.
4. Start new work with native prompts or native `/goal <objective>`.
5. To inspect historical v0.1 SQLite records, run this read-only command from the repository root:

   ```sh
   node packages/prometheus/src/admin.mjs inspect /absolute/path/to/legacy/state
   ```

## Verification commands

Run these commands from the package directory:

```sh
npm test
npm run test:native
npm run qualification:catalog
```

See the [verification guide](../../docs/VERIFICATION.md) for required scenarios and live-model procedures.
