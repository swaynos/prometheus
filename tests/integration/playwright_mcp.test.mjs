import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { spawnMcpClient as client } from "./helpers.mjs";

function fixtureServer() {
  const httpServer = http.createServer((req, res) => {
    if (req.url === "/turnstile-widget") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<!doctype html><title>Form</title><div class="cf-turnstile" style="width:300px;height:65px" data-sitekey="PRIVATE_SITE_KEY" data-callback="privateCallback"></div><script>window.privateCallback=()=>{};</script>');
      return;
    }
    if (req.url === "/turnstile-docs") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<!doctype html><title>Integration guide</title><h1>Documentation: verify you are human</h1><p>Do not retry an access denied result.</p><div class="cf-turnstile" style="width:300px;height:65px" data-sitekey="PRIVATE_SITE_KEY" data-callback="privateCallback"></div><script>window.privateCallback=()=>{};</script>');
      return;
    }
    if (["/challenge", "/challenge-ok"].includes(req.url)) {
      res.writeHead(req.url === "/challenge" ? 403 : 200, { "content-type": "text/html" });
      res.end("<!doctype html><title>Just a moment...</title><h1>Checking your browser before accessing example.com</h1>");
      return;
    }
    if (req.url === "/cloudflare-docs") {
      res.setHeader("content-type", "text/html");
      res.end("<!doctype html><title>Cloudflare documentation</title><h1>How to handle a Cloudflare challenge</h1>");
      return;
    }
    if (req.url === "/delayed-ready") {
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html><title>Readiness fixture</title><script>
        setTimeout(() => { const button = document.createElement('button'); button.id = 'ready'; button.textContent = 'Ready'; document.body.append(button); }, 150);
      </script><body><p>Loading application</p></body>`);
      return;
    }
    if (req.url === "/denied") {
      res.writeHead(403, { "content-type": "text/html" });
      res.end('<!doctype html><title>Denied</title><h1>Access denied</h1><button id="account-menu">Public account</button>');
      return;
    }
    if (req.url === "/second") {
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html><html><body><h1>Second Page</h1><p id="msg">pending</p>
        <script>setTimeout(() => { document.getElementById("msg").textContent = "ready-now"; }, 150);</script>
      </body></html>`);
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><html><body>
      <h1>Fixture Home</h1>
      <input id="name" type="text">
      <button id="go" onclick="document.getElementById('out').textContent='clicked!'">Go</button>
      <textarea id="fallback" aria-label="Message" style="display:none"></textarea>
      <div id="editor" contenteditable="true" role="textbox" aria-label="Message"></div>
      <div id="plain-editor" contenteditable="plaintext-only" aria-label="Plain message"></div>
      <button id="blocked" aria-disabled="true" onclick="document.getElementById('out').textContent='should-not-run'">Blocked</button>
      <button id="account-menu" hidden>Signed in account</button>
      <div id="out"></div>
      <a href="/second">Second</a>
      <script>if (localStorage.getItem("authenticated") === "yes") document.getElementById("account-menu").hidden = false;</script>
    </body></html>`);
  });
  return new Promise((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const { port } = httpServer.address();
      resolve({ httpServer, base: `http://127.0.0.1:${port}` });
    });
  });
}

test("challenge inspection is redacted and solving is fail-closed", async () => {
  const { httpServer, base } = await fixtureServer();
  const c = client({ PROMETHEUS_CONFIG_DIR: "" });
  try {
    await c.call("browser_navigate", { url: `${base}/turnstile-widget` });
    const inspected = c.textOf(await c.call("browser_challenge_inspect"));
    assert.deepEqual(JSON.parse(inspected), { status: "candidate", type: "TurnstileTaskProxyless", solve_available: false });
    assert.doesNotMatch(inspected, /PRIVATE_SITE_KEY|privateCallback/);
    assert.equal(JSON.parse(c.textOf(await c.call("browser_challenge_solve", {}))).reason, "explicit_authorization_and_limits_required");
    assert.deepEqual(JSON.parse(c.textOf(await c.call("browser_challenge_solve", { authorize_paid: true, max_cost_usd: 1, max_tasks: 1 }))), { status: "not_submitted", reason: "disabled" });
    await c.call("browser_navigate", { url: `${base}/turnstile-docs` });
    assert.equal(JSON.parse(c.textOf(await c.call("browser_challenge_inspect"))).status, "candidate");
    await c.call("browser_navigate", { url: `data:text/html,${encodeURIComponent('<div class="cf-turnstile" style="width:300px;height:65px" data-sitekey="x" data-callback="cb"></div>')}` });
    assert.equal(JSON.parse(c.textOf(await c.call("browser_challenge_inspect"))).reason, "navigation_denied_or_unverified");
    await c.call("browser_navigate", { url: `${base}/challenge` });
    assert.equal(JSON.parse(c.textOf(await c.call("browser_challenge_inspect"))).status, "unsupported");
    await c.call("browser_navigate", { url: `${base}/challenge-ok` });
    assert.equal(JSON.parse(c.textOf(await c.call("browser_challenge_inspect"))).status, "unsupported");
  } finally { await closeFixture(httpServer, c); }
});

test("configured provider still rejects without durable budget and hides key path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-challenge-config-"));
  await writeFile(path.join(root, "prometheus-browser.json"), JSON.stringify({ channel: "default", captcha: { enabled: true, provider: "2captcha", keyFile: "/private/secret-key-location", timeoutMs: 1000, pollIntervalMs: 10 } }));
  const c = client({ PROMETHEUS_CONFIG_DIR: root });
  try {
    const result = c.textOf(await c.call("browser_challenge_solve", { authorize_paid: true, max_cost_usd: 1, max_tasks: 1 }));
    assert.deepEqual(JSON.parse(result), { status: "not_submitted", reason: "budget_enforcement_unavailable" });
    assert.doesNotMatch(c.textOf(await c.call("browser_status")), /secret-key-location/);
  } finally { try { await c.close(); } finally { await rm(root, { recursive: true, force: true }); } }
});

async function closeFixture(server, ...clients) {
  const results = await Promise.allSettled(clients.map(client => client.close()));
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
  if (failures.length) throw new AggregateError(failures, "MCP fixture shutdown failed");
}

async function stateConfig(base, selector) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cuddly-browser-state-"));
  const sessions = path.join(root, "prometheus-sessions");
  await mkdir(sessions, { mode: 0o700 });
  const origin = new URL(base).origin;
  await writeFile(path.join(sessions, "account.json"), JSON.stringify({
    schemaVersion: 1,
    name: "account",
    origins: [origin],
    capturedAt: new Date().toISOString(),
    storageState: {
      cookies: [],
      origins: [{ origin, localStorage: [{ name: "authenticated", value: "yes" }] }],
    },
    verification: typeof selector === "string" ? { selector } : selector,
  }), { mode: 0o600 });
  return root;
}

const channels = [...new Set(["default", "chromium", process.env.PROMETHEUS_TEST_BROWSER_CHANNEL].filter(Boolean))];

for (const channel of channels) {
  test(`managed ${channel} browser reports its applied launch options`, async () => {
    const { httpServer, base } = await fixtureServer();
    const c = client({ PROMETHEUS_BROWSER_CHANNEL: channel, PROMETHEUS_CONFIG_DIR: "" });
    try {
      const result = await c.call("browser_navigate", { url: base });
      assert.equal(result.isError, undefined);
      const evidence = JSON.parse(c.textOf(await c.call("browser_status")));
      assert.equal(evidence.mode, "headless");
      assert.deepEqual(evidence.launchOptions, { headless: true, ...(channel === "default" ? {} : { channel }) });
      assert.ok(evidence.browserVersion);
      assert.match(evidence.playwrightVersion, /^\d+\.\d+\.\d+/);
      assert.equal(evidence.platform, process.platform);
      assert.equal(evidence.architecture, process.arch);
      assert.equal(evidence.contextOptions.viewport.width, 1280);
      assert.equal(evidence.contextOptions.viewport.height, 1024);
      assert.match(evidence.contextOptions.userAgent, /^Mozilla\/5\.0/);
      assert.doesNotMatch(evidence.contextOptions.userAgent, /HeadlessChrome/);
      if (["default", "chromium"].includes(channel)) {
        assert.equal(evidence.browserInstall.installed, true);
        assert.deepEqual(evidence.browserInstall.browsers.map(b => b.name), channel === "default" ? ["chromium-headless-shell", "chromium"] : ["chromium"]);
      } else {
        assert.equal(evidence.browserInstall, null);
      }
    } finally { await closeFixture(httpServer, c); }
  });
}

test("a missing bundled browser shows in status and stops navigation with its install command", async () => {
  const empty = await realpath(await mkdtemp(path.join(os.tmpdir(), "browser-cache-")));
  const c = client({ PLAYWRIGHT_BROWSERS_PATH: empty, PROMETHEUS_BROWSER_CHANNEL: "default", PROMETHEUS_CONFIG_DIR: "" });
  try {
    const before = JSON.parse(c.textOf(await c.call("browser_status")));
    assert.equal(before.browserInstall.installed, false);
    assert.deepEqual(before.browserInstall.browsers.map(b => [b.name, b.installed]), [["chromium-headless-shell", false], ["chromium", false]]);
    assert.ok(before.browserInstall.browsers.every(b => b.directory.startsWith(empty)));
    assert.equal(before.browserVersion, null);
    const result = await c.call("browser_navigate", { url: "about:blank" });
    assert.equal(result.isError, true);
    assert.match(c.textOf(result), /Playwright browser not installed: chromium-headless-shell \d+\. Run: .*cli\.js install chromium-headless-shell/);
    assert.equal(JSON.parse(c.textOf(await c.call("browser_status"))).contextOpen, false);
  } finally { try { await c.close(); } finally { await rm(empty, { recursive: true, force: true }); } }
});

test("missing and foreign-origin saved records do not crash hydration", async () => {
  const { httpServer, base } = await fixtureServer();
  const root = await stateConfig("https://unrelated.example", "#account-menu");
  const c = client({ PROMETHEUS_CONFIG_DIR: root, PROMETHEUS_BROWSER_STATES: "missing,account" });
  try {
    const result = await c.call("browser_navigate", { url: base });
    assert.equal(result.isError, undefined, c.textOf(result));
    const status = JSON.parse(c.textOf(await c.call("browser_status")));
    assert.equal(status.hydratedAuthentication, false);
  } finally { try { await closeFixture(httpServer, c); } finally { await rm(root, { recursive: true, force: true }); } }
});

test("Playwright MCP server drives a headless page over JSON-RPC", async () => {
  const { httpServer, base } = await fixtureServer();
  const c = client();
  try {
    const init = await c.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
    assert.equal(init.result.serverInfo.name, "prometheus-browser");

    const list = await c.rpc("tools/list", {});
    const names = new Set(list.result.tools.map((t) => t.name));
    assert.ok(names.has("browser_navigate"), "exposes browser_navigate");
    assert.ok(names.has("browser_fill"), "exposes browser_fill");
    assert.ok(names.has("browser_status"), "exposes browser_status");
    assert.equal(names.has("browser_cloudscraper_get"), false, "removed diagnostic is not exposed");
    assert.equal((await c.call("browser_cloudscraper_get", { url: "https://example.com/" })).isError, true);
    // Security: no cookie/storage export tools are exposed.
    for (const leaky of ["browser_get_cookies", "browser_storage_state", "browser_network_requests", "browser_set_cookie", "browser_set_storage_state"]) {
      assert.ok(!names.has(leaky), `must not expose ${leaky}`);
    }

    const nav = c.textOf(await c.call("browser_navigate", { url: `${base}/` }));
    assert.match(nav, /status 200/);

    const reloaded = c.textOf(await c.call("browser_reload", { wait_until: "networkidle" }));
    assert.match(reloaded, /reloaded .* \(status 200\)/);

    const snap = c.textOf(await c.call("browser_snapshot", {}));
    assert.match(snap, /Fixture Home/);

    await c.call("browser_fill", { selector: "#name", value: "hello" });
    const filled = c.textOf(await c.call("browser_evaluate", { expression: "document.querySelector('#name').value" }));
    assert.equal(filled, "hello");

    await c.call("browser_click", { selector: "#go" });
    const clicked = c.textOf(await c.call("browser_evaluate", { expression: "document.querySelector('#out').textContent" }));
    assert.equal(clicked, "clicked!");

    const els = c.textOf(await c.call("browser_interactive_elements", {}));
    assert.match(els, /<button>/);
    assert.match(els, /<div> Message/, "visible contenteditable editor is discoverable");
    assert.match(els, /<div> Plain message/, "plaintext-only contenteditable editor is discoverable");
    assert.doesNotMatch(els, /<textarea> Message/, "hidden fallback control is omitted");
    assert.match(els, /Blocked \[disabled\]/, "semantic disabled state is visible");

    const richFill = await c.call("browser_fill", { selector: "#editor", value: "rich text" });
    assert.equal(richFill.isError, undefined, c.textOf(richFill));
    const richValue = c.textOf(await c.call("browser_evaluate", { expression: "document.querySelector('#editor').textContent" }));
    assert.equal(richValue, "rich text");

    const blocked = await c.call("browser_click", { selector: "#blocked" });
    assert.equal(blocked.isError, true);
    assert.match(c.textOf(blocked), /disabled/);
    const blockedOutput = c.textOf(await c.call("browser_evaluate", { expression: "document.querySelector('#out').textContent" }));
    assert.equal(blockedOutput, "clicked!", "disabled action was not dispatched");

    const status = JSON.parse(c.textOf(await c.call("browser_status", {})));
    assert.equal(status.mode, "headless");
    assert.equal(status.pageOpen, true);
    assert.equal(status.url, `${base}/`);

    // Navigate to the second page and wait for delayed text.
    await c.call("browser_navigate", { url: `${base}/second` });
    const waited = c.textOf(await c.call("browser_wait_for_text", { text: "ready-now", timeout: 5 }));
    assert.match(waited, /ready-now/);

    const closed = c.textOf(await c.call("browser_close", {}));
    assert.match(closed, /browser closed/);
  } finally {
    await closeFixture(httpServer, c);
  }
});

test("an oversized wait is bounded and leaves the page usable", async () => {
  const { httpServer, base } = await fixtureServer();
  const c = client({ PROMETHEUS_BROWSER_MAX_WAIT_MS: "5000", PROMETHEUS_BROWSER_TRANSPORT_TIMEOUT_MS: "100" });
  try {
    await c.call("browser_navigate", { url: `${base}/second` });
    const waited = await c.call("browser_wait_for_text", { text: "ready-now", timeout: 5 });
    assert.equal(waited.isError, true);
    assert.match(c.textOf(waited), /bounded wait expired after 80ms/);

    const snap = c.textOf(await c.call("browser_snapshot", {}));
    assert.match(snap, /Second Page/);
    assert.match(snap, /pending/);

    await new Promise((resolve) => setTimeout(resolve, 200));
    const recovered = c.textOf(await c.call("browser_snapshot", {}));
    assert.match(recovered, /ready-now/, "the browser context survived the wait timeout");
  } finally {
    await closeFixture(httpServer, c);
  }
});

test("explicit navigation recovers a closed page and classifies access denial", async () => {
  const { httpServer, base } = await fixtureServer();
  const c = client();
  try {
    await c.call("browser_navigate", { url: `${base}/` });
    await c.call("browser_tab_close", { index: 0 });
    const closed = JSON.parse(c.textOf(await c.call("browser_status", {})));
    assert.equal(closed.pageOpen, false);

    const recovered = await c.call("browser_navigate", { url: `${base}/` });
    assert.equal(recovered.isError, undefined, c.textOf(recovered));
    assert.match(c.textOf(recovered), /status 200/);

    const denied = c.textOf(await c.call("browser_navigate", { url: `${base}/denied` }));
    assert.match(denied, /status 403/);
    assert.match(denied, /access denied/);
  } finally {
    await closeFixture(httpServer, c);
  }
});

test("Cloudflare challenges are identified without misreporting authentication failure", async () => {
  const { httpServer, base } = await fixtureServer();
  const c = client();
  try {
    const challenged = c.textOf(await c.call("browser_navigate", { url: `${base}/challenge` }));
    assert.match(challenged, /status 403/);
    assert.match(challenged, /Cloudflare challenge detected/);
    assert.match(challenged, /do not retry automatically/);
  } finally {
    await closeFixture(httpServer, c);
  }
});

test("saved state is authenticated only when its account selector is visible", async () => {
  const { httpServer, base } = await fixtureServer();
  const validRoot = await stateConfig(base, "#account-menu");
  const invalidRoot = await stateConfig(base, "#missing-account-menu");
  const valid = client({ PROMETHEUS_CONFIG_DIR: validRoot });
  const invalid = client({ PROMETHEUS_CONFIG_DIR: invalidRoot });
  try {
    const accepted = await valid.call("browser_navigate", { url: `${base}/` });
    assert.equal(accepted.isError, undefined, valid.textOf(accepted));
    const status = JSON.parse(valid.textOf(await valid.call("browser_status", {})));
    assert.equal(status.hydratedAuthentication, true);

    const rejected = await invalid.call("browser_navigate", { url: `${base}/` });
    assert.equal(rejected.isError, true);
    assert.match(invalid.textOf(rejected), /visible account evidence.*new login/i);
  } finally {
    try { await closeFixture(httpServer, valid, invalid); } finally {
      await rm(validRoot, { recursive: true, force: true });
      await rm(invalidRoot, { recursive: true, force: true });
    }
  }
});

test("unknown tool and bad args return isError, not a crash", async () => {
  const { httpServer, base } = await fixtureServer();
  const c = client();
  try {
    await c.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
    const unknown = await c.call("browser_frobnicate", {});
    assert.equal(unknown.isError, true);
    assert.match(c.textOf(unknown), /unknown tool/);

    // With no page open, a browser action reports the missing page rather than crashing.
    const noPage = await c.call("browser_fill", { value: "x" });
    assert.equal(noPage.isError, true);
    assert.match(c.textOf(noPage), /no active page/);

    // After navigation, a fill with neither ref nor selector fails validation.
    await c.call("browser_navigate", { url: `${base}/` });
    const badFill = await c.call("browser_fill", { value: "x" });
    assert.equal(badFill.isError, true);
    assert.match(c.textOf(badFill), /ref or selector/);

    await c.call("browser_close", {});
  } finally {
    await closeFixture(httpServer, c);
  }
});

test("user-confirmed capture loads for inspection without claiming task-browser authentication", async () => {
  const { httpServer, base } = await fixtureServer();
  const root = await stateConfig(base, { method: "user-confirmed" });
  const c = client({ PROMETHEUS_CONFIG_DIR: root });
  try {
    const navigated = await c.call("browser_navigate", { url: base });
    assert.equal(navigated.isError, undefined, c.textOf(navigated));
    assert.match(c.textOf(navigated), /verify account or requested task access in this context/i);
    const status = JSON.parse(c.textOf(await c.call("browser_status", {})));
    assert.equal(status.hydratedAuthentication, false);
    assert.equal(status.authenticationVerification, "pending");
    assert.match(c.textOf(await c.call("browser_snapshot", {})), /Signed in account/);
    assert.equal((await c.call("browser_evaluate", { expression: "document.cookie" })).isError, true);
    await c.call("browser_close", {});
  } finally { try { await closeFixture(httpServer, c); } finally { await rm(root, { recursive: true, force: true }); } }
});

test("configured context options reach the page and metadata does not start a browser", async () => {
  const { httpServer, base } = await fixtureServer();
  const root = await mkdtemp(path.join(os.tmpdir(), "prometheus-context-"));
  const contextOptions = { viewport: { width: 1440, height: 900 }, screen: { width: 1440, height: 1000 },
    deviceScaleFactor: 2, locale: "en-GB", timezoneId: "Europe/London", colorScheme: "dark", reducedMotion: "reduce" };
  await writeFile(path.join(root, "prometheus-browser.json"), JSON.stringify({ channel: process.env.PROMETHEUS_TEST_BROWSER_CHANNEL || "default", automationCompatibility: true, contextOptions, launchOptions: { slowMo: 0 } }));
  const c = client({ PROMETHEUS_CONFIG_DIR: root });
  try {
    const before = JSON.parse(c.textOf(await c.call("browser_status")));
    assert.equal(before.contextOpen, false);
    assert.equal(before.browserVersion, null);
    assert.deepEqual(before.contextOptions, contextOptions);
    assert.equal(before.launchOptions.slowMo, 0);
    await c.call("browser_navigate", { url: base });
    const observed = JSON.parse(c.textOf(await c.call("browser_evaluate", { expression: `JSON.stringify({width: innerWidth, height: innerHeight,
      scale: devicePixelRatio, screenHeight: screen.height, language: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      dark: matchMedia('(prefers-color-scheme: dark)').matches, reduce: matchMedia('(prefers-reduced-motion: reduce)').matches})` })));
    assert.deepEqual(observed, { width: 1440, height: 900, scale: 2, screenHeight: 1000, language: "en-GB", timezone: "Europe/London", dark: true, reduce: true });
  } finally { try { await closeFixture(httpServer, c); } finally { await rm(root, { recursive: true, force: true }); } }
});

test("profile metadata and emulation survive the full MCP lifecycle", async () => {
  const { httpServer, base } = await fixtureServer();
  const root = await mkdtemp(path.join(os.tmpdir(), "prometheus-profile-"));
  await writeFile(path.join(root, "prometheus-browser.json"), JSON.stringify({ channel: "default",
    profile: { seed: "mcp-campaign", engine: "chromium", os: "Android", orientation: "portrait", legacy: false } }));
  const c = client({ PROMETHEUS_CONFIG_DIR: root });
  try {
    const before = JSON.parse(c.textOf(await c.call("browser_status")));
    assert.equal(before.contextOpen, false);
    assert.equal(before.browserVersion, null);
    assert.match(before.profile.catalogSHA256, /^[a-f0-9]{64}$/);
    assert.equal(before.profile.engine, "chromium");
    const nav = await c.call("browser_navigate", { url: base });
    assert.equal(nav.isError, undefined, c.textOf(nav));
    const after = JSON.parse(c.textOf(await c.call("browser_status")));
    assert.equal(after.profile.id, before.profile.id);
    assert.equal(typeof after.browserVersion, "string");
    const observed = JSON.parse(c.textOf(await c.call("browser_evaluate", { expression: "JSON.stringify({ua:navigator.userAgent, touch:navigator.maxTouchPoints, scale:devicePixelRatio})" })));
    assert.equal(observed.ua, before.profile.userAgent);
    assert.equal(observed.scale, before.profile.contextOptions.deviceScaleFactor);
    assert.ok(observed.touch > 0);
    await c.call("browser_close");
    const closed = JSON.parse(c.textOf(await c.call("browser_status")));
    assert.equal(closed.contextOpen, false);
    assert.equal(closed.profile.id, before.profile.id);
    assert.equal(closed.browserVersion, null);
  } finally { try { await closeFixture(httpServer, c); } finally { await rm(root, { recursive: true, force: true }); } }
});

test("navigation waits for an explicit application signal and preserves the page on timeout", async () => {
  const { httpServer, base } = await fixtureServer();
  const c = client();
  try {
    const ready = await c.call("browser_navigate", { url: `${base}/delayed-ready`, wait_until: "domcontentloaded", ready_selector: "#ready", timeout: 2 });
    assert.equal(ready.isError, undefined, c.textOf(ready));
    assert.equal(c.textOf(await c.call("browser_count", { selector: "#ready" })), "1");
    const timedOut = await c.call("browser_navigate", { url: base, ready_selector: "#missing", timeout: 0.1 });
    assert.equal(timedOut.isError, true);
    assert.match(c.textOf(timedOut), /navigation readiness wait expired.*page remains open/);
    assert.match(c.textOf(await c.call("browser_snapshot")), /Fixture Home/);
    for (const options of [{ wait_until: "bad" }, { wait_until: null }, { ready_selector: "" }, { timeout: -1 }]) {
      assert.equal((await c.call("browser_navigate", { url: base, ...options })).isError, true);
    }
  } finally { await closeFixture(httpServer, c); }
});

test("fixed typing delay spaces keyboard events without changing fill or default typing", async () => {
  const { httpServer, base } = await fixtureServer();
  const c = client();
  try {
    await c.call("browser_navigate", { url: base });
    await c.call("browser_fill", { selector: "#name", value: "A" });
    await c.call("browser_evaluate", { expression: "window.keyTimes = []; document.querySelector('#name').addEventListener('keydown', () => keyTimes.push(performance.now()));" });
    const typed = await c.call("browser_type", { selector: "#name", text: "bc", delay_ms: 40 });
    assert.equal(typed.isError, undefined, c.textOf(typed));
    const evidence = JSON.parse(c.textOf(await c.call("browser_evaluate", { expression: "JSON.stringify({value: document.querySelector('#name').value, times: keyTimes})" })));
    assert.equal(evidence.value, "Abc");
    assert.equal(evidence.times.length, 2);
    assert.ok(evidence.times[1] - evidence.times[0] >= 20, "keyboard events are spaced, not instant");
    assert.equal((await c.call("browser_type", { selector: "#name", text: "d" })).isError, undefined);
    for (const delay_ms of [-1, 1001, "100", null]) {
      assert.equal((await c.call("browser_type", { selector: "#name", text: "not typed", delay_ms })).isError, true);
    }
    assert.equal(c.textOf(await c.call("browser_evaluate", { expression: "document.querySelector('#name').value" })), "Abcd");
  } finally { await closeFixture(httpServer, c); }
});

test("HTTP 200 challenges are classified without matching ordinary documentation", async () => {
  const { httpServer, base } = await fixtureServer();
  const c = client();
  try {
    const challenged = c.textOf(await c.call("browser_navigate", { url: `${base}/challenge-ok`, ready_selector: "#never", timeout: 1 }));
    assert.match(challenged, /status 200, Cloudflare challenge detected/);
    assert.doesNotMatch(challenged, /readiness wait expired/);
    const normal = c.textOf(await c.call("browser_navigate", { url: `${base}/cloudflare-docs` }));
    assert.match(normal, /status 200/);
    assert.doesNotMatch(normal, /challenge detected|access denied/);
  } finally { await closeFixture(httpServer, c); }
});

test("denial is reported before saved-account verification or readiness waiting", async () => {
  const { httpServer, base } = await fixtureServer();
  const root = await stateConfig(base, "#missing-account-menu");
  const c = client({ PROMETHEUS_CONFIG_DIR: root });
  try {
    const denied = await c.call("browser_navigate", { url: `${base}/denied`, ready_selector: "#never", timeout: 1 });
    assert.equal(denied.isError, undefined, c.textOf(denied));
    assert.match(c.textOf(denied), /status 403, access denied/);
    assert.doesNotMatch(c.textOf(denied), /new login|readiness wait expired/);
    const status = JSON.parse(c.textOf(await c.call("browser_status")));
    assert.equal(status.hydratedAuthentication, false);
  } finally { try { await closeFixture(httpServer, c); } finally { await rm(root, { recursive: true, force: true }); } }
});

test("Playwright MCP server runs with external Chrome and CDP attachment", async () => {
  const { httpServer, base } = await fixtureServer();
  const c = client({ PROMETHEUS_BROWSER_EXECUTION_MODE: "external-cdp" });
  try {
    const res = await c.call("browser_navigate", { url: `${base}/` });
    assert.equal(res.isError, undefined, c.textOf(res));
    assert.match(c.textOf(res), /status 200/);

    const snap = c.textOf(await c.call("browser_snapshot"));
    assert.match(snap, /Fixture Home/);

    const status = JSON.parse(c.textOf(await c.call("browser_status")));
    assert.equal(status.configuredDistribution, "external-chrome-cdp");
    assert.equal(status.mode, "external-cdp");
  } finally {
    await closeFixture(httpServer, c);
  }
});

test("simulated human behavior provides typing jitter, curved mouse tracking, and navigation delays", async () => {
  const { httpServer, base } = await fixtureServer();
  const c = client();
  try {
    // 1. Navigation with humanize
    const startNav = Date.now();
    const nav = await c.call("browser_navigate", { url: `${base}/`, humanize: true });
    const elapsedNav = Date.now() - startNav;
    assert.equal(nav.isError, undefined, c.textOf(nav));
    assert.match(c.textOf(nav), /status 200/);
    assert.ok(elapsedNav >= 1800, `expected nav delay >= 1800ms, got ${elapsedNav}ms`);

    // 2. Typing with humanize
    const startType = Date.now();
    const typed = await c.call("browser_type", { selector: "#name", text: "human", humanize: true });
    const elapsedType = Date.now() - startType;
    assert.equal(typed.isError, undefined, c.textOf(typed));
    const val = c.textOf(await c.call("browser_evaluate", { expression: "document.querySelector('#name').value" }));
    assert.equal(val, "human");
    // 5 chars with min 50ms each should take >= 200ms
    assert.ok(elapsedType >= 200, `expected typing jitter >= 200ms, got ${elapsedType}ms`);

    // 3. Click with humanize (curved mouse trajectory)
    const clicked = await c.call("browser_click", { selector: "#go", humanize: true });
    assert.equal(clicked.isError, undefined, c.textOf(clicked));
    const out = c.textOf(await c.call("browser_evaluate", { expression: "document.querySelector('#out').textContent" }));
    assert.equal(out, "clicked!");
    const lastMouse = JSON.parse(c.textOf(await c.call("browser_evaluate", {
      expression: "JSON.stringify({ x: window.__prometheusLastMouseX, y: window.__prometheusLastMouseY })",
    })));
    assert.ok(typeof lastMouse.x === "number" && lastMouse.x > 0, `expected recorded mouse x, got ${lastMouse.x}`);
    assert.ok(typeof lastMouse.y === "number" && lastMouse.y > 0, `expected recorded mouse y, got ${lastMouse.y}`);
  } finally {
    await closeFixture(httpServer, c);
  }
});

test("human typing expires within its transport-safe budget and releases queued inspection", async () => {
  const { httpServer, base } = await fixtureServer();
  const c = client({ PROMETHEUS_BROWSER_TRANSPORT_TIMEOUT_MS: "1000" });
  try {
    await c.call("browser_navigate", { url: `${base}/`, humanize: false });
    const typing = c.call("browser_type", { selector: "#name", text: "x".repeat(1000), humanize: true });
    const inspection = c.call("browser_evaluate", { expression: "document.querySelector('#name').value" });
    const result = await typing;
    assert.equal(result.isError, true);
    assert.match(c.textOf(result), /typing deadline expired/);
    const partial = c.textOf(await inspection);
    assert.ok(partial.length > 0 && partial.length < 1000);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(c.textOf(await c.call("browser_evaluate", {
      expression: "document.querySelector('#name').value",
    })), partial, "input stays unchanged after the deadline");
  } finally {
    await closeFixture(httpServer, c);
  }
});

test("PROMETHEUS_BROWSER_HUMANIZE env var enables human behavior by default", async () => {
  const { httpServer, base } = await fixtureServer();
  const c = client({ PROMETHEUS_BROWSER_HUMANIZE: "1" });
  try {
    await c.call("browser_navigate", { url: `${base}/` });
    const startType = Date.now();
    await c.call("browser_type", { selector: "#name", text: "abc" });
    const elapsedType = Date.now() - startType;
    const val = c.textOf(await c.call("browser_evaluate", { expression: "document.querySelector('#name').value" }));
    assert.equal(val, "abc");
    assert.ok(elapsedType >= 100, `expected typing delay >= 100ms, got ${elapsedType}ms`);

    await c.call("browser_click", { selector: "#go" });
    const out = c.textOf(await c.call("browser_evaluate", { expression: "document.querySelector('#out').textContent" }));
    assert.equal(out, "clicked!");
  } finally {
    await closeFixture(httpServer, c);
  }
});

test("MCP humanize startup uses resolved settings instead of reading the environment again", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-humanize-"));
  try {
    for (const humanize of [true, false, undefined]) {
      await writeFile(path.join(root, "prometheus-browser.json"), JSON.stringify({ channel: "default", humanize }));
      const c = client({ PROMETHEUS_CONFIG_DIR: root,
        PROMETHEUS_BROWSER_HUMANIZE: humanize === true ? "false" : "true" });
      try {
        const status = JSON.parse(c.textOf(await c.call("browser_status")));
        assert.equal(status.humanize, Boolean(humanize));
        assert.equal(status.contextOpen, false);
      } finally { await c.close(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("browser_configure tool dynamically toggles humanize across subsequent actions", async () => {
  const { httpServer, base } = await fixtureServer();
  const c = client();
  try {
    await c.call("browser_navigate", { url: `${base}/` });

    // Initial status: humanize is false
    const initStatus = JSON.parse(c.textOf(await c.call("browser_status")));
    assert.equal(initStatus.humanize, false);

    // Dynamically configure humanize to true
    const cfgRes = JSON.parse(c.textOf(await c.call("browser_configure", { humanize: true })));
    assert.equal(cfgRes.configured, true);
    assert.equal(cfgRes.humanize, true);

    const postCfgStatus = JSON.parse(c.textOf(await c.call("browser_status")));
    assert.equal(postCfgStatus.humanize, true);

    // Actions now default to human simulation without per-call args
    const startType = Date.now();
    await c.call("browser_type", { selector: "#name", text: "mcp" });
    const elapsedType = Date.now() - startType;
    const val = c.textOf(await c.call("browser_evaluate", { expression: "document.querySelector('#name').value" }));
    assert.equal(val, "mcp");
    assert.ok(elapsedType >= 100, `expected typing delay >= 100ms, got ${elapsedType}ms`);

    // Toggle back off
    const offRes = JSON.parse(c.textOf(await c.call("browser_configure", { humanize: false })));
    assert.equal(offRes.humanize, false);

    const offStatus = JSON.parse(c.textOf(await c.call("browser_status")));
    assert.equal(offStatus.humanize, false);
  } finally {
    await closeFixture(httpServer, c);
  }
});

test("browser_session_health inspects blueprints before launch and evaluates healthy vs expired sessions", async () => {
  const { httpServer, base } = await fixtureServer();
  const root = await mkdtemp(path.join(os.tmpdir(), "prometheus-health-mcp-"));
  const sessions = path.join(root, "prometheus-sessions");
  await mkdir(sessions, { mode: 0o700 });
  const origin = new URL(base).origin;
  const healthContext = {
    version: 1,
    capturedAt: new Date().toISOString(),
    checkUrl: `${origin}/`,
    loginUrl: `${origin}/`,
    sameUrlComparison: true,
    signals: {
      healthySelectors: ["#account-menu", "#promo-banner", '[data-testid="alice@example.com"]', '[data-testid="alice@example.com"]'],
      unhealthySelectors: ["#token-a1b2c3d4e5f6g7h8i9j0k1l2m3n4"],
      unhealthyUrlPaths: ["/user/alice%40example.com"],
      externalAuthOrigins: [],
    },
    before: {
      approvedOrigin: true,
      url: `${origin}/`,
      pathname: "/",
      title: "",
      hasAuthForm: false,
      headings: ["Fixture Home"],
      landmarks: [],
      controls: [{ tag: "button", selector: "#go", label: "Go" }],
    },
    after: {
      approvedOrigin: true,
      url: `${origin}/`,
      pathname: "/",
      title: "",
      hasAuthForm: false,
      headings: ["Fixture Home"],
      landmarks: [],
      controls: [
        { tag: "button", selector: "#account-menu", label: "Signed in account" },
        { tag: "button", selector: '[data-testid="alice@example.com"]', label: "alice@example.com" },
        { tag: "button", selector: '[data-testid="alice@example.com"]', hrefPath: "/reset/a1b2c3d4e5f6g7h8i9j0k1l2m3n4" },
      ],
    },
  };

  await writeFile(path.join(sessions, "account.json"), JSON.stringify({
    schemaVersion: 1,
    name: "account",
    origins: [origin],
    capturedAt: new Date().toISOString(),
    storageState: {
      cookies: [],
      origins: [{ origin, localStorage: [{ name: "authenticated", value: "yes" }] }],
    },
    verification: { method: "user-confirmed" },
    health: healthContext,
  }), { mode: 0o600 });

  const healthyClient = client({ PROMETHEUS_CONFIG_DIR: root });
  const expiredRoot = await mkdtemp(path.join(os.tmpdir(), "prometheus-health-expired-"));
  const expiredSessions = path.join(expiredRoot, "prometheus-sessions");
  await mkdir(expiredSessions, { mode: 0o700 });
  await writeFile(path.join(expiredSessions, "account.json"), JSON.stringify({
    schemaVersion: 1,
    name: "account",
    origins: [origin],
    capturedAt: new Date().toISOString(),
    storageState: {
      cookies: [],
      origins: [{ origin, localStorage: [{ name: "authenticated", value: "expired" }] }],
    },
    verification: { method: "user-confirmed" },
    health: healthContext,
  }), { mode: 0o600 });
  const expiredClient = client({ PROMETHEUS_CONFIG_DIR: expiredRoot });

  try {
    // 1. Inspect blueprint before opening a browser (zero launch)
    const preOpen = JSON.parse(healthyClient.textOf(await healthyClient.call("browser_session_health", {})));
    assert.equal(preOpen.status, "not_open");
    assert.equal(preOpen.checkUrl, `${origin}/`);
    assert.deepEqual(preOpen.signals.healthySelectors, ["#account-menu"]);
    assert.deepEqual(preOpen.signals.unhealthySelectors, []);
    assert.deepEqual(preOpen.signals.unhealthyUrlPaths, []);
    assert.equal(preOpen.before, undefined);
    assert.equal(preOpen.after, undefined);
    const detailed = await healthyClient.call("browser_session_health", { include_snapshots: true });
    assert.equal(JSON.parse(healthyClient.textOf(detailed)).after.controls[0].selector, "#account-menu");
    assert.doesNotMatch(JSON.stringify(detailed), /alice|a1b2c3/);
    assert.equal(JSON.parse(healthyClient.textOf(await healthyClient.call("browser_status"))).contextOpen, false);

    // 2. Fast live check with navigate_to_check_url: true when session is healthy
    const healthyCheck = JSON.parse(healthyClient.textOf(await healthyClient.call("browser_session_health", {
      navigate_to_check_url: true,
      include_snapshots: false,
    })));
    assert.equal(healthyCheck.status, "healthy");
    assert.deepEqual(healthyCheck.live.matchedHealthySelectors, ["#account-menu"]);
    assert.equal(healthyCheck.before, undefined);

    const healthyStatus = JSON.parse(healthyClient.textOf(await healthyClient.call("browser_status")));
    // Inferred health cannot promote user-confirmed restoration into authentication.
    assert.equal(healthyStatus.hydratedAuthentication, false);
    assert.equal(healthyStatus.authenticationVerification, "pending");
    assert.equal(healthyStatus.sessionHealth.status, "healthy");
    assert.equal(healthyStatus.sessionHealth.checkUrl, `${origin}/`);

    // 3. Navigating to an unrelated subpage returns inconclusive without throwing
    const subNav = await healthyClient.call("browser_navigate", { url: `${base}/second` });
    assert.equal(subNav.isError, undefined, healthyClient.textOf(subNav));
    const subCheck = JSON.parse(healthyClient.textOf(await healthyClient.call("browser_session_health", {})));
    assert.equal(subCheck.status, "inconclusive");
    assert.match(subCheck.reason, /differs from checkUrl/);
    assert.equal(subCheck.before, undefined);
    assert.equal(subCheck.after, undefined);
    assert.doesNotMatch(JSON.stringify(subCheck), /alice|a1b2c3/);

    // 4. Expired session on checkUrl reports unhealthy and keeps hydratedAuthentication false
    const expiredNav = await expiredClient.call("browser_navigate", { url: `${base}/` });
    assert.equal(expiredNav.isError, undefined, expiredClient.textOf(expiredNav));
    assert.match(expiredClient.textOf(expiredNav), /session health warning: unhealthy/);
    const expiredCheck = JSON.parse(expiredClient.textOf(await expiredClient.call("browser_session_health", {})));
    assert.equal(expiredCheck.status, "unhealthy");
    const expiredStatus = JSON.parse(expiredClient.textOf(await expiredClient.call("browser_status")));
    assert.equal(expiredStatus.hydratedAuthentication, false);
    assert.equal(expiredStatus.authenticationVerification, "pending");
    assert.equal(expiredStatus.sessionHealth.status, "unhealthy");
  } finally {
    try { await closeFixture(httpServer, healthyClient, expiredClient); } finally {
      await rm(root, { recursive: true, force: true });
      await rm(expiredRoot, { recursive: true, force: true });
    }
  }
});

test("legacy session health never accepts an account selector on a foreign origin or denied page", async () => {
  const { httpServer, base } = await fixtureServer();
  const root = await mkdtemp(path.join(os.tmpdir(), "prometheus-health-origin-"));
  const origin = new URL(base).origin;
  const sessions = path.join(root, "prometheus-sessions");
  await mkdir(sessions, { mode: 0o700 });
  await writeFile(path.join(sessions, "account.json"), JSON.stringify({
    schemaVersion: 1, name: "account", origins: [origin],
    storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: "authenticated", value: "yes" }] }] },
    verification: { selector: "#account-menu" },
  }), { mode: 0o600 });
  const c = client({ PROMETHEUS_CONFIG_DIR: root });
  try {
    await c.call("browser_navigate", { url: `${base}/` });
    const valid = JSON.parse(c.textOf(await c.call("browser_session_health", { origin })));
    assert.equal(valid.status, "healthy");
    assert.equal(JSON.parse(c.textOf(await c.call("browser_status"))).authenticationVerification, "verified");

    await c.call("browser_navigate", {
      url: `data:text/html,${encodeURIComponent('<button id="account-menu">Public account</button>')}`,
    });
    const foreign = JSON.parse(c.textOf(await c.call("browser_session_health", { origin })));
    assert.equal(foreign.status, "unhealthy");
    assert.match(foreign.reason, /outside the saved authentication origin/);
    assert.equal(JSON.parse(c.textOf(await c.call("browser_status"))).hydratedAuthentication, false);

    await c.call("browser_navigate", { url: `${base}/` });
    assert.equal(JSON.parse(c.textOf(await c.call("browser_status"))).authenticationVerification, "verified");
    await c.call("browser_navigate", { url: `${base}/denied` });
    const denied = JSON.parse(c.textOf(await c.call("browser_session_health", { origin })));
    assert.equal(denied.status, "unhealthy");
    assert.match(denied.reason, /access denial/);
    assert.equal(JSON.parse(c.textOf(await c.call("browser_status"))).authenticationVerification, "pending");
  } finally {
    try { await closeFixture(httpServer, c); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
});
