# Prometheus Qualification Context

Status: Mechanics verified. First-release qualification remains incomplete.
Snapshot date: 2026-10-16. The original baseline and the later harness checks are distinct snapshots.

## Current follow-up: qualification harness

| Suite | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Controller and qualification mechanics | 109 | 0 | 0 |
| Installed native integration | 13 | 0 | 0 |
| Browser regression | 50 | 0 | 3 |
| **Total** | **172** | **0** | **3** |

- Source fingerprint: `2efd967eac5294efdb4541545ab956c7c29d11974c3b226fc0a367ce275f5683`.
- Manifest: 89 runtime, test, lock, specification, and relevant control files.
- Environment: macOS 26.6.2, Node v24.15.0, npm 11.12.1, and the supported OpenCode 2.0.29 service.
- Raw reports, the manifest, package inventory, and the pre-repair observation remain private under `.prometheus-local/qualification-mechanics-2a63t9my/`.
- Paid model requests: None. Native model responses came only from local scripted providers.

The harness now supports multi-turn Plan and Build workflows, declared human decisions, expected pauses, independent checks, and ordinary-Build comparisons.
Admission binds the runtime, fixtures, reference examples, and procedures. Each campaign loads a fresh protected runtime copy.
One durable campaign allowance covers all metered sessions and both comparison arms. Reviewed follow-ups carry earlier consumption.
Tests cover controlled candidate defects, same-worker repair, native reply auditing, unexpected rescue, cancellation, and unconfirmed prior effects.
Controlled loopback destinations retain effects after a reply is disconnected or held. Recovery does not replay them.

New regressions exposed a retained-worker capability gap before repair.
The controller now checks the current native mode. Plan processes cannot write product files or request network access.
The installed suite verifies this worker-mode switch and cancellation during evaluation.

These results establish mechanics, not real-model judgment or a completed performance comparison.
The three browser display skips remain unchanged.
Use [the evidence map](QUALIFICATION-MATRIX.md) and [the runner reference](../packages/prometheus/qualification/README.md) for remaining gates and repeat procedures.

## Original tested snapshot

- Package: `opencode-prometheus` version `0.1.0`, experimental and private.
- Repository base: `6222bb85794ab3e751cf71ffd698004c10f27ad9`.
- Candidate: The uncommitted implementation recorded by the archived source manifest.
- Source fingerprint: `ab6c9499550ebccde4433b3d779851e98ff933ef76ea557142bec3955284f06f`.
- Manifest coverage: 30 files, including runtime code, qualification tools, tests, fixtures, dependency lock, and license.
- Host: macOS 26.6.2, build 25G83. Process backend: `sandbox-exec`.
- Tools: Node v24.15.0, npm 11.12.1, and OpenCode 2.0.29.
- Paid model requests: None.

## Original recorded results

| Suite | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Browser regression | 50 | 0 | 3 |
| Controller mechanics | 73 | 0 | 0 |
| Installed native integration | 6 | 0 | 0 |
| **Total** | **129** | **0** | **3** |

The three browser skips require virtual-display facilities absent from this macOS host.
They do not establish Linux display coverage.

## What the evidence establishes

- The packaged extension loads. Command collisions preserve user definitions. Children retain inherited permission denials.
- A fresh worker excludes the originating conversation. Independent rejection returns repair to that same worker. Fresh evaluation identifies the repaired candidate.
- Plan records pending experiments without product writes. Explicit Build continuation performs investigation, not product implementation.
- The scripted discovery sequence preserves decisions, Plan preparation, and natural-language execution as separate steps.
- Cancellation blocks acceptance. Stop records distinguish requested cessation from confirmed cessation.
- Crash recovery preserves consumption and unknown process outcomes. Location activation does not replay the uncertain operation or replace the worker.
- Fault tests cover transactions, ownership, duplicate dispatch, forged fields, cancellation races, stale acceptance, and lost completion messages.
- Capture tests preserve concurrent user edits. Declared validator source changes invalidate earlier readiness evidence.
- Boundary tests cover protected files, credentials, external paths, hardlinks, symlink escapes, and the macOS Data-volume alias.

Native tests use isolated services, configuration, storage, and a local scripted provider.
They do not restart the shared service or change global configuration.
Scripts supply the model's choices. Passing scripts do not establish real-model judgment or unattended reliability.
Boundary tests do not certify every operating-system or network attack.

## Integration findings to preserve

- Local plugin directories need a root entrypoint.
- Command lists use a `data` envelope. Native session context returns an array.
- The missing-session error tag is `Session.NotFoundError`.
- Concurrent stop paths must not repeatedly signal the same owned process group.
- Recovery starts after location activation, not merely after service restart.
- Native interruption reports active execution, not an already-idle originating session.
  Submit “Pause the goal” or interrupt the worker when the origin is idle.

## Remaining release gates

Real-model discovery, ambiguous goals, validator-only behavior, and general repair reliability remain unqualified.
The ordinary-Build comparison remains pending. Required live outcomes still need external evidence.
Other OpenCode versions and process platforms remain unsupported.
The evaluator must still judge validator coverage and controlled examples.

Obtain the user's model choice and aggregate allowance before paid qualification.
Follow [the qualification procedure](QUALIFICATION.md) for scenarios, comparison conditions, and release gates.
Retain failures, consumption, and human interventions. Do not classify a rescued run as unattended success.
The complete first-release scope in [SPEC.md](../SPEC.md) remains unchanged.

## Repeat mechanics

Run these commands from the repository root:

```sh
npm ci
npm ci --prefix packages/prometheus
npm test
npm run test:controller
npm run test:controller:native
```

Native integration tests require OpenCode 2.0.29. Process-boundary tests require macOS.
New results apply only to the source and environment that the new run records.
Keep private runtime data and raw qualification output outside Git, or under the ignored `.prometheus-local/` directory.
Review evidence before publication.

## Original evidence archive

[Download the evidence archive](archives/qualification-2026-10-16.tar.gz).
Archive SHA-256: `74df9b9492590fa1fba408d0388bebfb79583e27adcbbe16d50337b91a593405`.

The archive preserves the original five files without content changes:

- `qualification/2026-10-16-browser.tap`
- `qualification/2026-10-16-controller.tap`
- `qualification/2026-10-16-native.tap`
- `qualification/2026-10-16-source.json`
- `qualification/2026-10-16-mechanics.md`

It contains no host ownership names or extended attributes.
Extract it into an owned temporary directory when detailed evidence is necessary.
The source manifest retains its original fingerprint and individual file hashes.

Writing follows ASD-STE100 sentence conventions. Full dictionary conformity is not verified.
