export class Native {
  constructor(ctx) { this.ctx = ctx; }
  get(sessionID) { return this.ctx.session.get({ sessionID }); }
  async exists(sessionID) {
    try { await this.get(sessionID); return true; }
    catch (error) { if (error._tag === 'Session.NotFoundError') return false; throw error; }
  }
  context(sessionID) { return this.ctx.session.context({ sessionID }); }
  async create(input) {
    const parent = input.parentID ? await this.get(input.parentID) : undefined;
    const permissions = [...(parent?.permissions ?? []), ...(input.permissions ?? [])];
    return this.ctx.session.create({ ...input, permissions });
  }
  authorizeChild({ origin, agent, target }) {
    return this.ctx.permission.assert({ sessionID: origin, agent, action: 'subagent', resources: [target], save: [],
      metadata: { prometheusManagedChild: true, purpose: 'A restricted Prometheus child session.' } });
  }
  synthetic(input) { return this.ctx.session.synthetic(input); }
  wait(sessionID) { return this.ctx.session.wait({ sessionID }); }
  interrupt(sessionID) { return this.ctx.session.interrupt({ sessionID, continue: false }); }
  notice(sessionID, text, messageID) { return this.ctx.session.synthetic({ sessionID, text, ...(messageID ? { id: messageID } : {}), resume: false }); }
}
