# Scenario runner

This is an operator tool, not a Prometheus command or agent.
It collects observations. It does not certify a complete release.
The commands below retain the `qualification/` implementation path.

## Admission

Obtain the user's model choice and aggregate allowance before paid work.
Use `example.json` for a small smoke test.
Use `campaign.example.json` for paired execution, validator-only, and Plan-preparation examples.
Use `discovery.example.json` for an interactive discovery sequence and controlled independent rejection.
Replace every `CHOOSE_...` value. Example values are not user authorization.
The example campaign does not cover the full required scenario catalog.

Inspect admission without service access, output writes, or model requests:

```sh
node qualification/run.mjs --manifest /absolute/path/to/manifest.json
```

The fingerprint binds the manifest bytes, runtime source, package metadata, fixtures, reference examples, and independent checks.
A relevant change invalidates that fingerprint.
After approval, execute against an existing authenticated service that satisfies the [package compatibility policy](../README.md#compatibility):

```sh
node qualification/run.mjs --manifest /absolute/path/to/manifest.json --approval THE_FINGERPRINT --output /absolute/path/to/new-results
```

The output directory must not exist. Keep it outside the installed package.
The runner does not start or restart a service, change global configuration, run install scripts, commit, or publish.
It creates a fresh campaign-local runtime copy to avoid cached checkout modules.
That copy uses the package's installed, pinned dependencies. Install them with `npm ci` before execution.
Workers cannot change the runtime, campaign state, independent checks, or reference fixtures.

Preflight verifies the service version, loaded packages, command ownership, and model availability before model work.
The metering plugin is a separate local package because OpenCode deduplicates local package registrations.

## Manifest fields

Paths are relative to the manifest file unless they are absolute.
Moving a manifest requires correcting or preserving those paths.

| Field | Meaning |
| --- | --- |
| `version` | `2`. The original single-prompt shape also remains supported. |
| `model` | Explicit `providerID`, `id`, and optional `variant`. No credentials or provider settings. |
| `maxRequests` | One total allowance across all cases, arms, children, auxiliary requests, retries, and uncertain reservations. |
| `timeoutMs` | Aggregate active verification duration. All case setup, checks, interaction waits, and model work consume it. |
| `maxUSD` | Optional observed-cost estimate limit. It is not a billing guarantee. |
| `evidenceClass` | `real-model`, or `scripted-native` for a declared scripted provider. The field records the declared evidence source. |
| `previousCampaign` | Optional prior output directory. A reviewed follow-up carries its consumed requests, observed cost, and active verification duration. Totals do not reset. |
| `cases` | Ordered, named scenarios. |

Each case has:

| Field | Meaning |
| --- | --- |
| `name` | Unique safe name using letters, digits, `_`, or `-`. |
| `fixture` | Owned project source. Credentials, symlinks, hardlinks, Git data, dependencies, and ambient OpenCode configuration are rejected. |
| `oracleFixture` | Independent-check source. Defaults to the project fixture for the original smoke-test format. |
| `arm` | `prometheus` by default, or `build` for ordinary Build without Prometheus. |
| `agent` | Initial `plan` or `build`; defaults to `build`. |
| `maxRequests`, `timeoutMs` | Optional smaller case limits. They cannot enlarge the campaign limits. Comparison arms need equal explicit allocations. |
| `permissions` | Declared native session rules. Existing native denials remain effective. |
| `steps` | Explicit interaction sequence. Without it, the runner records `prompt`, invokes `/goal` for Prometheus, and waits for completion. |
| `expect.states` | Allowed terminal product states. Defaults to `Accepted`, or `Unenrolled` for ordinary Build. A safety case can expect `Draft` or `Paused`. |
| `expect.checks` | Additional final checkpoint assertions. |
| `expect.completionClaim` | Optional declared rubric for an ordinary-Build completion claim. Without it, false-acceptance measurement is `null`, not a claimed zero. |
| `oracles` | Nonempty executable argument arrays. No implicit shell expansion. |
| `failureCodes` | Declared product-failure exit codes; defaults to `[1]`. Zero means pass. Interruption or other codes mean unresolved infrastructure evidence. |
| `readiness` | Controlled `{ fixture, exitCode }` examples. Every independent check must return that expected code before model work. |
| `references` | Named immutable fixtures for independent checks. Reference directory basenames are randomized. |
| `observeFiles` | Explicit project files to include in snapshots. Files over 16 KiB retain hashes and sizes, not text. |
| `scenarios` | W01–W19 catalog tags. Tags are an index, not proof of suitable checks. |
| `candidateFault` | Optional one-time `{ path, content, reason }` stimulus immediately before a worker's candidate capture. It cannot change governing controls. |
| `pair`, `comparison`, `agreement` | Comparison identity, `execution` or `discovery`, and the exact shared first user prompt. |

## Steps

Steps can target `origin`, `worker`, or `evaluator`. The default is `origin`.
Targets must exist. Each step records intent, outcome, and timestamps.

| Type | Additional fields and behavior |
| --- | --- |
| `prompt` | `text`; optional `resume: false` records context without starting generation. |
| `command` | `name`: `spike`, `grill-me`, or `goal`; optional `text`. Ordinary-Build cases cannot use this step. |
| `agent` | `agent`: `plan` or `build`. This step does not supply execution intent. |
| `wait` | `checks` and/or `idle: true`; optional `timeoutMs`, `stableMs`, and `save`. |
| `check` | Evaluate `checks` immediately; optional `save`. |
| `interrupt` | Interrupt only the selected owned session. |
| `permission` | Match the exact `action` and ordered `resources`. Reply `decision: once` or `reject`. Never save a blanket approval. |
| `answer` | Match one exact native form `title`; supply its declared `answer` map. An ambiguous match is an error. |
| `human` | Await a declared native `request`: `form` or `permission`. Supply operator-only `instructions`. Permissions need the expected `action`; exact `resources` and a form `title` are optional selectors. The runner never answers for the user. |
| `mutate` | Apply a controlled fault to an owned relative `path`, with `content` and `reason`. It cannot alter verification controls. |

`participation` is `stimulus`, `decision`, or `rescue`.
Form, permission, and declared human replies default to `decision`. Other steps default to `stimulus`.
Unexpected native user messages or replies, operator grants, and declared rescue prevent an unrescued passing campaign.
Do not classify implementation help as a preference decision merely to change the result.
Unknown step fields fail admission instead of being silently ignored.
For a human step, wait for the runner's notice, open the identified native session, and answer there.
Use only one-time permission decisions. Persistent grants count as interventions in the recorded result.
The instructions go to the participant, not the model. This avoids prescribing a model's question wording.
An unanticipated or ambiguous interaction is unresolved evidence. The runner does not guess a reply.
Native auditing cannot identify every off-channel file edit. The operator must declare manual repair and other interventions.

A recorded product pause does not automatically resume while a checkpoint waits.
When a wait expects a pause, include `{ "path": "state", "equals": "Paused" }` explicitly.
An unexpected durable pause fails the checkpoint promptly.

## Checkpoints

Each check has a `path` and exactly one comparison: `equals`, `contains`, `min`, `max`, `exists`, or `sameAs`.
Use dotted paths for ordinary fields. Use JSON Pointer paths for keys that contain dots or slashes.

```json
[
  { "path": "state", "equals": "Draft" },
  { "path": "changedFiles", "equals": [] },
  { "path": "counts.workers", "equals": 0 },
  { "path": "workerID", "sameAs": "checkpoints.started.workerID" },
  { "path": "/files/greeting.txt/text", "equals": "hello" }
]
```

`save: started` stores the observed snapshot for later comparisons.
Useful fields include `state`, `intent`, `specificationID`, `candidateID`, `workerID`, `evaluatorID`, `goal`, `changedFiles`, and `files`.
Counts include workers, evaluators, findings, decisions, spikes, evaluations, rejections, and uncertain actions.
`native` includes the agent, outcome, idle status, message references, and a bounded last-assistant excerpt.
The report does not duplicate the complete native conversation.

## Independent checks

Argument placeholders are:

- `{oracle}`: The immutable check directory.
- `{baseline}`: An immutable copy of the initial project fixture.
- `{reference:NAME}`: A named immutable reference.
- `{candidate}`, `{scratch}`, and `{project}`: Managed-process paths.

Checks run without network access against read-only candidate inputs.
Use owned scratch for outputs. The runner also checks candidate identity before and after each procedure.
Keep pass conditions aligned with the declared agreement. Do not hide extra requirements in test inputs.
Controlled examples do not establish complete fault coverage or validator suitability.
Candidate faults record intent and before/after hashes in the durable ledger.
They apply once, not on every repair. This is a declared test stimulus, not an execution attempt limit.
An uncertain fault outcome blocks further work rather than triggering another write.
Report controlled rejection separately from naturally occurring model errors.

The export fixture includes JSON/CSV behavior, CLI errors, retained regression checks, and a runnable-validator contract.
Its independent checks distinguish the controlled conforming example, incomplete product, validator-only delivery, and an always-passing validator.
`effects.mjs` supplies an owned loopback destination for fault tests. It records an effect before a reply is lost or held.
It does not contact production services or establish unrelated external outcomes.

## Comparison and resources

Paired arms must be adjacent. They must share the fixture, agreement, initial mode, checks, references, authority, request allocation, and duration.
The runner verifies that the remaining campaign allowance can fund both request allocations and durations before starting the pair.
A truncated or incomplete pair is not reported as comparable.
Run controlled faults separately from performance comparisons.
Scripted providers never establish a real-model comparison, even when the paired harness checks pass.

Both arms use bounded local file, search, question, and shell tools.
The campaign meter blocks external tools, arbitrary delegation, and unrestricted Code Mode in these owned fixtures.
Native Build keeps its ordinary agent loop. It receives no Prometheus continuation or evaluator feedback.
Its native shells receive the same declared macOS filesystem boundary and stripped environment.
This is not a comparison against unrestricted machine-wide Build authority.

The ledger reserves HTTP and WebSocket work before dispatch.
Fallbacks and uncertain requests can conservatively consume multiple reservations.
Fixed native titles prevent an ambient auxiliary-model choice in either arm.
No worker or evaluator can select a different model or enlarge the allowance silently.
Dispatch also checks the campaign owner's process identity, not only whether its PID exists.

## Failure, inspection, and follow-up

The runner retains partial reports and stops the campaign after a failed or unresolved case.
Interrupting the runner requests owned-session cessation. It does not terminate the shared service.
The stop report identifies its scope. Native idle state alone does not certify detached descendants or remote cessation.
Prometheus cases also inspect controller-recorded local process outcomes.
Unknown effects remain recorded. No operation is automatically replayed.

Inspect retained output without service access, model requests, or resumption:

```sh
node qualification/run.mjs --inspect /absolute/path/to/results
```

Inspection reads the saved report. It does not establish current remote activity.
Existing output cannot be overwritten or automatically resumed.
For a repaired candidate, prepare a new manifest with `previousCampaign` and the same approved aggregate totals, or explicitly approved new totals.
That manifest binds the prior report and carries its consumption into a fresh attempt directory.
Offline development time between attempts does not consume active verification duration.
Unconfirmed prior activity or unknown effects block this follow-up path. Reconcile them before further authorization; do not edit SQLite records to manufacture clearance.
Keep the previous report unchanged. A successful follow-up does not erase a failure or rescue.

`report.json` records source identities, checkpoints, executable receipts, native session references, consumption, participation, and paired measurements.
`complete` applies only to the declared campaign. `releaseQualified` remains false.
The full release still needs the requirement review, all mandatory scenarios and faults, and required external evidence.
Keep output private and review it before sharing.

Writing follows ASD-STE100 sentence conventions. Full dictionary conformity is not verified.
