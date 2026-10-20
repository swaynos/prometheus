import fs from 'node:fs';
import { exportRows } from '../src/export.mjs';

try {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--input', '--format'].includes(key) || !args[index + 1] || Object.hasOwn(options, key)) throw new Error('Use --input FILE [--format json|csv].');
    options[key] = args[index + 1];
  }
  if (!options['--input']) throw new Error('An input file is required.');
  const rows = JSON.parse(fs.readFileSync(options['--input'], 'utf8'));
  process.stdout.write(exportRows(rows, { format: options['--format'] ?? 'json' }));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
