# Native runtime reference

## Architecture

```text
/spike or /grill-me
  -> native session.prompt
  -> current Plan or Build session
  -> native tools and permissions
  -> findings and decisions

native /goal <objective>
  -> OpenCode continuation and review

prometheus_verify start
  -> native permission admission
  -> candidate identity and criteria
  -> fresh native evaluator
  -> completed native tool evidence
  -> durable report and non-resuming notice
```

Prometheus does not replace normal tools, spawn shell processes, or drive a repair loop.
It does not switch the originating agent. A preparation command does not approve implementation.
OpenCode handles native tool execution, permission denial, cancellation, and goal continuation.

## Records

Native plugin storage keys use a `v2/` prefix:

- `session/<sessionID>`: findings and decisions. These are model reports.
- `verification/<verificationID>`: criteria, candidate manifest, evaluator identity, state, and report.
- `latest/<sessionID>`: the latest verification for an origin or evaluator.
- `evaluator/<sessionID>`: the verification assigned to a fresh evaluator.

Concurrent writes to one session's records are serialized within the plugin instance.
No controller database, process identity registry, or executable budget ledger is created.

## Verification

Start requires a native Build origin at the plugin's location.
The plugin requests native `subagent` permission for a Build evaluator.
It requests native read permission before hashing candidate file contents.
The child inherits the origin's model, location, and session permissions.
It receives the criteria and manifest, not the originating conversation.
The verification tool waits through the native session API. Native goal review does not run while that tool is pending.

The evaluator can use normal native tools. It cannot report a pass based only on model-written claims.
Each evidence reference identifies a completed native tool call in its own conversation.
The report retains the original input, content, metadata, and a content hash.
The context hook supplies evidence identities. It does not hide or replace native tools.

The evaluator reports each criterion exactly once. A denied or unavailable required check is unresolved.
All required criteria must pass for an accepted report.
This structural check does not prove that the evaluator selected sufficient evidence. Real-model checks remain necessary.

The report is saved before notification. Notification uses `resume: false`.
If notice delivery fails, the report and delivery error remain available through status.
The origin repairs defects with native tools. A new independent check requires a new request.
If the evaluator finishes without a report, the verification becomes unresolved. It does not restart.

## Candidate identity

The manifest hashes files in the current workspace, including untracked files.
It excludes `.git`, `.opencode`, `node_modules`, `.env`, `.env.*`, and `.DS_Store`.
It rejects external or absolute symlinks, unsupported entries, and files with multiple hardlinks.

The evaluator does not receive an isolated or guaranteed read-only workspace.
File checks detect differences before acceptance and when accepted status is read later.
They cannot prevent writes or detect every temporary change between checks.
Excluded files, dependencies, external systems, and remote deliverables need separate evidence.
Do not describe this design as a process sandbox.

## Interruption and reload

Pending verification observes native interruption, failure, and session-deletion events.
It marks the request interrupted and asks OpenCode to interrupt the owned evaluator.
It does not stop unrelated sessions or private process groups.
Cleanup disposes registrations and stops owned pending evaluators.
Late reports cannot be accepted after interruption or by another plugin instance.

After reload or service restart, pending records remain available but cannot resume automatically.
Status identifies an old pending request as interrupted. Request a new verification when ready.
Lost admission receipts are not replayed automatically.

## Legacy data

The old custom controller, process runner, and sandbox have been removed.
Startup does not open old databases or enforce their state-directory boundary.
Old state inside a home or project directory cannot prevent plugin loading.
Legacy options do not grant execution authority or apply old budget limits.
Use the read-only `src/admin.mjs inspect` operation for historical records.

See the [package migration instructions](../packages/prometheus/README.md#migration-from-01).
The separate browser runtime and its human-invoked workflow remain unchanged.
