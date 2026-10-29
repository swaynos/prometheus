import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { id, requireThat } from './util.mjs';
import { text } from './contracts.mjs';

export class Records {
  constructor(ctx) { this.ctx = ctx; this.writes = new Map(); }
  async serial(key, callback) {
    const previous = this.writes.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(callback);
    this.writes.set(key, current);
    try { return await current; }
    finally { if (this.writes.get(key) === current) this.writes.delete(key); }
  }
  async read(sessionID) {
    return await this.ctx.storage.get(`v2/session/${sessionID}`) ?? { findings: [], decisions: [] };
  }
  legacy() {
    const directory = this.ctx.options?.stateDirectory ?? path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'prometheus');
    const configured = this.ctx.options?.stateDirectory !== undefined || this.ctx.options?.limits !== undefined || this.ctx.options?.protectedPaths !== undefined;
    return { configured, directoryExists: fs.existsSync(directory),
      message: 'Legacy controller records are not imported, changed, or resumed. Old stateDirectory, limits, and protectedPaths options no longer control execution. OpenCode owns tools, permissions, cancellation, and goal limits.' };
  }
  async execute(sessionID, action, data) {
    if (action === 'status') return { ...await this.read(sessionID), legacy: this.legacy() };
    requireThat(['finding', 'decision'].includes(action), 'Unknown record action.');
    return this.serial(`session/${sessionID}`, async () => {
      const record = await this.read(sessionID);
      const entry = action === 'finding'
        ? { id: id('finding'), observations: text(data.observations, 'Observations'), interpretation: text(data.interpretation, 'Interpretation'),
          limitations: text(data.limitations, 'Limitations'), outcome: text(data.outcome, 'Outcome') }
        : { id: id('decision'), decision: text(data.decision, 'Decision'), rationale: text(data.rationale, 'Rationale') };
      if (action === 'finding') requireThat(['supported', 'disproved', 'inconclusive'].includes(entry.outcome), 'Invalid finding outcome.');
      const key = action === 'finding' ? 'findings' : 'decisions';
      record[key].push({ ...entry, created: Date.now(), source: 'model-report' });
      await this.ctx.storage.set(`v2/session/${sessionID}`, record);
      return entry;
    });
  }
}
