import path from 'node:path';
import { canonical, requireThat } from '../src/util.mjs';

// Plugin readiness is a precondition, not a model task. Never fall through to an unrelated /goal command.
export async function preflight(client, { root, packageRoot, signal, meter = false, arm = 'prometheus', model }) {
  const expected = canonical(path.join(packageRoot, 'index.mjs'));
  const expectedMeter = canonical(path.join(packageRoot, 'qualification', 'meter', 'index.mjs'));
  const deadline = Date.now() + 10000;
  while (true) {
    signal?.throwIfAborted();
    const plugins = await client.plugin.list({ location: { directory: root } }, { signal });
    const own = plugins.data.find(p => p.source.type === 'local' && canonical(p.source.path) === expected);
    const failed = plugins.data.find(p => p.state.status === 'failed' && p.source.type === 'local' &&
      [canonical(packageRoot), expected].includes(canonical(p.source.path)));
    requireThat(!failed, 'The qualification plugin failed to load. No model request was authorized.');
    const metering = plugins.data.find(p => p.source.type === 'local' && canonical(p.source.path) === expectedMeter);
    requireThat(!meter || metering?.state.status !== 'failed', 'The qualification meter failed to load. No model request was authorized.');
    if (arm === 'build') requireThat(!plugins.data.some(p => p.id === 'prometheus' && p.state.status === 'active'), 'The ordinary-Build arm unexpectedly loaded Prometheus.');
    if ((arm === 'build' || own?.id === 'prometheus' && own.state.status === 'active') && (!meter || metering?.id === 'prometheus-qualification-meter' && metering.state.status === 'active')) break;
    requireThat(Date.now() < deadline, `The qualification plugin did not become active. No model request was authorized. ${JSON.stringify(plugins.data.filter(p => p.source.type === 'local'))}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (model) {
    const models = await client.model.list({ location: { directory: root } }, { signal });
    requireThat(models.data.some(item => item.providerID === model.providerID && item.id === model.id), 'The approved qualification model is unavailable. No model request was authorized.');
  }
  if (arm === 'build') return;
  const commands = await client.command.list({ location: { directory: root } }, { signal });
  const descriptions = {
    spike: 'Investigate technical unknowns.',
    'grill-me': 'Resolve consequential user decisions.',
    goal: 'Infer the goal from this conversation. Prepare in Plan. Execute in Build.',
  };
  requireThat(Object.entries(descriptions).every(([name, description]) => commands.data.find(c => c.name === name)?.description === description),
    'A qualification command is missing or replaced. No model request was authorized.');
}
