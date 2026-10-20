import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.mjs';
import { hash, id, requireThat } from '../src/util.mjs';

function processIdentity(pid) {
  requireThat(Number.isSafeInteger(pid) && pid > 0, 'Invalid qualification owner process.');
  const identity = execFileSync('/bin/ps', ['-ww', '-o', 'lstart=,command=', '-p', String(pid)], {
    encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  }).trim();
  requireThat(identity, 'The qualification owner identity is unavailable.');
  return hash(identity);
}

export class Ledger {
  constructor(directory, { now = Date.now, ownerAlive = owner => {
    if (owner.host !== os.hostname()) return false;
    try { process.kill(owner.pid, 0); return !!owner.identity && processIdentity(owner.pid) === owner.identity; } catch { return false; }
  } } = {}) {
    this.store = new Store(directory);
    this.now = now;
    this.ownerAlive = ownerAlive;
  }
  initialize(admission) {
    requireThat(!this.store.get('campaign', 'campaign'), 'A campaign ledger cannot reset consumed or uncertain usage.');
    return this.store.put('campaign', { id: 'campaign', fingerprint: admission.fingerprint, state: 'Working',
      model: admission.input.model, maxRequests: admission.input.maxRequests, maxUSD: admission.input.maxUSD,
      deadline: this.now() + admission.input.timeoutMs - (admission.previous?.elapsedMs ?? 0),
      requests: admission.previous?.requests ?? 0, observedCostUSD: admission.previous?.observedCostUSD ?? 0,
      previous: admission.previous ?? null, costLimitIsEstimate: true,
      owner: { host: os.hostname(), pid: process.pid, identity: processIdentity(process.pid) }, started: this.now() }, 'campaign_approved');
  }
  get() { return this.store.get('campaign', 'campaign'); }
  beginCase(item, root, { deadline = this.get().deadline } = {}) {
    requireThat(this.get()?.state === 'Working', 'The campaign does not permit another case.');
    return this.store.put('case', { id: item.name, root, arm: item.arm, maxRequests: item.maxRequests, requests: 0,
      observedCostUSD: 0, state: 'Working', deadline, started: this.now() }, 'case_started');
  }
  session(caseID, info) {
    const item = this.store.get('case', caseID);
    requireThat(item && info.location?.directory === item.root, 'A qualification session belongs to another workspace.', 'boundary');
    const existing = this.store.get('meter-session', info.id);
    if (existing) {
      requireThat(existing.caseID === caseID, 'A session cannot change qualification cases.');
      return existing;
    }
    return this.store.put('meter-session', { id: info.id, caseID, parentID: info.parentID, observedCostUSD: 0 }, 'session_observed');
  }
  reserve(caseID, event) {
    return this.store.transaction(() => {
      const campaign = this.get();
      const item = this.store.get('case', caseID);
      requireThat(campaign?.state === 'Working' && item?.state === 'Working', 'Qualification dispatch is stopped.', 'campaign_stopped');
      requireThat(this.ownerAlive(campaign.owner), 'The qualification owner is absent. No automatic continuation is permitted.', 'campaign_owner');
      requireThat(this.store.get('meter-session', event.sessionID)?.caseID === caseID, 'Register the qualification session before dispatch.');
      requireThat(event.model?.providerID === campaign.model.providerID && event.model?.id === campaign.model.id &&
        (!campaign.model.variant || event.model.variant === campaign.model.variant), 'The qualification request selected an unapproved model.', 'model_mismatch');
      requireThat(this.now() < campaign.deadline && this.now() < item.deadline, 'The qualification duration expired.', 'campaign_budget');
      requireThat(campaign.requests < campaign.maxRequests && item.requests < item.maxRequests, 'The qualification model-request allowance is exhausted.', 'campaign_budget');
      requireThat(!campaign.maxUSD || campaign.observedCostUSD < campaign.maxUSD, 'The observed qualification cost reached its estimate limit.', 'campaign_budget');
      const reservation = this.store.put('reservation', { id: id('reservation'), caseID, sessionID: event.sessionID,
        kind: event.kind, model: event.model, state: 'reserved', time: this.now() }, 'request_reserved');
      this.store.update('case', caseID, c => ({ requests: c.requests + 1 }), 'case_request_reserved', { reservationID: reservation.id });
      this.store.update('campaign', 'campaign', c => ({ requests: c.requests + 1 }), 'campaign_request_reserved', { reservationID: reservation.id });
      return reservation;
    });
  }
  usage(sessionID, observedCostUSD) {
    requireThat(Number.isFinite(observedCostUSD) && observedCostUSD >= 0, 'Invalid native cost observation.');
    return this.store.transaction(() => {
      const session = this.store.get('meter-session', sessionID);
      requireThat(session, 'Unknown qualification session.');
      const cost = Math.max(session.observedCostUSD, observedCostUSD);
      const delta = cost - session.observedCostUSD;
      this.store.update('meter-session', sessionID, () => ({ observedCostUSD: cost }), 'usage_observed');
      this.store.update('case', session.caseID, c => ({ observedCostUSD: c.observedCostUSD + delta }), 'case_usage_observed');
      this.store.update('campaign', 'campaign', c => ({ observedCostUSD: c.observedCostUSD + delta }), 'campaign_usage_observed');
    });
  }
  event(caseID, event, detail) {
    return this.store.put('participation', { id: id('participation'), caseID, event, ...detail, time: this.now() }, event);
  }
  stop(reason) {
    if (this.get()?.state === 'Working') this.store.update('campaign', 'campaign', () => ({ state: 'Paused', reason, stopped: this.now() }), 'campaign_paused');
  }
  summary() {
    return { campaign: this.get(), cases: this.store.list('case'), sessions: this.store.list('meter-session'),
      reservations: this.store.list('reservation'), participation: this.store.list('participation'), faults: this.store.list('fault') };
  }
  close() { this.store.close(); }
}

export function compare(checks, snapshot) {
  const lookup = name => (name.startsWith('/') ? name.slice(1).split('/').map(key => key.replaceAll('~1', '/').replaceAll('~0', '~')) : name.split('.'))
    .reduce((current, key) => current !== null && current !== undefined && Object.hasOwn(current, key) ? current[key] : undefined, snapshot);
  return (checks ?? []).map(check => {
    const value = lookup(check.path);
    let pass;
    if (Object.hasOwn(check, 'equals')) pass = hash(value ?? null) === hash(check.equals ?? null) && (value !== undefined || check.equals === undefined);
    else if (Object.hasOwn(check, 'exists')) pass = (value !== undefined && value !== null) === check.exists;
    else if (Object.hasOwn(check, 'min')) pass = typeof value === 'number' && value >= check.min;
    else if (Object.hasOwn(check, 'max')) pass = typeof value === 'number' && value <= check.max;
    else if (Object.hasOwn(check, 'sameAs')) pass = value !== undefined && lookup(check.sameAs) !== undefined && hash(value) === hash(lookup(check.sameAs));
    else if (Object.hasOwn(check, 'contains')) pass = typeof value === 'string' ? typeof check.contains === 'string' && value.includes(check.contains) :
      Array.isArray(value) && value.some(v => hash(v) === hash(check.contains));
    else pass = false;
    return { ...check, pass: !!pass, actual: value ?? null };
  });
}
