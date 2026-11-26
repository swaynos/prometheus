import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import {
  buildHealthContext,
  captureLoginSnapshot,
  classifyLiveHealth,
  evaluatePageHealth,
  normaliseHealthContext,
  redactText,
  sanitizeHealthUrl,
} from "../../scripts/opencode-browser-health.mjs";

test("sanitizeHealthUrl strips query strings and fragments and rejects non-http(s) schemes", () => {
  assert.deepEqual(sanitizeHealthUrl("https://site.example/dashboard?token=SECRET123#frag"), {
    origin: "https://site.example",
    pathname: "/dashboard",
    url: "https://site.example/dashboard",
  });
  assert.equal(sanitizeHealthUrl("javascript:alert(1)"), null);
  assert.equal(sanitizeHealthUrl("about:blank"), null);
});

test("redactText scrubs emails, bearer tokens, JWTs, and opaque secrets", () => {
  assert.equal(redactText("Signed in as alice.smith@example.com"), "Signed in as [redacted-email]");
  assert.equal(redactText("Bearer abcdefgh1234567890"), "Bearer [redacted]");
  assert.equal(
    redactText("Token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature"),
    "Token [redacted-token]",
  );
  assert.equal(redactText("Key a1b2c3d4e5f6g7h8i9j0k1l2m3n4"), "Key [redacted-token]");
});

test("health normalization repeatedly rejects sensitive selectors and paths, including URL and CSS escapes", () => {
  const email = "alice@example.com";
  const token = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4";
  const selectors = [
    `[data-testid="${email}"]`, `[data-testid="${email}"]`,
    "#alice\\@example\\.com", "#alice\\40 example\\2e com",
    `[data-testid="${encodeURIComponent(email)}"]`,
    `#account-${token}`, `[aria-label="Bearer ${token}"]`,
    "#eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature",
  ];
  for (let i = 0; i < 3; i++) {
    const health = normaliseHealthContext({
      checkUrl: "https://site.example/",
      loginUrl: `https://site.example/reset/${token}`,
      signals: {
        healthySelectors: [...selectors, "#account-menu"],
        unhealthySelectors: [...selectors, 'input[type="password"]'],
        unhealthyUrlPaths: [`/user/${encodeURIComponent(email)}`, `/reset/${token}`, "/login"],
      },
      after: {
        approvedOrigin: true, url: "https://site.example/",
        controls: selectors.map(selector => ({
          tag: "button", selector, hrefPath: `/user/${email}`, label: email, role: token,
        })),
        landmarks: selectors.map(selector => ({ tag: "nav", selector })),
      },
    }, ["https://site.example"]);
    assert.deepEqual(health.signals.healthySelectors, ["#account-menu"]);
    assert.deepEqual(health.signals.unhealthySelectors, ['input[type="password"]']);
    assert.deepEqual(health.signals.unhealthyUrlPaths, ["/login"]);
    assert.equal(health.loginUrl, null);
    assert.ok(health.after.controls.every(control => !control.selector && !control.hrefPath));
    assert.ok(health.after.landmarks.every(landmark => !landmark.selector));
    assert.doesNotMatch(JSON.stringify(health), /alice|a1b2c3|eyJhbG/);
  }
  assert.equal(sanitizeHealthUrl(`https://site.example/reset/${token}`), null);
  assert.equal(sanitizeHealthUrl(`https://site.example/user/${encodeURIComponent(email)}`), null);
  assert.throws(() => normaliseHealthContext({ checkUrl: `https://site.example/reset/${token}` }), /checkUrl/);
});

test("generic public DOM changes cannot establish healthy account indicators", () => {
  const snapshot = elementSelectors => ({
    approvedOrigin: true, url: "https://site.example/", hasAuthForm: false, elementSelectors,
  });
  const health = buildHealthContext({
    before: snapshot([]), after: snapshot(["#promo-banner", "#menu", "#dashboard"]),
    origins: ["https://site.example"],
  });
  assert.deepEqual(health.signals.healthySelectors, []);
  assert.equal(classifyLiveHealth({
    health,
    live: { url: health.checkUrl, origin: "https://site.example", pathname: "/",
      httpStatus: 200, hasAuthForm: false, matchedHealthySelectors: [], matchedUnhealthySelectors: [] },
  }).status, "inconclusive");
  // Old captures are re-filtered when read, not trusted as account evidence.
  assert.deepEqual(normaliseHealthContext({
    checkUrl: health.checkUrl, signals: { healthySelectors: ["#promo-banner"] },
  }).signals.healthySelectors, []);
});

test("captureLoginSnapshot and buildHealthContext capture same-URL before/after diff without leaking secrets", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route("https://site.example/**", (route) => route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><title>Store alice@example.com</title></head><body>
        <header>
          <a id="sign-in-link" href="/login?next=secret-query">Sign in</a>
          <button id="account-menu" hidden>Account alice@example.com</button>
          <a id="logout-link" href="/logout" hidden>Sign out</a>
        </header>
        <main>
          <h1>Welcome</h1>
          <form id="login-form" action="/login">
            <input name="email" type="email" value="alice@example.com" placeholder="Email">
            <input name="password" type="password" value="SUPER-SECRET-PASS" placeholder="Password">
            <input type="hidden" name="csrf" value="HIDDEN-CSRF-TOKEN-9999999999">
            <button id="login-submit" type="submit">Log in</button>
          </form>
        </main>
      </body></html>`,
    }));

    const page = await context.newPage();
    await page.goto("https://site.example/?oauth_code=QUERY-SECRET-VALUE#hash-secret");
    const before = await captureLoginSnapshot(page, ["https://site.example"]);
    assert.equal(before.approvedOrigin, true);
    assert.equal(before.url, "https://site.example/");
    assert.equal(before.hasAuthForm, true);
    assert.ok(before.elementSelectors.includes('input[type="password"]'));
    assert.ok(before.elementSelectors.includes("#sign-in-link"));
    assert.ok(!before.elementSelectors.includes("#account-menu"), "hidden account menu excluded before login");

    // Simulate user completing login on the same page
    await page.evaluate(() => {
      document.getElementById("login-form").hidden = true;
      document.getElementById("sign-in-link").hidden = true;
      document.getElementById("account-menu").hidden = false;
      document.getElementById("logout-link").hidden = false;
    });
    const after = await captureLoginSnapshot(page, ["https://site.example"]);
    assert.equal(after.hasAuthForm, false);
    assert.ok(after.elementSelectors.includes("#account-menu"));
    assert.ok(after.elementSelectors.includes("#logout-link"));

    const health = buildHealthContext({ before, after, origins: ["https://site.example"] });
    const serialized = JSON.stringify(health);
    assert.doesNotMatch(serialized, /SUPER-SECRET-PASS|HIDDEN-CSRF-TOKEN|QUERY-SECRET-VALUE|hash-secret|alice@example\.com/);
    assert.equal(health.checkUrl, "https://site.example/");
    assert.equal(health.sameUrlComparison, true);
    assert.ok(health.signals.healthySelectors.includes("#account-menu"));
    assert.ok(health.signals.healthySelectors.includes("#logout-link"));
    assert.ok(health.signals.unhealthySelectors.includes('input[type="password"]'));
    assert.ok(health.signals.unhealthySelectors.includes("#sign-in-link"));

    // Live healthy check
    const healthyVerdict = await evaluatePageHealth(page, health, {
      httpStatus: 200,
      approvedOrigins: ["https://site.example"],
    });
    assert.equal(healthyVerdict.status, "healthy");
    assert.ok(healthyVerdict.live.matchedHealthySelectors.includes("#account-menu"));
    assert.deepEqual(healthyVerdict.live.matchedUnhealthySelectors, []);

    // Simulate session expiration (logged-out DOM returns)
    await page.evaluate(() => {
      document.getElementById("login-form").hidden = false;
      document.getElementById("sign-in-link").hidden = false;
      document.getElementById("account-menu").hidden = true;
      document.getElementById("logout-link").hidden = true;
    });
    const unhealthyVerdict = await evaluatePageHealth(page, health, {
      httpStatus: 200,
      approvedOrigins: ["https://site.example"],
    });
    assert.equal(unhealthyVerdict.status, "unhealthy");
    assert.equal(unhealthyVerdict.live.hasAuthForm, true);
    assert.ok(unhealthyVerdict.live.matchedUnhealthySelectors.includes('input[type="password"]'));
  } finally {
    await browser.close();
  }
});

test("captureLoginSnapshot handles external SSO redirects without reading foreign DOM", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route("https://idp.example/**", (route) => route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><body><h1 id="idp-secret">Foreign SSO DOM</h1><input type="password" value="idp-secret"></body></html>',
    }));
    await context.route("https://app.example/**", (route) => route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><body><nav id="user-nav"><a href="/logout">Logout</a></nav><main><h1>Dashboard</h1></main></body></html>',
    }));

    const page = await context.newPage();
    await page.goto("https://idp.example/oauth/authorize?client_id=secret123");
    const before = await captureLoginSnapshot(page, ["https://app.example"]);
    assert.deepEqual(before, {
      approvedOrigin: false,
      origin: "https://idp.example",
      redirectedToExternalAuth: true,
    });

    await page.goto("https://app.example/dashboard");
    const after = await captureLoginSnapshot(page, ["https://app.example"]);
    const health = buildHealthContext({ before, after, origins: ["https://app.example"] });
    assert.doesNotMatch(JSON.stringify(health), /Foreign SSO DOM|idp-secret|client_id/);
    assert.deepEqual(health.signals.externalAuthOrigins, ["https://idp.example"]);
    assert.equal(health.checkUrl, "https://app.example/dashboard");
    assert.ok(health.signals.healthySelectors.includes("#user-nav"));

    // Navigating back to IdP marks unhealthy immediately
    await page.goto("https://idp.example/oauth/authorize");
    const redirected = await evaluatePageHealth(page, health, {
      httpStatus: 200,
      approvedOrigins: ["https://app.example"],
    });
    assert.equal(redirected.status, "unhealthy");
    assert.match(redirected.reason, /external auth origin https:\/\/idp\.example/);
  } finally {
    await browser.close();
  }
});

test("classifyLiveHealth distinguishes healthy, unhealthy, and inconclusive states", () => {
  const health = normaliseHealthContext({
    checkUrl: "https://app.example/dashboard",
    loginUrl: "https://app.example/login",
    sameUrlComparison: false,
    signals: {
      healthySelectors: ["#user-nav"],
      unhealthySelectors: ['input[type="password"]'],
      unhealthyUrlPaths: ["/login"],
      externalAuthOrigins: [],
    },
    before: { approvedOrigin: true, url: "https://app.example/login", hasAuthForm: true },
    after: { approvedOrigin: true, url: "https://app.example/dashboard", hasAuthForm: false },
  }, ["https://app.example"]);

  assert.equal(classifyLiveHealth({
    health,
    live: { url: "https://app.example/dashboard", origin: "https://app.example", pathname: "/dashboard", httpStatus: 200, hasAuthForm: false, matchedHealthySelectors: ["#user-nav"], matchedUnhealthySelectors: [] },
  }).status, "healthy");

  assert.equal(classifyLiveHealth({
    health,
    live: { url: "https://app.example/dashboard", origin: "https://app.example", pathname: "/dashboard", httpStatus: 200, hasAuthForm: false, matchedHealthySelectors: [], matchedUnhealthySelectors: [] },
  }).status, "unhealthy");

  assert.equal(classifyLiveHealth({
    health,
    live: { url: "https://app.example/login", origin: "https://app.example", pathname: "/login", httpStatus: 200, hasAuthForm: true, matchedHealthySelectors: [], matchedUnhealthySelectors: ['input[type="password"]'] },
  }).status, "unhealthy");

  assert.equal(classifyLiveHealth({
    health,
    live: { url: "https://app.example/dashboard", origin: "https://app.example", pathname: "/dashboard", httpStatus: 401, hasAuthForm: false, matchedHealthySelectors: [], matchedUnhealthySelectors: [] },
  }).status, "unhealthy");

  const subpage = classifyLiveHealth({
    health,
    live: { url: "https://app.example/about", origin: "https://app.example", pathname: "/about", httpStatus: 200, hasAuthForm: false, matchedHealthySelectors: [], matchedUnhealthySelectors: [] },
  });
  assert.equal(subpage.status, "inconclusive");
  assert.match(subpage.reason, /checkUrl/);

  const noSignals = normaliseHealthContext({
    checkUrl: "https://app.example/",
    signals: { healthySelectors: [], unhealthySelectors: [], unhealthyUrlPaths: [], externalAuthOrigins: [] },
  }, ["https://app.example"]);
  assert.equal(classifyLiveHealth({
    health: noSignals,
    live: { url: "https://app.example/", origin: "https://app.example", pathname: "/", httpStatus: 200, hasAuthForm: false, matchedHealthySelectors: [], matchedUnhealthySelectors: [] },
  }).status, "inconclusive");
});
