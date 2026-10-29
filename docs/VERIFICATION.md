# Verification guide

## Automated checks

From the repository root:

```sh
npm run test:controller
npm run test:controller:native
npm test
git diff --check
```

The controller script name is retained for compatibility. It now runs command, storage, artifact,
compatibility, and focused verification tests. There is no execution controller.

Native tests start owned OpenCode services with isolated homes, databases, and configuration.
They allow only a local scripted provider. They do not use user credentials or paid models.
They check the packed package, native `/goal`, Linux shell execution, permissions, and fresh evaluation.
Stop and clean up only the service and files owned by each test.

The browser integration suite remains separate. Browser instructions and profiles are not changed by this migration.

## Evidence classes

- Unit tests establish local contracts and fault handling.
- Scripted native tests establish integration mechanics with an exact OpenCode release.
- Real-model observations establish whether models follow the workflow and select sufficient evidence.
- Independent product checks establish whether a candidate meets the user's actual requirements.

Do not substitute one class for another. Record the tested OpenCode version and platform.
Do not describe a broad compatibility policy as a test matrix.

## Remaining qualification

The old campaign runner depended on the removed controller and sandbox. It is retired.
It rejects old manifests without contacting a service or model.
Fixtures and independent oracle programs remain as test assets.
See [native workflow scenarios](SCENARIOS.md) for the replacement observations.

Any live-model campaign needs a new approved procedure, model, resource allowance, and evidence destination.
Do not reuse the old aggregate-budget or process-isolation claims.
Native goal round limits are not an aggregate model-request or cost limit.

## Acceptance limits

Native permissions are not an OS sandbox. Candidate hashes detect changes but do not prevent them.
The evaluator's report is a model judgment backed by references to actual tool results.
Reference validity alone does not prove semantic correctness or full criterion coverage.
Required excluded files and remote outcomes need separate observations.
Missing required evidence must remain unresolved.
