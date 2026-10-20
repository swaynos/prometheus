import fs from 'node:fs';
import { exportRows } from '../src/export.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--input') throw new Error('Use --input FILE.');
  const rows = JSON.parse(fs.readFileSync(args[1], 'utf8'));
  process.stdout.write(exportRows(rows));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
