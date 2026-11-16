import { captureCaptchaCandidate } from './opencode-browser-captcha-page.mjs';
import { CAPTCHA_TYPES, validateCaptchaTask, snapshotCaptchaValue } from './opencode-browser-captcha-types.mjs';

// Internal lifecycle only. No MCP endpoint can inject these dependencies.
// The owner must supply a monotonic binding revision that changes on every tab,
// context or proxy-session change, including change-and-change-back.
const result = (status, reason, outcome) => Object.freeze({ status, reason, outcome });

async function bounded(fn, signal) {
  if (signal.aborted) throw new Error('interrupted');
  let stop;
  const aborted = new Promise((_, reject) => {
    stop = () => reject(new Error('interrupted'));
    signal.addEventListener('abort', stop, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(fn), aborted]); }
  finally { signal.removeEventListener('abort', stop); }
}

// Read-only inspection has the same renderer/cancellation bound as solving.
// Dispose a handle even when its creation finishes after the caller timed out.
export async function inspectCaptchaCandidate({ page, challenge, timeoutMs = 15000, signal }) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([deadline, signal]) : deadline;
  if (combined.aborted) throw new Error('inspection interrupted');
  let handle, finished = false;
  const evaluation = page.evaluateHandle(captureCaptchaCandidate, { challenge });
  void evaluation.then(late => { if (finished || combined.aborted) void late.dispose().catch(() => {}); }, () => {});
  try {
    handle = await bounded(() => evaluation, combined);
    return await bounded(() => handle.evaluate(value => value.status === 'candidate'
      ? { status: value.status, type: value.type, solve_available: false }
      : { status: value.status, ...(value.reason ? { reason: value.reason } : {}) }), combined);
  } finally {
    finished = true;
    if (handle) void handle.dispose().catch(() => {});
  }
}

// navigationStatus must be fresh evidence for this exact main-frame document.
// acceptSelector is a trusted, caller-specified site success signal which must
// not be visible before application. No page strings are returned to the caller.
export function inspectTurnstileLifecycle(options) {
  return inspectCaptchaLifecycle({ ...options, turnstileOnly: true, legacyToken: true });
}

export async function inspectCaptchaLifecycle({ page, context, getBinding, navigationStatus, acceptSelector, challenge, turnstileOnly = false, legacyToken = false, timeoutMs = 15000, signal }) {
  if (!page || !context || page.context() !== context || typeof getBinding !== 'function' ||
      !Number.isInteger(navigationStatus) || navigationStatus < 200 || navigationStatus >= 400 ||
      typeof acceptSelector !== 'string' || !acceptSelector || acceptSelector.length > 512 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000 ||
      (signal !== undefined && !(signal instanceof AbortSignal))) throw new Error('invalid lifecycle input');
  // One deadline covers inspection, provider preflight, application and evidence.
  const deadline = AbortSignal.timeout(timeoutMs);
  const expiresAt = Date.now() + timeoutMs;
  let url;
  try { url = new URL(page.url()); if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error(); }
  catch { throw new Error('unsupported document'); }
  const binding = getBinding();
  if (!binding || typeof binding !== 'string') throw new Error('invalid lifecycle binding');
  let stale = false, navigated = false, used = false, disposed = false;
  const cancellation = new AbortController();
  const inspectionSignal = AbortSignal.any([deadline, cancellation.signal, ...(signal ? [signal] : [])]);
  // Stop a pending provider wait as soon as its document or browsing context
  // disappears. A request already sent remains submitted or unknown; aborting
  // it is not evidence that the provider did not charge.
  const invalidate = frame => { if (frame === page.mainFrame()) { navigated = true; stale = true; cancellation.abort(); } };
  const close = () => { stale = true; cancellation.abort(); };
  page.on('framenavigated', invalidate);
  page.on('close', close);
  context.on('close', close);
  let handle;
  const cleanup = async () => {
    if (disposed) return;
    disposed = true;
    page.off('framenavigated', invalidate); page.off('close', close); context.off('close', close);
    inspectionSignal.removeEventListener('abort', onInspectionAbort);
    if (handle) void handle.dispose().catch(() => {});
  };
  const onInspectionAbort = () => { void cleanup(); };
  inspectionSignal.addEventListener('abort', onInspectionAbort, { once: true });
  const valid = () => {
    try { return !stale && !page.isClosed() && page.context() === context && getBinding() === binding && page.url() === url.href; }
    catch { return false; }
  };
  try {
    if (inspectionSignal.aborted) throw new Error('interrupted');
    const evaluation = page.evaluateHandle(captureCaptchaCandidate, { challenge, turnstileOnly });
    // A timed-out evaluateHandle may resolve later; dispose that remote handle
    // without making the caller wait for a stalled renderer.
    void evaluation.then(late => { if (disposed || inspectionSignal.aborted) void late.dispose().catch(() => {}); }, () => {});
    handle = await bounded(() => evaluation, inspectionSignal);
    let task = snapshotCaptchaValue(await bounded(() => handle.evaluate(value => value?.status === 'candidate' ? value.task : null), inspectionSignal));
    if (!task || !Object.hasOwn(CAPTCHA_TYPES, task.type) || !valid() || await bounded(() => page.locator(acceptSelector).first().isVisible(), inspectionSignal) || inspectionSignal.aborted) throw new Error('unsupported challenge');
    // The page never chooses a proxy or a different target document. A required
    // proxy is bound privately by the owner after inspection.
    if (Object.keys(task).some(k => k.startsWith('proxy')) ||
        (task.websiteURL !== undefined && task.websiteURL !== url.href) ||
        (task.redirectUri !== undefined && task.redirectUri !== url.href)) throw new Error('unsupported challenge');
    const spec = CAPTCHA_TYPES[task.type];
    const validationType = spec.proxy === 'required' && Object.hasOwn(CAPTCHA_TYPES, `${task.type}Proxyless`) ? `${task.type}Proxyless` : task.type;
    const checked = validateCaptchaTask(spec.proxy === 'required' && validationType === task.type
      ? { ...task, proxyType: 'http', proxyAddress: 'validation.invalid', proxyPort: 80 }
      : { ...task, type: validationType });
    task = snapshotCaptchaValue({ ...Object.fromEntries(Object.entries(checked).filter(([k]) => !k.startsWith('proxy'))), type: task.type });
    if ((task.websiteURL !== undefined && task.websiteURL !== url.href) ||
        (task.redirectUri !== undefined && task.redirectUri !== url.href)) throw new Error('unsupported challenge');
    return Object.freeze({
      type: task.type,
      async cancel() { stale = true; cancellation.abort(); await cleanup(); },
      async solve({ authorizePaid, maxCostUsd, maxTasks, authorize, reserve, createProvider, onReceipt, protectToken, signal } = {}) {
        if (used) return result('not_submitted', 'already_used', 'unknown');
        used = true;
        if (authorizePaid !== true || !Number.isFinite(maxCostUsd) || maxCostUsd <= 0 || !Number.isSafeInteger(maxTasks) || maxTasks < 1 || typeof authorize !== 'function' || typeof reserve !== 'function' || typeof createProvider !== 'function' || (signal !== undefined && !(signal instanceof AbortSignal))) {
          await cleanup(); return result('not_submitted', 'authorization_required', 'not-submitted');
        }
        const combined = AbortSignal.any([inspectionSignal, ...(signal ? [signal] : [])]);
        let outcome = 'not-submitted', applied = false, accepted = false, reserving = false;
        try {
          if (!valid() || combined.aborted) throw new Error('stale');
          const provider = createProvider(legacyToken ? { websiteURL: task.websiteURL, websiteKey: task.websiteKey } : task);
          outcome = 'unknown';
          await bounded(() => provider.solve({
            signal: combined,
            authorize: async s => valid() && !s.aborted && await authorize({ maxCostUsd, maxTasks, signal: s }) === true && valid() && !s.aborted,
            reserve: async s => {
              if (!valid() || s.aborted) return false;
              reserving = true;
              try { return await reserve({ maxCostUsd, maxTasks, signal: s }) === true && valid() && !s.aborted; }
              finally { reserving = false; }
            },
            onReceipt: typeof onReceipt === 'function' ? onReceipt : undefined,
            onReady: async (solution, s) => {
              const protect = value => {
                if (typeof value === 'string' && typeof protectToken === 'function') protectToken(value);
                else if (value && typeof value === 'object') for (const child of Object.values(value)) protect(child);
              };
              protect(solution);
              const payload = legacyToken ? solution : challenge ? solution : solution.token || solution.gRecaptchaResponse;
              if (!challenge && (typeof payload !== 'string' || !payload)) throw new Error('invalid solution');
              outcome = 'submitted';
              if (!valid() || s.aborted) throw new Error('stale');
              if (await bounded(() => page.locator(acceptSelector).first().isVisible(), s)) throw new Error('preexisting evidence');
              if (!valid() || s.aborted) throw new Error('stale');
              // The captured widget, document and own global callback must still
              // be identical at the instant of invocation. Never return token.
              const invoked = await bounded(() => handle.evaluate((value, args) => {
                const evidence = document.querySelector(args.acceptSelector);
                if (evidence && evidence.getClientRects().length && getComputedStyle(evidence).visibility === 'visible') return false;
                if (Date.now() >= args.expiresAt || !value || !value.isCurrent()) return false;
                value.callback(args.payload); return true;
              }, { payload, expiresAt, acceptSelector }), s);
              if (!invoked) throw new Error('stale');
              applied = true;
              if (!valid() || s.aborted) throw new Error('stale');
              try { await bounded(() => page.locator(acceptSelector).first().waitFor({ state: 'visible', timeout: timeoutMs }), s); }
              catch { return; }
              if (!valid() || s.aborted) throw new Error('stale');
              const eligible = await bounded(() => handle.evaluate(value => Boolean(value && document === value.document && !value.isManaged())), s);
              accepted = eligible && valid() && !s.aborted;
            },
          }), combined);
          outcome = 'submitted';
          if (!valid()) return result('unverified', 'stale', outcome);
          if (combined.aborted) return result('unverified', 'interrupted', outcome);
          return result(accepted ? 'verified' : 'unverified', accepted ? 'fresh_site_evidence' : applied ? 'acceptance_not_observed' : 'application_not_observed', outcome);
        } catch (error) {
          // While the provider is awaiting its reservation hook it has not yet
          // reached dispatch; a late reservation may still consume capacity.
          const reported = reserving ? 'not-submitted' : ['not-submitted', 'unknown', 'submitted', 'rejected'].includes(error?.outcome) ? error.outcome : outcome;
          return result(reported === 'not-submitted' ? 'not_submitted' : 'unverified', navigated ? 'stale' : combined.aborted ? 'interrupted' : !valid() ? 'stale' : 'provider_or_application_failed', reported);
        } finally { await cleanup(); }
      },
    });
  } catch { await cleanup(); throw new Error(inspectionSignal.aborted ? 'inspection interrupted' : 'unsupported challenge'); }
}
