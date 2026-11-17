# Prometheus

Prometheus helps you investigate technical questions, clarify decisions, and independently verify work in OpenCode V2. OpenCode remains responsible for running tools, managing permissions, and continuing goals.

## Get started

Install Prometheus using the [package guide](packages/prometheus/README.md), then use these commands in an OpenCode session:

```text
/spike What is the safest way to migrate these settings?
/grill-me Help me decide which migration approach to use.
/goal Implement the agreed migration and verify its acceptance criteria.
```

`/spike` investigates with the tools available to your session. `/grill-me` helps resolve decisions that affect the work. Neither command starts implementation. When you are ready, give OpenCode's native `/goal` an explicit objective.

Prometheus also provides `prometheus_record` for findings and decisions, and `prometheus_verify` for independent candidate verification. Verification uses a fresh evaluator session and completed tool results; it is not an OS sandbox or an automatic repair loop.

## Browser integration

The optional managed browser runs separately from Prometheus goals. See the [browser operations guide](docs/BROWSER-OPERATIONS.md) for installation, configuration, and recovery.

- [Browser reference](docs/RESOURCE-SELECTION.md): settings, tools, login, and transfers.
- [Proxy setup](docs/BROWSER-OPERATIONS.md#proxy-setup-and-session-lifecycle): optional session-based routing.
- [CAPTCHA integration](docs/BROWSER-2CAPTCHA.md): optional paid solving, policy, and accounting. Each paid call requires explicit authorization.
- [Shopping workflow](docs/BROWSER-SHOPPING-WORKFLOW.md): product and cart verification with manual checkout.

## Development

Run the automated tests from the repository root:

```sh
npm run test:controller
npm run test:controller:native
npm test
```

See the [verification guide](docs/VERIFICATION.md) for prerequisites and coverage, the [specification](SPEC.md) for requirements, and the [documentation index](docs/README.md) for the full reference.
