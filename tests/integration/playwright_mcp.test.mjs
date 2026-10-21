// End-to-end test for the headless Playwright MCP server. It launches real
// headless Chromium and drives the server over newline-delimited JSON-RPC
// against a loopback HTTP fixture. No network access and no headed window.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

const repo = path.resolve(import.meta.dirname, "../..");
const server = path.join(repo, "scripts", "opencode-playwright-mcp.mjs");

function fixtureServer() {
  const httpServer = http.createServer((req, res) => {
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
      res.end("<!doctype html><title>Denied</title><h1>Access denied</h1>");
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

// Minimal JSON-RPC-over-stdio client for the spawned server.
function client(env = {}) {
  const child = spawn("node", [server], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, PROMETHEUS_CONFIG_DIR: "", ...env } });
  const pending = new Map();
  let nextId = 1;
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  function rpc(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`rpc timeout: ${method}`)), 60000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  async function call(name, args = {}) {
    const message = await rpc("tools/call", { name, arguments: args });
    return message.result;
  }
  function textOf(result) {
    return result?.content?.map((c) => c.text).join("") ?? "";
  }
  return { child, rpc, call, textOf, close: () => child.stdin.end() };
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
      assert.equal(evidence.configuredDistribution, channel === "default" ? "chromium-headless-shell" : channel === "chrome" ? "installed-chrome" : "chromium");
      assert.deepEqual(evidence.contextOptions, { viewport: { width: 1280, height: 1024 } });
    } finally { await c.call("browser_close"); c.close(); await new Promise((resolve) => httpServer.close(resolve)); }
  });
}

test("missing and foreign-origin saved records do not crash hydration", async () => {
  const { httpServer, base } = await fixtureServer();
  const root = await stateConfig("https://unrelated.example", "#account-menu");
  const c = client({ PROMETHEUS_CONFIG_DIR: root, PROMETHEUS_BROWSER_STATES: "missing,account" });
  try {
    const result = await c.call("browser_navigate", { url: base });
    assert.equal(result.isError, undefined, c.textOf(result));
    const status = JSON.parse(c.textOf(await c.call("browser_status")));
    assert.equal(status.hydratedAuthentication, false);
  } finally { await c.call("browser_close"); c.close(); await new Promise((resolve) => httpServer.close(resolve)); await rm(root, { recursive: true, force: true }); }
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
    // Security: no cookie/storage export tools are exposed.
    for (const leaky of ["browser_get_cookies", "browser_storage_state", "browser_network_requests", "browser_set_cookie", "browser_set_storage_state"]) {
      assert.ok(!names.has(leaky), `must not expose ${leaky}`);
    }

    const nav = c.textOf(await c.call("browser_navigate", { url: `${base}/` }));
    assert.match(nav, /status 200/);

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
    c.close();
    httpServer.close();
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
    c.close();
    httpServer.close();
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
    c.close();
    httpServer.close();
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
    c.close();
    httpServer.close();
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
    valid.close();
    invalid.close();
    httpServer.close();
    await rm(validRoot, { recursive: true, force: true });
    await rm(invalidRoot, { recursive: true, force: true });
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
    c.close();
    httpServer.close();
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
  } finally { c.close(); httpServer.close(); await rm(root, { recursive: true, force: true }); }
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
  } finally { await c.call("browser_close"); c.close(); httpServer.close(); await rm(root, { recursive: true, force: true }); }
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
  } finally { await c.call("browser_close"); c.close(); httpServer.close(); await rm(root, { recursive: true, force: true }); }
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
  } finally { await c.call("browser_close"); c.close(); httpServer.close(); }
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
  } finally { await c.call("browser_close"); c.close(); httpServer.close(); }
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
  } finally { await c.call("browser_close"); c.close(); httpServer.close(); }
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
  } finally { await c.call("browser_close"); c.close(); httpServer.close(); await rm(root, { recursive: true, force: true }); }
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
    await c.call("browser_close");
    c.close();
    httpServer.close();
  }
});
