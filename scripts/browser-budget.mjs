#!/usr/bin/env node
// Explicit operator action only; never called from navigation or MCP.
import { initializeBudget, settleBudget } from './opencode-browser-budget.mjs';

try {
  const [command, dir, id, amount, ...extra] = process.argv.slice(2);
  if (command === 'init' && dir && id === undefined) {
    await initializeBudget(dir);
    console.log('Budget ledger initialized.');
  } else if (command === 'reconcile' && dir && /^[a-f0-9]{64}$/.test(id || '') && /^\d+$/.test(amount || '') && !extra.length && Number.isSafeInteger(Number(amount))) {
    if (!await settleBudget(dir, id, Number(amount))) throw new Error();
    console.log('Receipt recorded; conservative reservation retained.');
  } else throw new Error();
} catch {
  console.error('Budget operation failed; verify private storage and arguments. No automatic reset was performed.');
  process.exitCode = 1;
}
