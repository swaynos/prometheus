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

// navigationStatus must be fresh evidence for this exact main-frame document.
// acceptSelector is a trusted, caller-specified site success signal which must
// not be visible before application. No page strings are returned to the caller.
export async function inspectTurnstileLifecycle({ page, context, getBinding, navigationStatus, acceptSelector, timeoutMs = 15000, signal }) {
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
    const evaluation = page.evaluateHandle(() => {
      const isManaged = () => {
        const title = document.title.trim(), body = document.body?.innerText || '';
        const managed = /^(?:just a moment[.!\s…]*|checking your browser.*|attention required.*cloudflare.*|verify (?:that )?you are human[.!\s]*)$/i.test(title) && /checking your browser|verify (?:that )?you are human|performing security verification|enable javascript and cookies to continue/i.test(body);
        return Boolean(managed || document.querySelector('iframe[src*="/cdn-cgi/challenge-platform/"],form[action*="/cdn-cgi/challenge-platform/"]'));
      };
      if (isManaged()) return null;
      const widgets = [...document.querySelectorAll('.cf-turnstile')];
      if (widgets.length !== 1) return null;
      const widget = widgets[0], rect = widget.getBoundingClientRect();
      const name = widget.getAttribute('data-callback'), key = widget.getAttribute('data-sitekey');
      if (!rect.width || !rect.height || getComputedStyle(widget).visibility !== 'visible' || !key || key.length > 2048 || !/^[A-Za-z_$][\w$]*$/.test(name || '') || widget.hasAttribute('data-action') || widget.hasAttribute('data-cdata') || widget.hasAttribute('data-chl-page-data')) return null;
      const descriptor = Object.getOwnPropertyDescriptor(window, name);
      if (!descriptor || typeof descriptor.value !== 'function') return null;
      return { widget, callback: descriptor.value, name, key, document, isManaged };
    });
    // A timed-out evaluateHandle may resolve later; dispose that remote handle
    // without making the caller wait for a stalled renderer.
    void evaluation.then(late => { if (disposed || inspectionSignal.aborted) void late.dispose().catch(() => {}); }, () => {});
    handle = await bounded(() => evaluation, inspectionSignal);
    const key = await bounded(() => handle.evaluate(value => value?.key || null), inspectionSignal);
    if (!key || !valid() || await bounded(() => page.locator(acceptSelector).first().isVisible(), inspectionSignal) || inspectionSignal.aborted) throw new Error('unsupported challenge');
    const websiteURL = url.href;
    return Object.freeze({
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
          const provider = createProvider({ websiteURL, websiteKey: key });
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
            onReady: async (token, s) => {
              if (typeof protectToken === 'function') protectToken(token);
              outcome = 'submitted';
              if (!valid() || s.aborted) throw new Error('stale');
              if (await bounded(() => page.locator(acceptSelector).first().isVisible(), s)) throw new Error('preexisting evidence');
              if (!valid() || s.aborted) throw new Error('stale');
              // The captured widget, document and own global callback must still
              // be identical at the instant of invocation. Never return token.
              const invoked = await bounded(() => handle.evaluate((value, args) => {
                const evidence = document.querySelector(args.acceptSelector);
                if (evidence && evidence.getClientRects().length && getComputedStyle(evidence).visibility === 'visible') return false;
                if (Date.now() >= args.expiresAt || !value || document !== value.document || value.isManaged() || !value.widget.isConnected || value.widget.ownerDocument !== document || document.querySelectorAll('.cf-turnstile').length !== 1 || value.widget.getAttribute('data-sitekey') !== value.key || value.widget.getAttribute('data-callback') !== value.name || value.widget.hasAttribute('data-action') || value.widget.hasAttribute('data-cdata') || value.widget.hasAttribute('data-chl-page-data') || Object.getOwnPropertyDescriptor(window, value.name)?.value !== value.callback) return false;
                const rect = value.widget.getBoundingClientRect();
                if (!rect.width || !rect.height || getComputedStyle(value.widget).visibility !== 'visible') return false;
                value.callback(args.token); return true;
              }, { token, expiresAt, acceptSelector }), s);
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
