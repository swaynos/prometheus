import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { access, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";

// The same local fixture can verify a deployed service without loading real accounts.
const server = process.env.PROMETHEUS_TEST_BROWSER_SERVER || path.resolve(import.meta.dirname, "../../scripts/opencode-playwright-mcp.mjs");
const hasXvfb = spawnSync("sh", ["-c", "command -v Xvfb && command -v xvfb-run && command -v xauth"], { stdio: "ignore" }).status === 0;
const isLinux = process.platform === "linux";

function client(configDir, extraEnv = {}) {
  const child = spawn(process.execPath, [server], { env: { ...process.env,
    PROMETHEUS_CONFIG_DIR: configDir, PROMETHEUS_VIRTUAL_DISPLAY: "", ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "", id = 0;
  const pending = new Map();
  const exited = once(child, "exit");
  child.stderr.on("data", chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on("line", line => {
    const result = JSON.parse(line); // stdout must contain JSON-RPC only.
    pending.get(result.id)?.(result);
  });
  return { child, exited, errors: () => stderr,
    call(name, args = {}) {
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`RPC timeout: ${stderr}`)); }, 20000);
        pending.set(requestId, message => {
          clearTimeout(timer); pending.delete(requestId);
          if (message.result.isError) reject(new Error(message.result.content[0].text));
          else resolve(message.result.content[0].text);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: { name, arguments: args } })}\n`);
      });
    },
    async close() { child.stdin.end(); return exited; },
  };
}

async function config() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cw-xvfb-"));
  await writeFile(path.join(dir, "prometheus-browser.json"), JSON.stringify({ channel: process.env.PROMETHEUS_TEST_BROWSER_CHANNEL || "default", automationCompatibility: true, executionMode: "virtual-display" }));
  return dir;
}

test("missing Xvfb fails without falling back to the physical display", { timeout: 10000 }, async () => {
  const dir = await config();
  try {
    const c = client(dir, { PATH: dir, DISPLAY: ":0" });
    assert.notEqual((await c.exited)[0], 0);
    assert.match(c.errors(), isLinux ? /install xvfb and xauth/ : /requires Linux and Xvfb/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("service wraps the real MCP process and keeps stdio and exit status intact", { skip: !isLinux, timeout: 10000 }, async () => {
  const dir = await config();
  try {
    // Mock only the X server boundary. The real MCP process handles the request.
    await writeFile(path.join(dir, "xvfb-run"), '#!/bin/sh\n[ "$1" = "--auto-servernum" ] || exit 91\n[ "$2" = "--server-args=-screen 0 1280x1024x24 -nolisten tcp" ] || exit 92\nshift 2\nDISPLAY=:123 exec "$@"\n', { mode: 0o700 });
    const c = client(dir, { PATH: dir });
    try {
      const status = JSON.parse(await c.call("browser_status"));
      assert.equal(status.mode, "virtual-display");
      assert.equal(status.launchOptions.headless, false);
      assert.deepEqual(status.launchOptions.args, ["--disable-blink-features=AutomationControlled"]);
      assert.equal(status.contextOpen, false);
    } finally { assert.equal((await c.close())[0], 0); }
    await writeFile(path.join(dir, "xvfb-run"), "#!/bin/sh\nexit 23\n", { mode: 0o700 });
    assert.equal((await client(dir, { PATH: dir }).exited)[0], 23);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("real concurrent Xvfb services render headed browsers and release displays on EOF and signal", { skip: !hasXvfb, timeout: 60000 }, async () => {
  const dir = await config();
  const fixture = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end('<title>virtual fixture</title><input id="value"><div id="account" hidden>Fixture account</div><script>document.querySelector("#account").hidden = localStorage.getItem("authenticated") !== "fixture";</script>');
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  await mkdir(path.join(dir, "prometheus-sessions"), { mode: 0o700 });
  await writeFile(path.join(dir, "prometheus-sessions", "fixture.json"), JSON.stringify({
    schemaVersion: 1, name: "fixture", origins: [origin], capturedAt: new Date().toISOString(),
    storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: "authenticated", value: "fixture" }] }] },
    verification: { method: "user-confirmed" },
  }), { mode: 0o600 });
  const clients = [client(dir), client(dir)];
  const displays = [];
  try {
    await Promise.all(clients.map(async c => {
      await c.call("browser_navigate", { url: "data:text/html,<title>virtual fixture</title>" });
      const evidence = JSON.parse(await c.call("browser_evaluate", { expression: "JSON.stringify({ua:navigator.userAgent,width:innerWidth,height:innerHeight,screenWidth:screen.width,screenHeight:screen.height})" }));
      // browser_evaluate returns the string result directly.
      const observed = typeof evidence === "string" ? JSON.parse(evidence) : evidence;
      assert.doesNotMatch(observed.ua, /HeadlessChrome/);
      assert.equal(observed.width, 1280); assert.equal(observed.height, 1024);
      assert.equal(observed.screenWidth, 1280); assert.equal(observed.screenHeight, 1024);
      await c.call("browser_navigate", { url: origin });
      assert.match(await c.call("browser_snapshot"), /Fixture account/);
      assert.match(await c.call("browser_fill", { selector: "#value", value: "rendered" }), /filled and verified/);
      await assert.rejects(c.call("browser_evaluate", { expression: "document.cookie" }), /unavailable while saved authentication state is loaded/);
      const status = JSON.parse(await c.call("browser_status"));
      assert.equal(status.mode, "virtual-display");
      assert.equal(status.authenticationVerification, "pending");
      assert.equal(status.hydratedAuthentication, false);
      displays.push(status.virtualDisplay);
    }));
    assert.equal(new Set(displays).size, 2);
    assert.equal((await clients[0].close())[0], 0);
    clients[1].child.kill("SIGTERM");
    assert.notEqual((await clients[1].exited)[0], 0);
    for (const display of displays) {
      const socket = `/tmp/.X11-unix/X${display.slice(1)}`;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { await access(socket); } catch { break; }
        await delay(20);
      }
      await assert.rejects(access(socket), { code: "ENOENT" });
    }
  } finally {
    for (const c of clients) if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill("SIGTERM");
    await Promise.all(clients.map(c => c.exited));
    fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
});
