#!/usr/bin/env node
import { Store } from './store.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { requireThat } from './util.mjs';

// This operator interface never dispatches model work or resumes a run.
const [operation, directory, taskID, total, deadline, cost] = process.argv.slice(2);
let store;
try {
  requireThat(['inspect', 'grant'].includes(operation) && directory, 'Use inspect DIRECTORY [TASK] or grant DIRECTORY TASK TOTAL_REQUESTS [DEADLINE_MS|-] [MAX_USD].');
  requireThat(fs.existsSync(path.join(directory, 'prometheus.sqlite')), 'The runtime store does not exist.');
  store = new Store(directory);
  const tasks = taskID ? [store.get('task', taskID)] : store.list('task');
  requireThat(tasks.every(Boolean), 'The task does not exist.');
  if (operation === 'grant') {
    requireThat(taskID, 'Identify the task before changing its allowance.');
    const maxRequests = Number(total);
    const task = tasks[0];
    requireThat(Number.isSafeInteger(maxRequests) && maxRequests > task.requests, 'The new total must exceed consumed and uncertain requests.');
    const old = task.resourceGrant?.limits ?? store.get('specification', task.specificationID)?.goal.limits ?? {};
    const limits = { ...old, maxRequests, ...(deadline && deadline !== '-' ? { deadline: Number(deadline) } : {}) };
    requireThat(!limits.deadline || Number.isSafeInteger(limits.deadline) && limits.deadline > Date.now(), 'Supply a new future deadline.');
    if (cost) { requireThat(Number.isFinite(Number(cost)) && Number(cost) > 0, 'Supply a positive cost estimate limit.'); limits.maxUSD = Number(cost); }
    store.update('task', taskID, () => ({ resourceGrant: { limits, time: Date.now(), source: 'explicit-operator-command' } }), 'operator_resource_grant', { limits });
    console.log(JSON.stringify({ taskID, limits, resumed: false, instruction: 'Resume explicitly in the originating Build conversation.' }, null, 2));
  } else console.log(JSON.stringify(tasks.map(task => ({ taskID: task.id, origin: task.origin, requests: task.requests,
    resourceGrant: task.resourceGrant, run: task.runID ? store.get('run', task.runID) : undefined })), null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { store?.close(); }
