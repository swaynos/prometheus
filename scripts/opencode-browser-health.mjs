// Sanitized pre/post-login DOM health snapshot capture, differential signal
// extraction, schema normalization, and fast live session health evaluation.
// Never reads cookies, storage values, query strings, fragments, or input values.

export const HEALTH_CONTEXT_VERSION = 1;
const SNAPSHOT_KIND = "dom-health-snapshot-v1";
const DEFAULT_CAPTURE_TIMEOUT_MS = 2500;
const MAX_LANDMARKS = 15;
const MAX_CONTROLS = 40;
const MAX_HEADINGS = 10;
const MAX_ELEMENT_SELECTORS = 50;
const MAX_SIGNAL_SELECTORS = 10;
const MAX_URL_PATHS = 5;

const POSITIVE_AUTH_RE = /account|profile|user|member|avatar|logout|log-?out|sign-?out|signout|dashboard|settings|orders|billing|wallet|inbox|workspace|menu/i;
const NEGATIVE_AUTH_RE = /password|login|log-?in|sign-?in|signin|auth|sso|register|signup|sign-?up|forgot/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]*)?\b/g;
const OPAQUE_TOKEN_RE = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g;

export function sanitizeHealthUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl) return null;
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return null; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const pathname = (parsed.pathname || "/").slice(0, 200);
  return {
    origin: parsed.origin,
    pathname,
    url: `${parsed.origin}${pathname}`,
  };
}

export function redactText(value, maxLen = 80) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(BEARER_RE, "Bearer [redacted]")
    .replace(JWT_RE, "[redacted-token]")
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(OPAQUE_TOKEN_RE, "[redacted-token]")
    .slice(0, maxLen);
}

function sanitizeSelector(selector) {
  if (typeof selector !== "string") return null;
  const trimmed = selector.trim();
  if (!trimmed || trimmed.length > 160) return null;
  if (/[\r\n\0]/.test(trimmed)) return null;
  if (EMAIL_RE.test(trimmed) || JWT_RE.test(trimmed)) return null;
  EMAIL_RE.lastIndex = 0;
  JWT_RE.lastIndex = 0;
  return trimmed;
}

function sanitizeOrigin(raw) {
  if (typeof raw !== "string" || !raw) return null;
  let parsed;
  try { parsed = new URL(raw); } catch { return null; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return parsed.origin;
}

function sanitizePath(raw) {
  if (typeof raw !== "string" || !raw.startsWith("/")) return null;
  const clean = raw.split(/[?#]/)[0].trim();
  if (!clean || clean.length > 200) return null;
  return clean;
}

function uniqueBounded(items, limit) {
  const out = [];
  for (const item of items) {
    if (!item || out.includes(item)) continue;
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeCapturedSnapshot(raw, fallbackUrl) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.approvedOrigin === false) {
    const origin = sanitizeOrigin(raw.origin);
    if (!origin) return null;
    return {
      approvedOrigin: false,
      origin,
      redirectedToExternalAuth: Boolean(raw.redirectedToExternalAuth),
    };
  }
  const urlInfo = sanitizeHealthUrl(raw.url || fallbackUrl);
  if (!urlInfo) return null;
  const landmarks = (Array.isArray(raw.landmarks) ? raw.landmarks : [])
    .slice(0, MAX_LANDMARKS)
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const tag = typeof entry.tag === "string" ? entry.tag.toLowerCase().slice(0, 24) : "";
      if (!tag) return null;
      const selector = sanitizeSelector(entry.selector);
      const role = typeof entry.role === "string" && entry.role.trim() ? entry.role.trim().slice(0, 32) : undefined;
      const interactiveCount = Number.isInteger(entry.interactiveCount) && entry.interactiveCount >= 0
        ? Math.min(entry.interactiveCount, 1000)
        : 0;
      return {
        tag,
        ...(role ? { role } : {}),
        ...(selector ? { selector } : {}),
        interactiveCount,
      };
    })
    .filter(Boolean);

  const controls = (Array.isArray(raw.controls) ? raw.controls : [])
    .slice(0, MAX_CONTROLS)
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const tag = typeof entry.tag === "string" ? entry.tag.toLowerCase().slice(0, 24) : "";
      if (!tag) return null;
      const selector = sanitizeSelector(entry.selector);
      const type = typeof entry.type === "string" && entry.type.trim() ? entry.type.trim().toLowerCase().slice(0, 24) : undefined;
      const role = typeof entry.role === "string" && entry.role.trim() ? entry.role.trim().slice(0, 32) : undefined;
      const hrefPath = entry.hrefPath === "external" ? "external" : sanitizePath(entry.hrefPath);
      const label = redactText(entry.label, 60);
      return {
        tag,
        ...(type ? { type } : {}),
        ...(role ? { role } : {}),
        ...(selector ? { selector } : {}),
        ...(hrefPath ? { hrefPath } : {}),
        ...(label ? { label } : {}),
      };
    })
    .filter(Boolean);

  const headings = uniqueBounded(
    (Array.isArray(raw.headings) ? raw.headings : []).map((h) => redactText(h, 80)),
    MAX_HEADINGS,
  );
  const elementSelectors = uniqueBounded(
    (Array.isArray(raw.elementSelectors) ? raw.elementSelectors : []).map(sanitizeSelector),
    MAX_ELEMENT_SELECTORS,
  );

  return {
    approvedOrigin: true,
    url: urlInfo.url,
    origin: urlInfo.origin,
    pathname: urlInfo.pathname,
    title: redactText(raw.title, 120),
    hasAuthForm: Boolean(raw.hasAuthForm),
    headings,
    landmarks,
    controls,
    elementSelectors,
  };
}

function stripInternalSnapshotFields(snapshot) {
  if (!snapshot) return null;
  if (snapshot.approvedOrigin === false) {
    return {
      approvedOrigin: false,
      origin: snapshot.origin,
      redirectedToExternalAuth: Boolean(snapshot.redirectedToExternalAuth),
    };
  }
  return {
    approvedOrigin: true,
    url: snapshot.url,
    pathname: snapshot.pathname,
    title: snapshot.title,
    hasAuthForm: snapshot.hasAuthForm,
    headings: snapshot.headings,
    landmarks: snapshot.landmarks,
    controls: snapshot.controls,
  };
}

export async function captureLoginSnapshot(page, approvedOrigins = [], timeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS) {
  if (!page || typeof page.url !== "function" || typeof page.evaluate !== "function") return null;
  if (typeof page.isClosed === "function" && page.isClosed()) return null;

  const urlInfo = sanitizeHealthUrl(page.url());
  if (!urlInfo) return null;

  const approved = Array.isArray(approvedOrigins) ? approvedOrigins : [];
  if (approved.length > 0 && !approved.includes(urlInfo.origin)) {
    return {
      approvedOrigin: false,
      origin: urlInfo.origin,
      redirectedToExternalAuth: true,
    };
  }

  let timer;
  try {
    const evalPromise = page.evaluate(({ kind, maxLandmarks, maxControls, maxHeadings, maxSelectors }) => {
      const isVisible = (el) => {
        if (!el || !(el instanceof Element)) return false;
        if (el.matches('input[type="hidden"], [hidden], [aria-hidden="true"]')) return false;
        if (el.closest('[hidden], [aria-hidden="true"]')) return false;
        if (typeof el.checkVisibility === "function") {
          try {
            if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
          } catch {}
        }
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const cssEscape = (str) => {
        if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(str);
        return String(str).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
      };
      const attrEscape = (str) => String(str).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const looksDynamic = (val) =>
        !val || val.length > 64 || /\s/.test(val) || /^\d+$/.test(val) ||
        /[0-9a-f]{8}-[0-9a-f]{4}-/i.test(val) ||
        /^:?r[0-9a-z]+:?$/i.test(val) ||
        /^(?:radix|mui|ember|headlessui|react-aria)[-_]/i.test(val);

      const safeMatch = (el, candidate) => {
        if (!candidate || candidate.length > 160) return null;
        try { return el.matches(candidate) ? candidate : null; } catch { return null; }
      };

      const stableSelector = (el) => {
        const tag = el.tagName.toLowerCase();
        if (el.id && !looksDynamic(el.id)) {
          const hit = safeMatch(el, `#${cssEscape(el.id)}`);
          if (hit) return hit;
        }
        for (const attr of ["data-testid", "data-test", "data-qa", "data-cy"]) {
          const val = el.getAttribute(attr);
          if (val && val.length <= 80 && !/[\r\n"]/.test(val)) {
            const hit = safeMatch(el, `[${attr}="${attrEscape(val)}"]`);
            if (hit) return hit;
          }
        }
        if (tag === "input") {
          const type = (el.getAttribute("type") || "text").toLowerCase();
          if (type === "password") {
            const hit = safeMatch(el, 'input[type="password"]');
            if (hit) return hit;
          }
          const name = el.getAttribute("name");
          if (name && !looksDynamic(name)) {
            const hit = safeMatch(el, `input[name="${attrEscape(name)}"]`);
            if (hit) return hit;
          }
        }
        const aria = (el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
        if (aria && aria.length <= 60 && !/@/.test(aria)) {
          const hit = safeMatch(el, `${tag}[aria-label="${attrEscape(aria)}"]`);
          if (hit) return hit;
        }
        if (tag === "a" && el.hasAttribute("href")) {
          const rawHref = (el.getAttribute("href") || "").trim();
          if (rawHref && !rawHref.startsWith("javascript:") && !rawHref.startsWith("#")) {
            try {
              const parsed = new URL(rawHref, location.href);
              if (parsed.origin === location.origin && parsed.pathname) {
                if (rawHref === parsed.pathname) {
                  const exact = safeMatch(el, `a[href="${attrEscape(parsed.pathname)}"]`);
                  if (exact) return exact;
                }
                if (parsed.pathname.length > 1) {
                  const partial = safeMatch(el, `a[href*="${attrEscape(parsed.pathname)}"]`);
                  if (partial) return partial;
                }
              }
            } catch {}
          }
        }
        if (tag === "form" && el.hasAttribute("action")) {
          try {
            const parsed = new URL(el.getAttribute("action") || "", location.href);
            if (parsed.origin === location.origin && parsed.pathname && parsed.pathname.length > 1) {
              const hit = safeMatch(el, `form[action*="${attrEscape(parsed.pathname)}"]`);
              if (hit) return hit;
            }
          } catch {}
        }
        return null;
      };

      const hasAuthForm = Array.from(
        document.querySelectorAll('input[type="password"], input[autocomplete="current-password"], input[autocomplete="one-time-code"]'),
      ).some(isVisible);

      const landmarkSelector = 'header, nav, main, aside, footer, form, [role="navigation"], [role="banner"], [role="main"]';
      const controlSelector = 'button, a[href], input:not([type="hidden"]), select, [role="button"], [role="menuitem"], [role="link"]';

      const landmarks = [];
      for (const el of document.querySelectorAll(landmarkSelector)) {
        if (landmarks.length >= maxLandmarks) break;
        if (!isVisible(el)) continue;
        landmarks.push({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || undefined,
          selector: stableSelector(el) || undefined,
          interactiveCount: el.querySelectorAll(controlSelector).length,
        });
      }

      const controls = [];
      for (const el of document.querySelectorAll(controlSelector)) {
        if (controls.length >= maxControls) break;
        if (!isVisible(el)) continue;
        const tag = el.tagName.toLowerCase();
        const isInputLike = tag === "input" || tag === "textarea" || tag === "select";
        let hrefPath;
        if (tag === "a" && el.hasAttribute("href")) {
          try {
            const parsed = new URL(el.getAttribute("href") || "", location.href);
            hrefPath = parsed.origin === location.origin ? parsed.pathname : "external";
          } catch {}
        }
        // Never read .value on inputs/textareas/selects.
        const rawLabel = isInputLike
          ? (el.getAttribute("aria-label") || el.getAttribute("placeholder") || "")
          : (el.innerText || el.getAttribute("aria-label") || "");
        controls.push({
          tag,
          type: el.getAttribute("type") || undefined,
          role: el.getAttribute("role") || undefined,
          selector: stableSelector(el) || undefined,
          hrefPath,
          label: rawLabel.replace(/\s+/g, " ").trim().slice(0, 80),
        });
      }

      const headings = [];
      for (const el of document.querySelectorAll("h1, h2, h3")) {
        if (headings.length >= maxHeadings) break;
        if (!isVisible(el)) continue;
        const text = (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 100);
        if (text && !headings.includes(text)) headings.push(text);
      }

      const selectors = [];
      const pushSelector = (sel) => {
        if (sel && selectors.length < maxSelectors && !selectors.includes(sel)) selectors.push(sel);
      };
      for (const c of controls) pushSelector(c.selector);
      for (const l of landmarks) pushSelector(l.selector);
      for (const el of document.querySelectorAll("[id], [data-testid], [data-test], [data-qa], [data-cy], [aria-label]")) {
        if (selectors.length >= maxSelectors) break;
        if (!isVisible(el)) continue;
        pushSelector(stableSelector(el));
      }

      return {
        kind,
        approvedOrigin: true,
        url: `${location.origin}${location.pathname}`,
        origin: location.origin,
        pathname: location.pathname,
        title: (document.title || "").slice(0, 140),
        hasAuthForm,
        headings,
        landmarks,
        controls,
        elementSelectors: selectors,
      };
    }, {
      kind: SNAPSHOT_KIND,
      maxLandmarks: MAX_LANDMARKS,
      maxControls: MAX_CONTROLS,
      maxHeadings: MAX_HEADINGS,
      maxSelectors: MAX_ELEMENT_SELECTORS,
    });

    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(100, timeoutMs));
    });
    const raw = await Promise.race([evalPromise, timeoutPromise]);
    if (!raw || raw.kind !== SNAPSHOT_KIND) return null;
    if (approved.length > 0 && !approved.includes(raw.origin)) {
      return {
        approvedOrigin: false,
        origin: raw.origin,
        redirectedToExternalAuth: true,
      };
    }
    return normalizeCapturedSnapshot(raw, urlInfo.url);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function selectorStabilityScore(selector) {
  if (selector === 'input[type="password"]') return 60;
  if (selector.startsWith("#")) return 50;
  if (/^\[data-(?:testid|test|qa|cy)=/.test(selector)) return 48;
  if (selector.includes("[aria-label=")) return 35;
  if (selector.startsWith("a[href")) return 30;
  if (selector.startsWith("form[action")) return 28;
  if (selector.startsWith("input[name=")) return 26;
  return 15;
}

function scoreSelector(selector, mode, contextText = "") {
  let score = selectorStabilityScore(selector);
  const combined = `${selector} ${contextText}`;
  if (mode === "healthy") {
    if (POSITIVE_AUTH_RE.test(combined)) score += 40;
    if (NEGATIVE_AUTH_RE.test(combined)) score -= 50;
  } else {
    if (NEGATIVE_AUTH_RE.test(combined)) score += 45;
    if (POSITIVE_AUTH_RE.test(combined)) score -= 20;
  }
  return score;
}

function selectorLabelMap(snapshot) {
  const map = new Map();
  if (!snapshot?.approvedOrigin) return map;
  for (const control of snapshot.controls || []) {
    if (control.selector && control.label) map.set(control.selector, control.label);
  }
  return map;
}

export function buildHealthContext({ before = null, after, origins = [] } = {}) {
  const normAfter = normalizeCapturedSnapshot(after);
  if (!normAfter || !normAfter.approvedOrigin) return null;
  const normBefore = before ? normalizeCapturedSnapshot(before) : null;
  const beforeApproved = normBefore?.approvedOrigin ? normBefore : null;

  const beforeSelectors = new Set(beforeApproved?.elementSelectors || []);
  const afterSelectors = new Set(normAfter.elementSelectors || []);
  const beforeLabels = selectorLabelMap(beforeApproved);
  const afterLabels = selectorLabelMap(normAfter);

  const healthyCandidates = normAfter.elementSelectors
    .filter((sel) => !beforeSelectors.has(sel) && sel !== 'input[type="password"]')
    .map((sel) => ({ sel, score: scoreSelector(sel, "healthy", afterLabels.get(sel) || "") }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.sel.localeCompare(b.sel))
    .map((item) => item.sel);

  const rawUnhealthy = (beforeApproved?.elementSelectors || [])
    .filter((sel) => !afterSelectors.has(sel));
  if (beforeApproved?.hasAuthForm && !normAfter.hasAuthForm && !rawUnhealthy.includes('input[type="password"]')) {
    rawUnhealthy.unshift('input[type="password"]');
  }
  const unhealthyCandidates = rawUnhealthy
    .map((sel) => ({ sel, score: scoreSelector(sel, "unhealthy", beforeLabels.get(sel) || "") }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.sel.localeCompare(b.sel))
    .map((item) => item.sel);

  const externalAuthOrigins = normBefore?.approvedOrigin === false && normBefore.origin
    ? [normBefore.origin]
    : [];
  const unhealthyUrlPaths = beforeApproved && beforeApproved.pathname !== normAfter.pathname
    ? [beforeApproved.pathname]
    : [];

  return normaliseHealthContext({
    version: HEALTH_CONTEXT_VERSION,
    capturedAt: new Date().toISOString(),
    checkUrl: normAfter.url,
    loginUrl: beforeApproved ? beforeApproved.url : null,
    sameUrlComparison: Boolean(beforeApproved && beforeApproved.url === normAfter.url),
    signals: {
      healthySelectors: uniqueBounded(healthyCandidates, MAX_SIGNAL_SELECTORS),
      unhealthySelectors: uniqueBounded(unhealthyCandidates, MAX_SIGNAL_SELECTORS),
      unhealthyUrlPaths: uniqueBounded(unhealthyUrlPaths, MAX_URL_PATHS),
      externalAuthOrigins: uniqueBounded(externalAuthOrigins, MAX_URL_PATHS),
    },
    before: stripInternalSnapshotFields(normBefore),
    after: stripInternalSnapshotFields(normAfter),
  }, origins);
}

export function normaliseHealthContext(health, allowedOrigins = []) {
  if (health === undefined || health === null) return undefined;
  if (!health || typeof health !== "object" || Array.isArray(health)) {
    throw new Error("health context must be an object");
  }
  const checkInfo = sanitizeHealthUrl(health.checkUrl);
  if (!checkInfo) throw new Error("health context checkUrl must be an http(s) URL");
  if (Array.isArray(allowedOrigins) && allowedOrigins.length > 0 && !allowedOrigins.includes(checkInfo.origin)) {
    throw new Error("health context checkUrl origin must be one of the approved origins");
  }
  const loginInfo = health.loginUrl ? sanitizeHealthUrl(health.loginUrl) : null;
  const rawSignals = health.signals && typeof health.signals === "object" ? health.signals : {};

  const signals = {
    healthySelectors: uniqueBounded(
      (Array.isArray(rawSignals.healthySelectors) ? rawSignals.healthySelectors : []).map(sanitizeSelector),
      MAX_SIGNAL_SELECTORS,
    ),
    unhealthySelectors: uniqueBounded(
      (Array.isArray(rawSignals.unhealthySelectors) ? rawSignals.unhealthySelectors : []).map(sanitizeSelector),
      MAX_SIGNAL_SELECTORS,
    ),
    unhealthyUrlPaths: uniqueBounded(
      (Array.isArray(rawSignals.unhealthyUrlPaths) ? rawSignals.unhealthyUrlPaths : []).map(sanitizePath),
      MAX_URL_PATHS,
    ),
    externalAuthOrigins: uniqueBounded(
      (Array.isArray(rawSignals.externalAuthOrigins) ? rawSignals.externalAuthOrigins : []).map(sanitizeOrigin),
      MAX_URL_PATHS,
    ),
  };

  const normBefore = health.before ? stripInternalSnapshotFields(normalizeCapturedSnapshot(health.before)) : null;
  const normAfter = health.after ? stripInternalSnapshotFields(normalizeCapturedSnapshot(health.after, checkInfo.url)) : null;
  const capturedAt = typeof health.capturedAt === "string" && !Number.isNaN(Date.parse(health.capturedAt))
    ? health.capturedAt
    : new Date().toISOString();

  return {
    version: HEALTH_CONTEXT_VERSION,
    capturedAt,
    checkUrl: checkInfo.url,
    loginUrl: loginInfo ? loginInfo.url : null,
    sameUrlComparison: Boolean(health.sameUrlComparison && loginInfo && loginInfo.url === checkInfo.url),
    signals,
    before: normBefore,
    after: normAfter,
  };
}

export function classifyLiveHealth({ live, health, approvedOrigins = [] }) {
  const checkInfo = sanitizeHealthUrl(health?.checkUrl);
  const allowed = Array.isArray(approvedOrigins) && approvedOrigins.length > 0
    ? approvedOrigins
    : (checkInfo ? [checkInfo.origin] : []);
  const signals = health?.signals || {
    healthySelectors: [],
    unhealthySelectors: [],
    unhealthyUrlPaths: [],
    externalAuthOrigins: [],
  };

  if (!live || !live.url) {
    return {
      status: "inconclusive",
      reason: "active page does not have an http(s) URL",
    };
  }
  if (live.httpStatus === 401 || live.httpStatus === 403) {
    return {
      status: "unhealthy",
      reason: `page returned HTTP ${live.httpStatus}`,
    };
  }
  if (allowed.length > 0 && !allowed.includes(live.origin)) {
    const knownExternal = (signals.externalAuthOrigins || []).includes(live.origin);
    return {
      status: "unhealthy",
      reason: knownExternal
        ? `redirected to captured external auth origin ${live.origin}`
        : `redirected off approved origin to ${live.origin}`,
    };
  }

  const matchedHealthy = live.matchedHealthySelectors || [];
  const matchedUnhealthy = live.matchedUnhealthySelectors || [];
  const onUnhealthyPath = (signals.unhealthyUrlPaths || []).includes(live.pathname) && live.url !== health?.checkUrl;
  const unexpectedAuthForm = Boolean(live.hasAuthForm && !health?.after?.hasAuthForm);
  const onCheckUrl = Boolean(health?.checkUrl && live.url === health.checkUrl);
  const expectedHealthyCount = (signals.healthySelectors || []).length;
  const expectedUnhealthyCount = (signals.unhealthySelectors || []).length;

  if (onUnhealthyPath && (matchedUnhealthy.length > 0 || unexpectedAuthForm || matchedHealthy.length === 0)) {
    return {
      status: "unhealthy",
      reason: `page is on pre-login path ${live.pathname}${unexpectedAuthForm ? " with visible authentication form" : ""}`,
    };
  }
  if (matchedUnhealthy.length > 0 && matchedHealthy.length === 0) {
    return {
      status: "unhealthy",
      reason: `matched ${matchedUnhealthy.length} pre-login unhealthy selector(s): ${matchedUnhealthy.join(", ")}`,
    };
  }
  if (unexpectedAuthForm && matchedHealthy.length === 0) {
    return {
      status: "unhealthy",
      reason: "visible authentication form detected (absent in post-login snapshot)",
    };
  }
  if (onCheckUrl && expectedHealthyCount > 0 && matchedHealthy.length === 0) {
    return {
      status: "unhealthy",
      reason: "on checkUrl but none of the expected post-login healthy selectors are visible",
    };
  }
  if (matchedHealthy.length > 0 && matchedUnhealthy.length === 0 && !unexpectedAuthForm && !onUnhealthyPath) {
    return {
      status: "healthy",
      reason: `matched ${matchedHealthy.length} post-login healthy selector(s) with no pre-login auth controls`,
    };
  }
  if (matchedHealthy.length > 0 && (matchedUnhealthy.length > 0 || unexpectedAuthForm)) {
    return {
      status: "inconclusive",
      reason: "both healthy and unhealthy indicators are visible; inspect the page directly",
    };
  }
  if (expectedHealthyCount === 0 && expectedUnhealthyCount === 0) {
    return {
      status: "inconclusive",
      reason: "no distinguishing DOM selectors were captured between pre-login and post-login snapshots; verify task access directly",
    };
  }
  return {
    status: "inconclusive",
    reason: `current page ${live.pathname} differs from checkUrl ${health?.checkUrl || "(unknown)"}; navigate to checkUrl or pass navigate_to_check_url: true`,
  };
}

export async function evaluatePageHealth(page, health, { httpStatus = null, approvedOrigins = [], timeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS } = {}) {
  if (!page || typeof page.url !== "function" || (typeof page.isClosed === "function" && page.isClosed())) {
    const live = {
      url: null,
      origin: null,
      pathname: null,
      httpStatus,
      hasAuthForm: false,
      matchedHealthySelectors: [],
      matchedUnhealthySelectors: [],
    };
    return { ...classifyLiveHealth({ live, health, approvedOrigins }), live };
  }

  const urlInfo = sanitizeHealthUrl(page.url());
  if (!urlInfo) {
    const live = {
      url: null,
      origin: null,
      pathname: null,
      httpStatus,
      hasAuthForm: false,
      matchedHealthySelectors: [],
      matchedUnhealthySelectors: [],
    };
    return { ...classifyLiveHealth({ live, health, approvedOrigins }), live };
  }

  const checkInfo = sanitizeHealthUrl(health?.checkUrl);
  const allowed = Array.isArray(approvedOrigins) && approvedOrigins.length > 0
    ? approvedOrigins
    : (checkInfo ? [checkInfo.origin] : []);

  if (httpStatus === 401 || httpStatus === 403 || (allowed.length > 0 && !allowed.includes(urlInfo.origin))) {
    const live = {
      url: urlInfo.url,
      origin: urlInfo.origin,
      pathname: urlInfo.pathname,
      httpStatus,
      hasAuthForm: false,
      matchedHealthySelectors: [],
      matchedUnhealthySelectors: [],
    };
    return { ...classifyLiveHealth({ live, health, approvedOrigins: allowed }), live };
  }

  const healthySelectors = health?.signals?.healthySelectors || [];
  const unhealthySelectors = health?.signals?.unhealthySelectors || [];

  let timer;
  let observed = null;
  try {
    const evalPromise = page.evaluate(({ healthySels, unhealthySels }) => {
      const isVisible = (el) => {
        if (!el || !(el instanceof Element)) return false;
        if (el.matches('input[type="hidden"], [hidden], [aria-hidden="true"]')) return false;
        if (el.closest('[hidden], [aria-hidden="true"]')) return false;
        if (typeof el.checkVisibility === "function") {
          try {
            if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
          } catch {}
        }
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const matchesVisible = (selector) => {
        try {
          return Array.from(document.querySelectorAll(selector)).some(isVisible);
        } catch {
          return false;
        }
      };
      const hasAuthForm = Array.from(
        document.querySelectorAll('input[type="password"], input[autocomplete="current-password"], input[autocomplete="one-time-code"]'),
      ).some(isVisible);

      return {
        matchedHealthySelectors: healthySels.filter(matchesVisible),
        matchedUnhealthySelectors: unhealthySels.filter(matchesVisible),
        hasAuthForm,
      };
    }, { healthySels: healthySelectors, unhealthySels: unhealthySelectors });

    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(100, timeoutMs));
    });
    observed = await Promise.race([evalPromise, timeoutPromise]);
  } catch {
    observed = null;
  } finally {
    clearTimeout(timer);
  }

  if (!observed) {
    const live = {
      url: urlInfo.url,
      origin: urlInfo.origin,
      pathname: urlInfo.pathname,
      httpStatus,
      hasAuthForm: false,
      matchedHealthySelectors: [],
      matchedUnhealthySelectors: [],
    };
    return {
      status: "inconclusive",
      reason: "live DOM evaluation was interrupted or timed out; inspect the page directly",
      live,
    };
  }

  const live = {
    url: urlInfo.url,
    origin: urlInfo.origin,
    pathname: urlInfo.pathname,
    httpStatus,
    hasAuthForm: Boolean(observed.hasAuthForm),
    matchedHealthySelectors: observed.matchedHealthySelectors,
    matchedUnhealthySelectors: observed.matchedUnhealthySelectors,
  };
  return { ...classifyLiveHealth({ live, health, approvedOrigins: allowed }), live };
}
