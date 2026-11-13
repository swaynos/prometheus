import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawnMcpClient } from "./helpers.mjs";
import { chromium } from "playwright";
import { createTaskContext, collectBrowserProfileEvidence } from "../../scripts/opencode-browser-runtime.mjs";

function client(env = {}) {
  return spawnMcpClient({ ...(process.env.PROMETHEUS_TEST_BROWSER_CHANNEL ? { PROMETHEUS_BROWSER_CHANNEL: process.env.PROMETHEUS_TEST_BROWSER_CHANNEL } : {}), ...env });
}

async function fixture() {
  let submissions = 0;
  let headers = {};
  const server = http.createServer((req, res) => {
    if (req.url === "/frame") return res.end('<button id="frame-button">Frame button</button><div class="card"><h2>Frame result</h2></div><iframe srcdoc="&lt;button&gt;Nested&lt;/button&gt;"></iframe>');
    if (req.url === "/next") return res.end("<title>Next</title><p>Next</p>");
    if (req.url === "/denied") return res.writeHead(403).end("Denied");
    if (req.url === "/save") { submissions++; return res.writeHead(500).end(); }
    if (req.url === "/") headers = req.headers;
    res.end(`<!doctype html><title>Fixture</title>
      <button id="save" onclick="fetch('/save',{method:'POST'}); document.querySelector('#status').textContent='Saved now'">Save</button>
      <button id="stale">No change</button><div id="status">Saved</div>
      <button id="slow" onclick="fetch('/save',{method:'POST'})">Slow</button>
      <input id="form-input"><button id="submit" onclick="document.querySelector('#form-result').textContent='Complete'">Submit</button><div id="form-result"></div>
      <a id="next" href="/next">Next</a><a id="denied" href="/denied">Denied</a>
      <div id="scroller" style="height:30px;overflow:auto" onscroll="if (!document.querySelector('#added')) {const el=document.createElement('div');el.id='added';el.textContent='Added';document.body.append(el)}"><div style="height:300px">Scroll</div></div>
      <div class="card"><h2>One</h2><a href="/one">Link</a><span class="price">$3</span></div>
      <div class="card"><h2>Two</h2><a href="/two">Link</a></div>
      <iframe src="/frame"></iframe>`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { base: `http://127.0.0.1:${server.address().port}`, submissions: () => submissions, headers: () => headers,
    close() { server.closeAllConnections(); server.close(); } };
}

test("click expectations distinguish new evidence, errors, stale state, and cancellation", async () => {
  const site = await fixture(); const c = client({ PROMETHEUS_BROWSER_MAX_WAIT_MS: "1000" });
  const call = async (name, args) => JSON.parse(c.textOf(await c.call(name, args)));
  try {
    await c.call("browser_navigate", { url: site.base });
    const result = await call("browser_click", { selector: "#save", expect: { kind: "text", selector: "#status", text: "Saved now" }, timeout: 1 });
    assert.equal(result.status, "confirmed"); assert.equal(result.dispatch, "completed");
    assert.equal(site.submissions(), 1);
    const stale = await call("browser_click", { selector: "#stale", expect: { kind: "text", selector: "#status", text: "Saved now" }, timeout: 0.2 });
    assert.equal(stale.status, "unknown"); assert.equal(stale.reason, "timeout");
    const response = await call("browser_click", { selector: "#slow", expect: { kind: "response", path: "/save", status: 500 }, timeout: 1 });
    assert.equal(response.status, "confirmed"); assert.equal(response.evidence.status, 500);
    assert.equal(site.submissions(), 2);
    const pending = c.call("browser_click", { selector: "#stale", expect: { kind: "new", selector: "#never" }, timeout: 1 });
    setTimeout(() => c.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 5 } }) + "\n"), 150);
    const cancelled = JSON.parse(c.textOf(await pending));
    assert.equal(cancelled.status, "unknown"); assert.equal(cancelled.reason, "cancelled");
    assert.match(c.textOf(await c.call("browser_snapshot")), /Fixture/);
  } finally { await c.close(); site.close(); }
});

test("form submission can observe a fresh outcome without repeating input", async () => {
  const site = await fixture(); const c = client();
  try {
    await c.call("browser_navigate", { url: site.base });
    const result = JSON.parse(c.textOf(await c.call("browser_fill_form", { fields: [{ selector: "#form-input", value: "example" }], submit_selector: "#submit", expect: { kind: "text", selector: "#form-result", text: "Complete" }, timeout: 1 })));
    assert.equal(result.status, "confirmed"); assert.equal(result.fieldsFilled, 1);
  } finally { await c.close(); site.close(); }
});

test("change waits and scrolls are bounded and require a fresh change", async () => {
  const site = await fixture(); const c = client({ PROMETHEUS_BROWSER_MAX_WAIT_MS: "1000" });
  try {
    await c.call("browser_navigate", { url: site.base });
    const result = JSON.parse(c.textOf(await c.call("browser_scroll", { selector: "#scroller", amount: 100, expect: { kind: "new", selector: "#added" }, timeout: 1 })));
    assert.equal(result.status, "confirmed");
    const unchanged = JSON.parse(c.textOf(await c.call("browser_wait_for_change", { expect: { kind: "new", selector: "#added" }, timeout: 0.15 })));
    assert.equal(unchanged.status, "unresolved"); assert.equal(unchanged.reason, "timeout");
  } finally { await c.close(); site.close(); }
});

test("navigation expectations are armed before fast navigation and report denial", async () => {
  const site = await fixture(); const c = client();
  try {
    await c.call("browser_navigate", { url: site.base });
    const result = JSON.parse(c.textOf(await c.call("browser_click", { selector: "#next", expect: { kind: "url", url: `${site.base}/next` }, timeout: 2 })));
    assert.equal(result.status, "confirmed");
    await c.call("browser_navigate", { url: site.base });
    const denial = JSON.parse(c.textOf(await c.call("browser_click", { selector: "#denied", expect: { kind: "visible", selector: "#never" }, timeout: 2 })));
    assert.equal(denial.status, "access_denied");
    assert.equal(denial.evidence.status, 403);
  } finally { await c.close(); site.close(); }
});

test("record extraction preserves relationships and frame refs cannot cross documents", async () => {
  const site = await fixture(); const c = client();
  try {
    await c.call("browser_navigate", { url: site.base });
    const records = JSON.parse(c.textOf(await c.call("browser_extract", { root: ".card", fields: { title: { selector: "h2" }, url: { selector: "a", attribute: "href" }, price: { selector: ".price" } } })));
    assert.deepEqual(records.records, [{ title: "One", url: `${site.base}/one`, price: "$3" }, { title: "Two", url: `${site.base}/two`, price: null }]);
    const frames = JSON.parse(c.textOf(await c.call("browser_frames")));
    const frame = frames.find(f => !f.main && frames.find(parent => parent.id === f.parent)?.main); assert.ok(frame);
    const nested = frames.find(f => f.parent === frame.id); assert.ok(nested);
    assert.match(c.textOf(await c.call("browser_interactive_elements", { frame: nested.id })), /Nested/);
    const controls = c.textOf(await c.call("browser_interactive_elements", { frame: frame.id }));
    const ref = /^(e\d+) <button> Frame button$/m.exec(controls)?.[1]; assert.ok(ref);
    assert.equal((await c.call("browser_click", { ref })).isError, undefined);
    const frameRecords = JSON.parse(c.textOf(await c.call("browser_extract", { frame: frame.id, root: ".card", fields: { title: { selector: "h2" } } })));
    assert.equal(frameRecords.records[0].title, "Frame result");
    await c.call("browser_interactive_elements", { frame: frame.id });
    assert.equal((await c.call("browser_click", { ref })).isError, true);
    await c.call("browser_navigate", { url: site.base });
    assert.equal((await c.call("browser_click", { selector: "#frame-button", frame: frame.id })).isError, true);
  } finally { await c.close(); site.close(); }
});

test("profile evidence records native document, frame, worker and permission surfaces", async () => {
  const site = await fixture();
  const { browser, context } = await createTaskContext(chromium, { channel: process.env.PROMETHEUS_TEST_BROWSER_CHANNEL || "default", automationCompatibility: true, contextOptions: { locale: "en-US" } });
  try {
    const page = await context.newPage(); await page.goto(site.base);
    const evidence = await collectBrowserProfileEvidence(page);
    assert.ok(evidence.document.userAgent);
    assert.equal(site.headers()["user-agent"], evidence.document.userAgent);
    assert.match(site.headers()["accept-language"], /^en-US/);
    assert.equal(evidence.document.language, "en-US");
    assert.ok(evidence.iframe);
    assert.equal(evidence.iframe.userAgent, evidence.document.userAgent);
    assert.ok(evidence.worker);
    assert.equal(evidence.worker.hardwareConcurrency, evidence.document.hardwareConcurrency);
    assert.ok(Array.isArray(evidence.plugins));
    assert.ok("query" in evidence.notification);
    assert.ok(evidence.window.innerWidth > 0);
  } finally { await browser.close(); site.close(); }
});
