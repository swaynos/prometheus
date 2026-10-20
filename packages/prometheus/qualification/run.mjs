#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { sandboxAvailable } from '../src/sandbox.mjs';
import { canonical, requireThat, errorText } from '../src/util.mjs';
import { loadManifest } from './manifest.mjs';
import { runCampaign } from './driver.mjs';

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    requireThat(['--manifest', '--approval', '--output', '--inspect'].includes(args[i]) && args[i + 1],
      'Use --manifest FILE [--approval FINGERPRINT --output NEW_DIRECTORY], or --inspect OUTPUT.');
    const name = args[i].slice(2);
    requireThat(!Object.hasOwn(options, name), `Duplicate option: --${name}`);
    options[name] = args[++i];
  }
  if (options.inspect) {
    requireThat(Object.keys(options).length === 1, 'Inspection cannot authorize execution.');
    const report = JSON.parse(fs.readFileSync(path.join(canonical(options.inspect), 'report.json')));
    console.log(JSON.stringify({ fingerprint: report.fingerprint, complete: report.complete, releaseQualified: report.releaseQualified,
      requests: report.requests, observedCostUSD: report.observedCostUSD, cases: report.cases.map(c => ({ name: c.name, status: c.status, reason: c.error })),
      note: 'Read-only report inspection. No service access, model request, or resume occurred.' }, null, 2));
    return;
  }
  requireThat(options.manifest, 'A qualification manifest is required.');
  const admission = loadManifest(options.manifest);
  if (!options.approval) {
    requireThat(!options.output, 'Output creation requires approval.');
    console.log(JSON.stringify({ status: 'awaiting-approval', fingerprint: admission.fingerprint,
      model: admission.input.model, maxRequests: admission.input.maxRequests, timeoutMs: admission.input.timeoutMs,
      previousUsage: admission.previous ?? null,
      remainingRequests: admission.input.maxRequests - (admission.previous?.requests ?? 0),
      maxUSD: admission.input.maxUSD ?? null, costLimitIsEstimate: true, runtime: admission.binding.runtime.id,
      cases: admission.input.cases.map(c => c.name), scenarios: admission.input.cases.map(c => ({ name: c.name, arm: c.arm,
        pair: c.pair ?? null, agent: c.agent, steps: c.steps.length, maxRequests: c.maxRequests, expectedStates: c.expect.states,
        fixture: c.fixtureAsset.id, independentChecks: c.oracleAsset.id })),
      note: 'Approval binds manifest bytes, runtime, fixtures, and independent checks. No service access, model requests, or output writes occurred.' }, null, 2));
    return;
  }
  requireThat(options.approval === admission.fingerprint, 'Approval does not identify this manifest and its assets.');
  requireThat(options.output && !fs.existsSync(options.output), 'Choose a new output directory.');
  requireThat(sandboxAvailable(), 'Qualification requires the supported macOS process boundary.');
  const endpoint = await Service.discover();
  requireThat(endpoint, 'Start an authenticated OpenCode service before qualification. This runner does not start one.');
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  const stop = new AbortController();
  const interrupted = () => stop.abort(new Error('The qualification operator requested a stop.'));
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try {
    const report = await runCampaign(admission, { client, output: options.output, signal: stop.signal,
      progress: item => console.log(item.type === 'awaiting-response'
        ? `Declared human response: ${item.name}. Session: ${item.sessionID}. ${item.instructions}`
        : `Qualification started: ${item.name}. Session: ${item.sessionID}`) });
    console.log(JSON.stringify({ complete: report.complete, releaseQualified: false, requests: report.requests,
      report: path.join(canonical(options.output), 'report.json') }, null, 2));
    if (!report.complete) process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
  }
}

main().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
