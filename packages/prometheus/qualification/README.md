# Native qualification

The custom-controller campaign runner is retired.
Old campaign manifests assume a Prometheus-owned `/goal`, private process runner, budget ledger, and macOS sandbox.
Those assumptions no longer apply. `run.mjs` rejects execution without contacting a service or model.

## Available checks

```sh
npm test
npm run test:native
npm run qualification:catalog
```

Native tests use isolated OpenCode services and local scripted responses. They can run on Linux.
They do not spend a model allowance and do not establish real-model reliability.
The catalog lists required workflow and fault observations. A catalog entry is not a test result.

Existing fixtures and independent oracle programs remain available for future live procedures.
See the repository [verification guide](../../../docs/VERIFICATION.md) and [scenarios](../../../docs/SCENARIOS.md).

Before live model work, agree on the model, allowance, procedure, stopping conditions, and evidence destination.
Check plugin status and native goal ownership before issuing commands.
Use native tools and permissions. Do not recreate the retired process sandbox or silently run old manifests against native `/goal`.
