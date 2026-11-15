# Prometheus

Prometheus extends OpenCode V2 with technical investigation, requirement clarification, and independent verification.
OpenCode owns execution, tools, permissions, and goal continuation.

## Commands and Tools

| Surface | Owner | Purpose |
| --- | --- | --- |
| `/spike <question>` | Prometheus | Investigate with permitted native tools. |
| `/grill-me [instructions]` | Prometheus | Clarify consequential user decisions. |
| `/goal <objective>` | OpenCode | Continue work toward an explicit objective. |
| `prometheus_record` | Prometheus | Store or read session findings and decisions. |
| `prometheus_verify` | Prometheus | Run or inspect independent candidate verification. |

Preparation commands stay in the current Plan or Build session. They do not start implementation or a goal.
Give native `/goal` an explicit objective after preparation:

```text
/goal Implement the agreed settings screen and verify its acceptance criteria.
```

OpenCode owns `/goal pause`, `/goal resume`, and `/goal clear`. An empty `/goal` does not infer an objective.

## Verification and Records

Use `prometheus_verify` in Build to dispatch a fresh evaluator session.
The evaluator checks the current workspace with native tools and cites completed tool evidence for each criterion.
The origin session performs repairs. Prometheus does not run a repair loop or OS sandbox.

Use `prometheus_record` to store model-written findings and user decisions.
Model reports do not establish independent acceptance.

## Installation and Checks

Require stable OpenCode **>=2.2.1 <3.0.0**. See the [package guide](packages/prometheus/README.md).

For optional paid challenge solving, create a Git-ignored project-root `.env` (mode `0600`) containing `TWOCAPTCHA_API_KEY=your-key`; `.env.example` is an empty template. Run the browser from that directory or configure an absolute `envFile` for an installed runtime. A key alone does not enable solving: explicit policy, ledger and per-call authorization remain required. Budget limits are reservation estimates, not a guaranteed provider charge ceiling. See [the adapter guide](docs/BROWSER-2CAPTCHA.md).

For browser proxies, put one `HOST:PORT:USER:PASS` record per line in `~/.config/opencode/proxies.txt` and set the file's permissions to `0600`. In `prometheus-browser.json`, configure `"proxy": { "session": "main", "strategy": "round-robin" }`, then explicitly create that routing session. No `poolFile` setting, separate secrets directory, or per-proxy JSON credential files are required. Custom installations use `<config_dir>/proxies.txt`. Merely creating the file does not enable proxies. See [proxy setup, format, and recovery](docs/BROWSER-OPERATIONS.md#proxy-setup-and-session-lifecycle); [proxies.txt.example](proxies.txt.example) contains placeholders only.

Browser changes in this checkout are review candidates, not an update to any existing active installation, which may still run older code. An isolated candidate installation reached `https://example.com` in the Phase C qualification; this does not qualify a real provider, proxy, or human desktop session. Those require their own prerequisites and explicit authorization. No retailer is required, and paid calls are never automatic.

```sh
npm run test:controller
npm run test:controller:native
npm test
```

See the [specification](SPEC.md) and [documentation index](docs/README.md).
