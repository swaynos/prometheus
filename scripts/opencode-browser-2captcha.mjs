import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { CAPTCHA_TYPES, bindCaptchaProxy, validateCaptchaSolution } from './opencode-browser-captcha-types.mjs';

export { CAPTCHA_TYPES, CAPTCHA_TYPE_ALIASES, validateCaptchaTask } from './opencode-browser-captcha-types.mjs';

export class CaptchaProviderError extends Error {
  constructor(code, outcome) {
    super(`2captcha: ${code}`);
    this.name = 'CaptchaProviderError';
    this.code = code;
    this.outcome = outcome;
  }
}
const fail = (code, outcome = 'not-submitted') => new CaptchaProviderError(code, outcome);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));

export function validateCaptchaConfig(config) {
  if (config === undefined) return undefined;
  if (!only(config, ['enabled', 'provider', 'keyFile', 'envFile', 'timeoutMs', 'pollIntervalMs', 'proxyMode', 'policy'])) throw fail('invalid-config');
  const snapshot = { ...config };
  if (!['enabled', 'provider', 'timeoutMs', 'pollIntervalMs'].every(key => Object.hasOwn(snapshot, key)) ||
       snapshot.enabled !== true || snapshot.provider !== '2captcha' ||
      (Object.hasOwn(snapshot, 'proxyMode') && !['browser', 'proxyless'].includes(snapshot.proxyMode)) ||
      (Object.hasOwn(snapshot, 'keyFile') && (typeof snapshot.keyFile !== 'string' || !path.isAbsolute(snapshot.keyFile))) ||
      (Object.hasOwn(snapshot, 'envFile') && (typeof snapshot.envFile !== 'string' || !path.isAbsolute(snapshot.envFile))) ||
      (Object.hasOwn(snapshot, 'keyFile') && Object.hasOwn(snapshot, 'envFile')) ||
      !Number.isSafeInteger(snapshot.timeoutMs) || snapshot.timeoutMs < 1 || snapshot.timeoutMs > 300000 ||
      !Number.isSafeInteger(snapshot.pollIntervalMs) || snapshot.pollIntervalMs < 1 || snapshot.pollIntervalMs > 30000) {
    throw fail('invalid-config');
  }
  if (snapshot.policy !== undefined) {
    const p = snapshot.policy;
    if (!only(p, ['ledgerDir', 'sites', 'estimateMicros', 'dailyTasks', 'lifetimeTasks', 'dailyMicros', 'lifetimeMicros']) ||
        !['ledgerDir', 'sites', 'estimateMicros', 'dailyTasks', 'lifetimeTasks', 'dailyMicros', 'lifetimeMicros'].every(k => Object.hasOwn(p, k)) ||
        !path.isAbsolute(p.ledgerDir || '') || !Array.isArray(p.sites) || !p.sites.length || p.sites.length > 100 ||
        !['estimateMicros', 'dailyTasks', 'lifetimeTasks', 'dailyMicros', 'lifetimeMicros'].every(k => Number.isSafeInteger(p[k]) && p[k] > 0) ||
        p.estimateMicros > p.dailyMicros || p.estimateMicros > p.lifetimeMicros) throw fail('invalid-config');
    const sites = p.sites.map(site => {
      if (!only(site, ['origin', 'acceptSelector', 'challenge']) || !Object.hasOwn(site, 'origin') || !Object.hasOwn(site, 'acceptSelector') || typeof site.origin !== 'string' || typeof site.acceptSelector !== 'string' || !site.acceptSelector || site.acceptSelector.length > 512) throw fail('invalid-config');
      try { const u = new URL(site.origin); if (u.protocol !== 'https:' || u.origin !== site.origin || u.username || u.password) throw new Error(); } catch { throw fail('invalid-config'); }
      let challenge;
      if (site.challenge !== undefined) {
        const c = site.challenge;
        if (!only(c, ['type', 'widgetSelector', 'taskCallback', 'solutionCallback']) ||
            !['type', 'widgetSelector', 'taskCallback', 'solutionCallback'].every(k => Object.hasOwn(c, k)) ||
            !Object.hasOwn(CAPTCHA_TYPES, c.type) || typeof c.widgetSelector !== 'string' || !c.widgetSelector || c.widgetSelector.length > 512 ||
            ![c.taskCallback, c.solutionCallback].every(v => typeof v === 'string' && /^[A-Za-z_$][\w$]*$/.test(v))) throw fail('invalid-config');
        challenge = Object.freeze({ ...c });
      }
      return Object.freeze({ ...site, ...(challenge ? { challenge } : {}) });
    });
    if (new Set(sites.map(s => s.origin)).size !== sites.length) throw fail('invalid-config');
    snapshot.policy = Object.freeze({ ...p, sites: Object.freeze(sites) });
  }
  return Object.freeze(snapshot);
}

// Read only the requested variable. Never put file values into process.env.
function readEnvKey(file) {
  let fd, dirFd;
  try {
    if (typeof process.getuid !== 'function' || typeof fs.constants.O_NOFOLLOW !== 'number' || typeof fs.constants.O_DIRECTORY !== 'number') throw new Error();
    const parent = path.dirname(file);
    const realParent = fs.realpathSync(parent);
    for (let dir = realParent; ; dir = path.dirname(dir)) {
      const s = fs.statSync(dir);
      if (!s.isDirectory() || (s.uid !== process.getuid() && s.uid !== 0) ||
          ((s.mode & 0o022) && !(s.uid === 0 && (s.mode & 0o1000)))) throw new Error();
      if (path.dirname(dir) === dir) break;
    }
    dirFd = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const parentStat = fs.fstatSync(dirFd);
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0));
    const stat = fs.fstatSync(fd);
    const check = fs.lstatSync(file), parentCheck = fs.statSync(parent);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o600 || stat.size > 65536 ||
        check.dev !== stat.dev || check.ino !== stat.ino || parentCheck.dev !== parentStat.dev || parentCheck.ino !== parentStat.ino || fs.realpathSync(parent) !== realParent) throw new Error();
    const bytes = Buffer.alloc(65537);
    let count = 0, n;
    while (count < bytes.length && (n = fs.readSync(fd, bytes, count, bytes.length - count, null)) > 0) count += n;
    if (count > 65536) throw new Error();
    const text = bytes.subarray(0, count).toString('utf8');
    if (text.includes('\0')) throw new Error();
    let value, seen = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*(?:#.*)?$/.test(line)) continue;
      // Deliberately reject multiline, malformed and ambiguous assignments.
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^#'"\r\n]*?)\s*(?:#.*)?$/.exec(line);
      if (!match) throw new Error();
      if (match[1] === 'TWOCAPTCHA_API_KEY') {
        if (seen) throw new Error();
        seen = true;
        value = parseEnv(line).TWOCAPTCHA_API_KEY;
      }
    }
    if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /\s/.test(value)) throw new Error();
    return value;
  } catch { throw fail('unsafe-env-file'); }
  finally { if (fd !== undefined) fs.closeSync(fd); if (dirFd !== undefined) fs.closeSync(dirFd); }
}

function resolveKey(config) {
  if (Object.hasOwn(process.env, 'TWOCAPTCHA_API_KEY')) {
    const value = process.env.TWOCAPTCHA_API_KEY;
    if (!value || value.length > 4096 || /\s/.test(value)) throw fail('missing-key');
    return value;
  }
  if (config.keyFile !== undefined) return readKey(config.keyFile);
  return readEnvKey(config.envFile ?? path.resolve(process.cwd(), '.env'));
}

function readKey(file) {
  let fd, dirFd;
  try {
    if (typeof process.getuid !== 'function' || typeof fs.constants.O_NOFOLLOW !== 'number' || typeof fs.constants.O_DIRECTORY !== 'number') throw new Error();
    const resolved = fs.realpathSync(file);
    for (let dir = path.dirname(resolved); ; dir = path.dirname(dir)) {
      // Git metadata can also be the root of a bare repository, without .git.
      // Fail closed on repository-shaped directories, including linked metadata.
      if (fs.existsSync(path.join(dir, '.git')) ||
          (fs.existsSync(path.join(dir, 'HEAD')) &&
           ['objects', 'refs', 'commondir'].some(name => fs.existsSync(path.join(dir, name))))) throw new Error();
      const parent = path.dirname(dir);
      if (parent === dir) break;
    }
    const parent = path.dirname(file);
    dirFd = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const parentStat = fs.fstatSync(dirFd);
    if (parentStat.uid !== process.getuid() || (parentStat.mode & 0o077) !== 0) throw new Error();
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
        stat.uid !== process.getuid() || stat.size < 1 || stat.size > 4096) throw new Error();
    const check = fs.lstatSync(resolved);
    const parentCheck = fs.statSync(parent);
    if (fs.realpathSync(file) !== resolved || check.dev !== stat.dev || check.ino !== stat.ino ||
        parentCheck.dev !== parentStat.dev || parentCheck.ino !== parentStat.ino) throw new Error();
    const key = fs.readFileSync(fd, 'utf8').trim();
    if (!key || /\s/.test(key)) throw new Error();
    return key;
  } catch { throw fail('unsafe-key-file'); }
  finally { if (fd !== undefined) fs.closeSync(fd); if (dirFd !== undefined) fs.closeSync(dirFd); }
}

function request(endpoint, body, signal) {
  return new Promise((resolve, reject) => {
    const req = https.request(`https://api.2captcha.com/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal,
    }, res => {
      let data = '', size = 0;
      res.setEncoding('utf8');
      res.on('data', chunk => { size += Buffer.byteLength(chunk); if (size > 16 * 1024 * 1024) req.destroy(); else data += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error());
        try { resolve(JSON.parse(data)); } catch { reject(new Error()); }
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function boundedCall(fn, signal) {
  if (signal.aborted) throw new Error();
  let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(new Error());
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(fn), stopped]); }
  finally { signal.removeEventListener('abort', abort); }
}

// One object represents exactly one immutable task and can never submit twice.
export function createTurnstileTask(configInput, taskInput) {
  if (!only(taskInput, ['websiteURL', 'websiteKey']) || typeof taskInput.websiteURL !== 'string' ||
       typeof taskInput.websiteKey !== 'string' || !taskInput.websiteKey || taskInput.websiteKey.length > 2048) throw fail('invalid-task');
  const job = createCaptchaTask(configInput, { type: 'TurnstileTaskProxyless', ...taskInput });
  return Object.freeze({
    solve(hooks = {}) {
      return job.solve({ ...hooks, onReady: typeof hooks.onReady === 'function' ? (solution, signal) => hooks.onReady(solution.token, signal) : undefined });
    },
  });
}

// Generic API v2 entry point. Structured solutions stay inside trusted hooks;
// the public result contains status only. Construction never contacts 2captcha.
export function createCaptchaTask(configInput, taskInput, options = {}) {
  const config = validateCaptchaConfig(configInput);
  if (!config) throw fail('disabled');
  let task;
  try {
    if (!only(options, ['proxy', 'languagePool']) || (options.languagePool !== undefined && !['en', 'rn'].includes(options.languagePool))) throw new Error();
    task = bindCaptchaProxy(taskInput, options.proxy);
  } catch { throw fail('invalid-task-or-proxy'); }
  const languagePool = options.languagePool;
  if (languagePool && CAPTCHA_TYPES[task.type].proxy !== 'none') throw fail('invalid-task-or-proxy');
  let used = false;
  return Object.freeze({
    async solve({ authorize, reserve, onReady, onReceipt, signal } = {}) {
      if (used) throw fail('already-used', 'unknown');
      used = true;
      if (typeof authorize !== 'function' || typeof reserve !== 'function' || typeof onReady !== 'function') throw fail('authorization-required');
      if (signal !== undefined && !(signal instanceof AbortSignal)) throw fail('invalid-signal');
      const deadline = AbortSignal.timeout(config.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const interrupted = outcome => fail(signal?.aborted ? 'aborted' : 'timeout', outcome);
      if (combined.aborted) throw interrupted('not-submitted');
      const key = resolveKey(config);
      let allowed;
      try { allowed = await boundedCall(() => authorize(combined), combined); }
      catch { throw combined.aborted ? interrupted('not-submitted') : fail('preflight-failed'); }
      if (combined.aborted) throw interrupted('not-submitted');
      if (allowed !== true) throw fail('authorization-required');
      try { allowed = await boundedCall(() => reserve(combined), combined); }
      catch { throw combined.aborted ? interrupted('not-submitted') : fail('preflight-failed'); }
      if (combined.aborted) throw interrupted('not-submitted');
      if (allowed !== true) throw fail('reservation-required');
      let result;
      try { result = await request('createTask', { clientKey: key, task, ...(languagePool ? { languagePool } : {}) }, combined); }
      catch { throw combined.aborted ? interrupted('unknown') : fail('submit-unknown', 'unknown'); }
      if (!object(result) || !Number.isSafeInteger(result.errorId)) throw fail('submit-unknown', 'unknown');
      if (result.errorId !== 0) throw fail('provider-error', 'rejected');
      if (!Number.isSafeInteger(result.taskId) || result.taskId <= 0) throw fail('submit-unknown', 'unknown');
      const taskId = result.taskId;
      while (true) {
        try { await delay(config.pollIntervalMs, undefined, { signal: combined }); }
        catch { throw interrupted('submitted'); }
        try { result = await request('getTaskResult', { clientKey: key, taskId }, combined); }
        catch { throw combined.aborted ? interrupted('submitted') : fail('poll-failed', 'submitted'); }
        if (!object(result) || !Number.isSafeInteger(result.errorId)) throw fail('malformed-response', 'submitted');
        if (result.errorId !== 0) throw fail('provider-error', 'submitted');
        if (result.status === 'processing') continue;
        if (result.status !== 'ready') throw fail('malformed-response', 'submitted');
        let solution;
        try { solution = validateCaptchaSolution(task, result.solution); }
        catch { throw fail('malformed-response', 'submitted'); }
        // Parse USD as integer micro-dollars, rounding upward; missing or
        // malformed receipts leave the original reservation untouched.
        let cost = null;
        const raw = typeof result.cost === 'string' ? result.cost : typeof result.cost === 'number' ? String(result.cost) : '';
        const match = /^(\d{1,9})(?:\.(\d{1,12}))?$/.exec(raw);
        if (match) {
          const fraction = (match[2] || '').padEnd(7, '0');
          const micros = Number(match[1]) * 1000000 + Number(fraction.slice(0, 6)) + (/[1-9]/.test(fraction.slice(6)) ? 1 : 0);
          if (Number.isSafeInteger(micros)) cost = micros;
        }
        if (typeof onReceipt === 'function') {
          try { await boundedCall(() => onReceipt(cost, combined), combined); }
          catch { throw combined.aborted ? interrupted('submitted') : fail('receipt-failed', 'submitted'); }
        }
        try { await boundedCall(() => onReady(solution, combined), combined); }
        catch { throw combined.aborted ? interrupted('submitted') : fail('consumer-failed', 'submitted'); }
        return Object.freeze({ status: 'ready', outcome: 'submitted' });
      }
    },
  });
}
