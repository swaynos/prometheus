import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, readdir, rm, stat, symlink, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import * as login from "../../scripts/opencode-browser-login.mjs";
import { launchExternalCdpContext } from "../../scripts/opencode-browser-runtime.mjs";
import { loadStateForOrigin, saveState, statMetadata } from "../../scripts/opencode-browser-state.mjs";

const run = promisify(execFile);
const helper = path.resolve("scripts/opencode-browser-login.mjs");

async function fixture(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cuddly-login-"));
  try { await fn(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
const invoke = (args, env = {}) => run(process.execPath, [helper, ...args], { env: { ...process.env, ...env } });
const seed = (root, name = "A", origins = ["https://example.com"]) => saveState({
  configDir: root,
  name,
  origins,
  storageState: { cookies: [{ name: "sid", value: "secret-value", domain: "example.com", path: "/", secure: true }], origins: [] },
});

test("start rejects incomplete arguments before opening a browser", async () => fixture(async (root) => {
  const base = ["start", "--config-dir", root, "--name", "A"];
  await assert.rejects(invoke(base), (e) => e.code === 1 && /start requires --url/.test(e.stderr));
  await assert.rejects(invoke([...base, "--url", "https://example.com/login"]), (e) => e.code === 1 && /requires at least one --origin/.test(e.stderr));
  await assert.rejects(invoke([...base, "--url", "http://example.com/login", "--origin", "https://example.com", "--cookie", "sid"]), (e) => e.code === 1 && /--url must be https/.test(e.stderr));
  await assert.rejects(invoke([...base, "--url", "https://example.com/login", "--origin", "https://example.com/"]), (e) => e.code === 1 && /bare origin \(no path\)/.test(e.stderr));
  await assert.rejects(invoke([...base, "--url", "https://other.com/login", "--origin", "https://example.com", "--cookie", "sid"]), (e) => e.code === 1 && /--url host must be one of the configured --origin hosts/.test(e.stderr));
  await assert.rejects(invoke([...base, "--url", "https://example.com/login", "--origin", "https://example.com", "--timeout", "180"]), (e) => e.code === 1 && /not used by user-confirmed login/.test(e.stderr));
  await assert.rejects(invoke([...base, "--url", "https://example.com/login", "--origin", "https://example.com", "--complete-selector", "#account", "--complete-url", "https://identity.example/complete"]), (e) => e.code === 1 && /not used by user-confirmed login/.test(e.stderr));
}));

test("start needs no site-specific completion predicates, allows public URLs, and rejects per-command channels", () => {
  const options = login.validateStartArgs({ _: ["start"], "config-dir": "/tmp/config", name: "account", url: "https://example.com/", origin: ["https://example.com"] });
  assert.equal(options.completeSelector, undefined);
  assert.equal(options.timeout, undefined);
  assert.equal(options.url, "https://example.com/");
  assert.throws(() => login.validateStartArgs({
    "config-dir": "/tmp/config", name: "account", url: "https://example.com/", origin: ["https://example.com"], "browser-channel": "chrome",
  }), /shared browser settings/);
});

test("a headed browser launch failure removes its temporary profile", async () => fixture(async (root) => {
  const tmp = path.join(root, "tmp");
  await mkdir(tmp);
  await assert.rejects(
    invoke(["start", "--config-dir", root, "--name", "A", "--url", "https://example.com/login", "--origin", "https://example.com"], { TMPDIR: tmp, PLAYWRIGHT_BROWSERS_PATH: path.join(root, "missing-browsers") }),
    (e) => e.code === 1 && /login window could not open|graphical session|login worker exited before opening a window/.test(e.stderr),
  );
  assert.deepEqual((await readdir(tmp)).filter((name) => name.startsWith("prometheus-login-")), []);
}));

test("CLI status, remove, and validation handle missing, secret, and symlinked state", async () => fixture(async (root) => {
  await assert.rejects(invoke(["frobnicate", "--config-dir", root]), (e) => e.code === 1 && /unknown action/.test(e.stderr));
  await assert.rejects(invoke(["status"]), (e) => e.code === 1 && /--config-dir is required/.test(e.stderr));
  await assert.rejects(invoke(["start", "--config-dir", root, "--name", "has space", "--url", "https://example.com/login", "--origin", "https://example.com"]), (e) => e.code === 1 && /invalid session name/.test(e.stderr));

  assert.match((await invoke(["status", "--config-dir", root])).stdout, /No captured sessions/);
  seed(root, "A");
  const listed = await invoke(["status", "--config-dir", root]);
  assert.match(listed.stdout, /\[A\] origins=https:\/\/example\.com/);
  assert.doesNotMatch(listed.stdout, /secret-value|sid/);
  assert.equal((await invoke(["status", "--config-dir", root, "--name", "B"])).stdout.trim(), "[missing] B");

  assert.match((await invoke(["remove", "--config-dir", root, "--name", "A"])).stdout, /Removed captured session "A"/);
  assert.match((await invoke(["remove", "--config-dir", root, "--name", "A"])).stdout, /No captured session "A"/);

  const outside = path.join(root, "outside");
  const sessions = path.join(root, "prometheus-sessions");
  await rm(sessions, { recursive: true, force: true });
  await mkdir(outside);
  await writeFile(path.join(outside, "A.json"), "{}\n");
  await symlink(outside, sessions);
  await assert.rejects(invoke(["status", "--config-dir", root]), (e) => e.code === 1 && /sessions directory is a symlink/.test(e.stderr));
  await assert.rejects(invoke(["remove", "--config-dir", root, "--name", "A"]), (e) => e.code === 1 && /sessions directory is a symlink/.test(e.stderr));
}));

test("user-confirmed capture includes approved popups without creating storage helper tabs", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route("https://**/*", (route) => route.fulfill({
      contentType: "text/html", body: '<button id="account" hidden>Account</button>',
    }));
    const page = await context.newPage();
    await page.goto("https://site.example/login");
    const opts = { origins: ["https://site.example"], captureSessionStorage: true };
    await page.goto("https://identity.example/login");
    const popup = await context.newPage();
    await popup.goto("https://site.example/home");
    await popup.evaluate(() => {
      localStorage.setItem("account", "fixture");
      sessionStorage.setItem("tab", "fixture-tab");
      document.querySelector("#account").hidden = false;
    });
    let extraPages = 0;
    context.on("page", () => extraPages++);
    context.storageState = () => { throw new Error("storageState must not run during capture"); };
    const result = await login.captureConfirmedState(context, opts);
    assert.deepEqual(result.sessionStorage, { "https://site.example": { tab: "fixture-tab" } });
    assert.deepEqual(result.storageState.origins, [{ origin: "https://site.example", localStorage: [{ name: "account", value: "fixture" }] }]);
    assert.equal(extraPages, 0);
    assert.equal(context.pages().length, 2);
    assert.equal(page.url(), "https://identity.example/login");
    const restored = await browser.newContext({ storageState: result.storageState });
    await restored.route("https://site.example/**", (route) => route.fulfill({ contentType: "text/html", body: "Fixture" }));
    const restoredPage = await restored.newPage();
    await restoredPage.goto("https://site.example/home");
    assert.equal(await restoredPage.evaluate(() => localStorage.getItem("account")), "fixture");
  } finally { await browser.close(); }
});

test("closed login windows fail promptly and foreign origins are rejected without snapshots", async () => {
  await assert.rejects(login.captureConfirmedState({ pages: () => [] }, {}), /login window closed before capture/);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route("https://**/*", (route) => route.fulfill({ contentType: "text/html", body: '<button id="account">Account</button>' }));
    const page = await context.newPage();
    await page.goto("https://identity.example/");
    context.storageState = () => { throw new Error("unexpected snapshot"); };
    let pages = 0;
    context.on("page", () => pages++);
    await assert.rejects(login.captureConfirmedState(context, { origins: ["https://site.example"] }), /return to an approved site/);
    assert.equal(pages, 0);
  } finally { await browser.close(); }
});

test("detached login survives commands and saves only on explicit user completion", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cw-handoff-"));
  const worker = path.join(dir, "worker.mjs");
  const starter = path.join(dir, "starter.mjs");
  const cli = async action => JSON.parse((await run(process.execPath, [helper, action, "--config-dir", dir, "--name", "site"])).stdout);
  try {
    await writeFile(worker, `
      import { chromium } from ${JSON.stringify(import.meta.resolve("playwright"))};
      import { serveLogin } from ${JSON.stringify(new URL("../../scripts/opencode-browser-login.mjs", import.meta.url).href)};
      process.once('message', async opts => {
        await serveLogin(opts, { chromium: { launchPersistentContext: async (profile, options) => {
          await import('node:fs/promises').then(fs => fs.writeFile(${JSON.stringify(path.join(dir, "launch-options.json"))}, JSON.stringify(options)));
          const context = await chromium.launchPersistentContext(profile, {...options, headless: true});
          await context.route('https://**/*', route => route.fulfill({contentType: 'text/html', body:
            '<script>localStorage.setItem("session", "private-fixture"); document.cookie="sid=private-fixture; Secure";</script><p>No known account selector</p>'}));
          context.storageState = () => { throw new Error('storageState opens unwanted tabs'); };
          process.once('SIGUSR1', () => { void context.close(); });
          context.once('close', () => { void import('node:fs').then(fs => fs.writeFileSync(${JSON.stringify(path.join(dir, "closed"))}, 'closed')); });
          return context;
        }}});
      });
    `);
    await writeFile(path.join(dir, "prometheus-browser.json"), JSON.stringify({ channel: "default",
      contextOptions: { viewport: { width: 1440, height: 900 }, locale: "en-GB" } }));
    const opts = login.validateStartArgs({ "config-dir": dir, name: "site", url: "https://site.example/", origin: ["https://site.example"] });
    await writeFile(starter, `
      import { fork } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      import { startLogin } from ${JSON.stringify(new URL("../../scripts/opencode-browser-login.mjs", import.meta.url).href)};
      const result = await startLogin(${JSON.stringify(opts)}, { fork: (_file, args, options) => {
        const child = fork(${JSON.stringify(worker)}, args, options);
        writeFileSync(${JSON.stringify(path.join(dir, "pid"))}, String(child.pid));
        return child;
      }});
      console.log(JSON.stringify(result));
    `);
    const start = async () => JSON.parse((await run(process.execPath, [starter])).stdout);
    const started = await start();
    assert.equal(started.status, "awaiting-user");
    const launchOptions = JSON.parse(await readFile(path.join(dir, "launch-options.json"), "utf8"));
    assert.equal(launchOptions.headless, false, "the human login remains headed");
    assert.deepEqual(launchOptions.viewport, { width: 1440, height: 900 });
    assert.equal(launchOptions.locale, "en-GB");
    assert.equal(statMetadata(dir, "site"), null, "visible UI and cookies never trigger automatic capture");
    assert.equal((await cli("pending")).status, "awaiting-user");
    assert.equal(statMetadata(dir, "site"), null);
    await assert.rejects(login.startLogin(opts), /already open/);
    const completed = await cli("complete");
    assert.equal(completed.status, "saved");
    assert.equal(completed.authentication, "unverified");
    assert.doesNotMatch(JSON.stringify(completed), /private-fixture|sid|session/);
    const state = loadStateForOrigin({ configDir: dir, name: "site", origin: "https://site.example" });
    assert.deepEqual(state.verification, { method: "user-confirmed" });
    assert.equal(state.storageState.cookies[0].value, "private-fixture");
    assert.equal(loadStateForOrigin({ configDir: dir, name: "site", origin: "https://foreign.example" }), null);
    assert.equal((await stat(path.join(dir, "prometheus-sessions/site.json"))).mode & 0o777, 0o600);
    assert.equal((await cli("pending")).status, "not-running");
    assert.equal(await readFile(path.join(dir, "closed"), "utf8"), "closed");
    await assert.rejects(cli("complete"), /no pending login/);
    await start();
    const before = statMetadata(dir, "site").capturedAt;
    assert.equal((await cli("cancel")).status, "cancelled");
    assert.equal(statMetadata(dir, "site").capturedAt, before, "cancel leaves saved state intact");
    await start();
    process.kill(Number(await readFile(path.join(dir, "pid"), "utf8")), "SIGUSR1");
    for (let i = 0; i < 50 && (await cli("pending")).status !== "not-running"; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await cli("pending")).status, "not-running");
    assert.equal(statMetadata(dir, "site").capturedAt, before);
    await assert.rejects(cli("complete"), /no pending login/);
  } finally {
    await cli("cancel").catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("login handoff rejects symlinked control paths", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cw-handoff-path-"));
  try {
    const outside = path.join(dir, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(dir, "prometheus-logins"));
    await assert.rejects(login.loginCommand(dir, "site", "pending"), /unsafe login directory/);
    await rm(path.join(dir, "prometheus-logins"));
    await mkdir(path.join(dir, "prometheus-logins"));
    await symlink(path.join(dir, "missing"), path.join(dir, "prometheus-logins/site.sock"));
    await assert.rejects(login.loginCommand(dir, "site", "pending"), /unsafe login socket/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("ordinary Chromium login selects direct launch and CDP before site access on macOS and Linux", () => {
  for (const channel of ["default", "chromium", "chrome"]) {
    const selected = login.loginBrowserConfig({ channel, automationCompatibility: false });
    assert.deepEqual(selected, { channel, automationCompatibility: false, executionMode: "external-cdp" });
    assert.equal(selected.identityProfile, undefined);
    assert.equal(selected.profile, undefined);
  }
  assert.equal(login.loginBrowserConfig({ channel: "chrome", executionMode: "cdp" }).executionMode, "external-cdp");
  const configs = [
    ...["default", "chromium", "chrome", "msedge"].map(channel => ({ channel, automationCompatibility: false })),
    { channel: "default", identityProfile: false },
    { channel: "default", profile: "desktop-linux-chrome-fhd" },
    { channel: "default", profile: { seed: "login", os: "macOS", engine: "chromium", legacy: false } },
    { channel: "default", identityProfile: "random" },
    { channel: "default", contextOptions: { viewport: { width: 1440, height: 900 } } },
    { channel: "default", launchOptions: { slowMo: 10 } },
    { channel: "default", executionMode: "virtual-display" },
    { channel: "chrome", executionMode: "cdp" },
  ];
  const expected = configs.map(config => login.loginBrowserConfig(config));
  for (const platform of ["darwin", "linux"]) {
    const script = `
      Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });
      const { loginBrowserConfig } = await import(${JSON.stringify(new URL("../../scripts/opencode-browser-login.mjs", import.meta.url).href)});
      console.log(JSON.stringify(${JSON.stringify(configs)}.map(config => loginBrowserConfig(config))));
    `;
    const actual = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 15000 }));
    assert.deepEqual(actual, expected, platform);
  }
});

for (const channel of ["default", "chromium", "chrome"]) {
  test(`${channel} login uses the CDP handoff without changing task settings`, async () => {
    const configDir = await mkdtemp(path.join(os.tmpdir(), "login-cdp-default-"));
    const browserConfig = { channel, automationCompatibility: false };
    let disconnected = 0, closed = 0;
    const page = { goto: async () => {}, close: async () => { closed++; } };
    const context = Object.assign(new EventEmitter(), { newPage: async () => page });
    try {
      await login.serveLogin({ configDir, name: "site", url: "https://site.example/", origins: ["https://site.example"], browser: browserConfig }, {
        chromium: { launchPersistentContext: async () => assert.fail("must not launch through Playwright") },
        launchExternalCdpContext: async (_engine, config, options) => {
          assert.deepEqual(config, { ...browserConfig, executionMode: "external-cdp" });
          assert.equal(options.headless, false);
          return { context, browser: { close: async () => { disconnected++; } } };
        },
      });
      assert.deepEqual(browserConfig, { channel, automationCompatibility: false });
      assert.equal(statMetadata(configDir, "site"), null);
      assert.equal((await login.loginCommand(configDir, "site", "cancel")).status, "cancelled");
      assert.equal(disconnected, 1);
      assert.equal(closed, 1);
    } finally {
      await login.loginCommand(configDir, "site", "cancel").catch(() => {});
      await rm(configDir, { recursive: true, force: true });
    }
  });
}

for (const action of ["complete", "cancel", "navigation-failure", "attachment-failure"]) {
  test(`CDP login ${action} preserves the attached context and existing tabs`, async () => {
    const configDir = await mkdtemp(path.join(os.tmpdir(), "login-cdp-"));
    const endpoint = "http://127.0.0.1:9222";
    let connections = 0, disconnects = 0, tabCloses = 0, navigations = 0;
    const existingPage = { url: () => "https://unrelated.example/" };
    const page = {
      url: () => "https://site.example/",
      evaluate: async () => ({ origin: "https://site.example", localStorage: [] }),
      goto: async (url) => {
        navigations++;
        assert.equal(url, "https://site.example/");
        if (action === "navigation-failure") throw new Error("fixture navigation failure");
      },
      close: async () => { tabCloses++; },
    };
    const context = Object.assign(new EventEmitter(), {
      pages: () => [existingPage, page],
      newPage: async () => page,
      cookies: async () => [],
      close: async () => assert.fail("must not close an externally owned context"),
    });
    const fakeChromium = {
      launchPersistentContext: async () => assert.fail("CDP login must not use Playwright launch"),
      connectOverCDP: async (url, options) => {
        connections++;
        assert.equal(url, endpoint);
        assert.equal(options.timeout, 1000);
        if (action === "attachment-failure") throw new Error("fixture connection failure");
        return { contexts: () => [context], close: async () => { disconnects++; } };
      },
    };
    try {
      await login.serveLogin({ configDir, name: "site", url: "https://site.example/", origins: ["https://site.example"],
        browser: { channel: "chrome", executionMode: "external-cdp", automationCompatibility: false,
          cdpOptions: { endpoint, timeout: 1000 } } }, {
        chromium: fakeChromium,
        launchExternalCdpContext: async (engine, config, options) => {
          assert.equal(options.headless, false, "login forces headed process startup");
          assert.equal(config.identityProfile, undefined, "no random identity added to CDP login");
          return launchExternalCdpContext(engine, config, options);
        },
      });
      assert.equal(connections, 1, "attachment is never automatically retried");
      assert.equal(statMetadata(configDir, "site"), null, "no capture before user completion");
      if (action === "complete" || action === "cancel") {
        assert.equal((await login.loginCommand(configDir, "site", "pending")).status, "awaiting-user");
        const result = await login.loginCommand(configDir, "site", action);
        assert.equal(result.status, action === "complete" ? "saved" : "cancelled");
        assert.equal(Boolean(statMetadata(configDir, "site")), action === "complete");
      }
      assert.equal(disconnects, action === "attachment-failure" ? 0 : 1);
      assert.equal(tabCloses, action === "attachment-failure" ? 0 : 1);
      assert.equal(navigations, action === "attachment-failure" ? 0 : 1);
      assert.equal((await login.loginCommand(configDir, "site", "pending")).status, "not-running");
    } finally {
      await login.loginCommand(configDir, "site", "cancel").catch(() => {});
      await rm(configDir, { recursive: true, force: true });
    }
  });
}
