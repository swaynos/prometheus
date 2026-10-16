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
    if (req.url === "/challenge") {
      res.writeHead(403, { "content-type": "text/html" });
      res.end("<!doctype html><title>Just a moment...</title><h1>Checking your browser before accessing example.com</h1>");
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
  const child = spawn("node", [server], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...env } });
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

for (const channel of ["default", "chromium"]) {
  test(`managed ${channel} browser reports its applied launch options`, async () => {
    const { httpServer, base } = await fixtureServer();
    const c = client({ PROMETHEUS_BROWSER_CHANNEL: channel, PROMETHEUS_CONFIG_DIR: "" });
    try {
      const result = await c.call("browser_navigate", { url: base });
      assert.equal(result.isError, undefined);
      const evidence = JSON.parse(c.textOf(await c.call("browser_status")));
      assert.equal(evidence.mode, "headless");
      assert.deepEqual(evidence.launchOptions, { headless: true, ...(channel === "chromium" ? { channel } : {}) });
      assert.ok(evidence.browserVersion);
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
