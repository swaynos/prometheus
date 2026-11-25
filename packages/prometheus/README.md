# OpenCode Prometheus package

Use Prometheus to investigate questions, clarify decisions, and verify candidates with OpenCode V2.
It provides `/spike`, `/grill-me`, `prometheus_record`, `prometheus_verify`, and the `project-check-in` skill under the [GPL-3.0-only license](../../LICENSE).

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

The package includes `skills/project-check-in/SKILL.md` and registers it with OpenCode when the plugin loads. No separate copy or skills configuration is needed. Unloading Prometheus removes its registration, not saved check-ins. An existing user or project skill with the same ID takes precedence and is not changed.

## Project updates

Ask for a project check-in or project update, or mention `@project-check-in`. The skill answers four questions in order:

1. What is the goal?
2. Where do we measure against that goal?
3. What remains against the goal?
4. How do we measure what remains?

It names measurement sources and separates verified results from plans, unknowns, and untested work. When permitted, each run saves a new `YYYY-MM-DD-HHMMSS-project-check-in.md` using the user's local time and chosen or established documentation location. Numeric suffixes prevent collisions. On request, it appends a uniquely timestamped section to an existing Markdown file. Earlier check-ins are preserved. The skill does not start project work or change task or reminder state.

The skill does not run tests, builds, project commands, or application code to produce a check-in. It reports existing evidence and describes how to measure unverified work. In Plan, read-only, or permission-denied contexts, it must not try another tool, agent, path, or method to bypass the restriction: it provides the update in the conversation when possible and clearly says it was not saved. If the project, destination, or local time zone is unclear, it asks rather than guessing. It reports a saved path only after the write succeeds and the resulting content is verified.

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
