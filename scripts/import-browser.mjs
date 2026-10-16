// Reproducible, explicit source import. Never touches the installed profile.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/import-browser.mjs <cuddly-winner-checkout>');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = ['state', 'runtime', 'service', 'login'].map(name => `scripts/opencode-browser-${name}.mjs`);
runtime.push('scripts/opencode-playwright-mcp.mjs');
const tests = fs.readdirSync(path.join(source, 'tests/integration'))
  .filter(name => /^browser_(state|runtime|login|login_capture|login_handoff|virtual_display|downloads|image_transfer|workflow)\.test\.mjs$/.test(name) || name === 'playwright_mcp.test.mjs')
  .map(name => `tests/integration/${name}`);
const files = [...runtime, ...tests, 'rules/resource-selection.md', 'docs/RESOURCE-SELECTION.md'];
for (const file of files) {
  if (fs.existsSync(path.join(root, file))) throw new Error(`Refusing to overwrite ${file}`);
}
for (const file of files) {
  const text = fs.readFileSync(path.join(source, file), 'utf8')
    .replaceAll('CUDDLY_WINNER', 'PROMETHEUS')
    .replaceAll('cuddly-winner', 'prometheus')
    .replaceAll('cuddly_winner', 'prometheus');
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text, { flag: 'wx' });
}
console.log(`Imported ${files.length} files. Review and test before deployment.`);
