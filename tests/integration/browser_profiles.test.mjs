import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { chromium, devices } from "playwright";
import { BROWSER_PROFILES, PROFILE_CATALOG_SHA256, browserProfileInfo, getBrowserProfile,
  listBrowserProfiles, resolveBrowserProfile, currentHostOs, getHostMatchedProfile } from "../../scripts/browser-profiles.mjs";
import { browserConfigFromEnv, browserContextOptions, browserLaunchOptions, browserRuntimeInfo,
  collectBrowserProfileEvidence, createTaskContext, selectBrowserType, validateBrowserConfig } from "../../scripts/opencode-browser-runtime.mjs";

test("catalog is pinned, unique, immutable, and includes every upstream device", () => {
  assert.equal(BROWSER_PROFILES.length, 241);
  assert.equal(new Set(BROWSER_PROFILES.map(p => p.id)).size, 241);
  assert.match(PROFILE_CATALOG_SHA256, /^[a-f0-9]{64}$/);
  assert.equal(PROFILE_CATALOG_SHA256, "b4ab055b31a64f037a77c5288f2cd431d9bb773fac371e0da99e6538e4bfff5a", "catalog changes require explicit review");
  for (const [name, descriptor] of Object.entries(devices)) {
    const p = BROWSER_PROFILES.find(p => p.source.descriptor === name && p.validation === "upstream-emulation-preset");
    assert.ok(p, name);
    const { defaultBrowserType, ...options } = descriptor;
    assert.deepEqual(p.contextOptions, options);
    assert.equal(p.engine, defaultBrowserType);
    assert.equal(p.source.revision, "v1.63.0");
    assert.equal(p.gpu, null);
    assert.equal(p.clientHints, null);
    assert.throws(() => { p.contextOptions.viewport.width = 5; }, TypeError);
  }
  for (const p of BROWSER_PROFILES) {
    assert.ok(["chromium", "firefox", "webkit"].includes(p.engine));
    assert.equal(p.userAgent, p.contextOptions.userAgent);
    assert.ok(p.contextOptions.viewport.width > 0);
    assert.ok(p.contextOptions.deviceScaleFactor > 0);
    if (p.engine === "firefox") assert.equal(p.contextOptions.isMobile, false);
    if (p.id.startsWith("desktop-") && p.engine === "firefox") assert.match(p.userAgent, /; rv:/);
    if (p.id.startsWith("desktop-") && p.engine === "webkit") assert.equal(p.os, "macOS");
  }
});

test("selection is deterministic, strict, and excludes legacy unless requested", () => {
  const filters = { engine: "chromium", os: "Android", deviceClass: "phone", orientation: "portrait" };
  const a = getBrowserProfile(undefined, { seed: "research-campaign-1", ...filters });
  assert.equal(getBrowserProfile(undefined, { seed: "research-campaign-1", ...filters }), a);
  assert.equal(resolveBrowserProfile({ seed: "research-campaign-1", ...filters }), a);
  for (const [key, value] of Object.entries(filters)) assert.equal(a[key], value);
  assert.equal(a.legacy, false);
  for (let i = 0; i < 30; i++) assert.equal(getBrowserProfile().legacy, false);
  assert.ok(listBrowserProfiles({ legacy: true }).length > 4);
  for (const filters of [null, [], { engine: "unknown" }, { typo: "x" }, { legacy: "false" }]) {
    assert.throws(() => listBrowserProfiles(filters));
  }
  for (const selection of ["", true, {}, { seed: "" }, { seed: "x", unexpected: true }]) assert.throws(() => resolveBrowserProfile(selection));
  assert.throws(() => getBrowserProfile("missing"));
  assert.throws(() => getBrowserProfile(undefined, { seed: "x", engine: "webkit", os: "Windows", legacy: false }));
  const info = browserProfileInfo(a.id);
  info.contextOptions.viewport.width = 3;
  assert.notEqual(a.contextOptions.viewport.width, 3);
  assert.equal(info.catalogSHA256, PROFILE_CATALOG_SHA256);
});

test("Linux Chrome presets retain upstream versions and permit repeatable display variation", () => {
  const profiles = BROWSER_PROFILES.filter(p => p.id.startsWith("desktop-linux-chrome-"));
  assert.equal(profiles.length, 3);
  const upstreamVersion = /Chrome\/([\d.]+)/.exec(devices["Desktop Chrome"].userAgent)[1];
  for (const profile of profiles) {
    assert.equal(profile.browserVersion, upstreamVersion);
    assert.equal(/Chrome\/([\d.]+)/.exec(profile.userAgent)[1], upstreamVersion);
  }
  const ids = new Set();
  for (let i = 0; i < 30; i++) {
    const selection = { seed: `linux-${i}`, os: "Linux", engine: "chromium", deviceClass: "desktop", legacy: false };
    const config = validateBrowserConfig({ channel: "default", profile: selection });
    assert.deepEqual(validateBrowserConfig({ channel: "default", profile: selection }), config);
    ids.add(config.profile);
  }
  assert.ok(ids.size > 1, "selection must not force one Linux preset");
});

test("configuration resolves seeds and exposes non-secret reproducibility metadata", () => {
  const config = { channel: "default", profile: { seed: "campaign", engine: "chromium", os: "Android" } };
  const normalized = validateBrowserConfig(config);
  assert.equal(typeof normalized.profile, "string");
  assert.deepEqual(validateBrowserConfig(normalized), normalized);
  assert.equal(browserRuntimeInfo(config).profile.id, normalized.profile);
  assert.equal(browserRuntimeInfo(config).profile.catalogSHA256, PROFILE_CATALOG_SHA256);
  assert.equal(browserConfigFromEnv({ PROMETHEUS_BROWSER_PROFILE: "pw-pixel-7" }).profile, "pw-pixel-7");
  const options = browserContextOptions(normalized);
  options.viewport.width = 1;
  assert.notEqual(browserContextOptions(normalized).viewport.width, 1);
  assert.equal(browserLaunchOptions({ channel: "default", profile: "pw-desktop-edge" }).channel, "msedge");
  assert.equal(browserRuntimeInfo({ channel: "default", profile: "pw-desktop-safari" }).configuredDistribution, "webkit");
  for (const extra of [
    { executionMode: "external-cdp" }, { contextOptions: { viewport: { width: 500, height: 500 } } }, { identityProfile: true },
  ]) assert.throws(() => validateBrowserConfig({ channel: "default", profile: "pw-pixel-7", ...extra }));
  assert.throws(() => validateBrowserConfig({ channel: "chrome", profile: "pw-desktop-firefox" }));
  assert.throws(() => validateBrowserConfig({ channel: "default", profile: "pw-desktop-safari", automationCompatibility: true }));
  assert.throws(() => validateBrowserConfig({ channel: "chrome", profile: "pw-desktop-edge" }));
});

test("real engine selection is shared with login and task context creation", async () => {
  const chromiumStub = { launch() { throw new Error("wrong engine"); } };
  for (const [id, engine] of [["pw-desktop-firefox", "firefox"], ["pw-desktop-safari", "webkit"]]) {
    let seen;
    let closed = false;
    const context = {};
    const browser = { newContext: async options => { seen = options; return context; }, close: async () => { closed = true; }, version: () => "test-version" };
    const engines = { [engine]: { launch: async options => { assert.equal(options.channel, undefined); return browser; } } };
    const config = { channel: "default", profile: id };
    assert.equal(await selectBrowserType(chromiumStub, config, engines), engines[engine]);
    const result = await createTaskContext(chromiumStub, config, engines);
    assert.equal(result.context, context);
    assert.deepEqual(seen, browserContextOptions(config));
    assert.equal(result.runtime.browserVersion, "test-version");
    browser.newContext = async () => { throw new Error("context failed"); };
    await assert.rejects(createTaskContext(chromiumStub, config, engines), /context failed/);
    assert.equal(closed, true);
  }
});

test("mobile profile applies HTTP/JS UA, screen, scale, viewport and touch without GPU spoof scripts", async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.headers);
    res.setHeader("Content-Type", "text/html");
    res.end('<meta name="viewport" content="width=device-width, initial-scale=1"><title>profile fixture</title>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    const config = { channel: "default", profile: "pw-pixel-7" };
    const result = await createTaskContext(chromium, config);
    browser = result.browser;
    const page = await result.context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const evidence = await collectBrowserProfileEvidence(page);
    const expected = getBrowserProfile(config.profile).contextOptions;
    assert.equal(evidence.userAgent, expected.userAgent);
    assert.equal(requests[0]["user-agent"], expected.userAgent);
    assert.deepEqual(evidence.viewport, expected.viewport);
    assert.deepEqual(evidence.screen, expected.screen ?? expected.viewport);
    assert.equal(evidence.deviceScaleFactor, expected.deviceScaleFactor);
    assert.ok(evidence.maxTouchPoints > 0);
    assert.equal(result.runtime.profile.id, config.profile);
    assert.equal(result.runtime.browserVersion, browser.version());
    // No invented complete identity: the observed platform and optional GPU remain native.
    assert.equal(typeof evidence.platform, "string");
    assert.ok(evidence.webgl === null || typeof evidence.webgl.renderer === "string");
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test("catalog CLI supports filtered listing, inspection and reproducible sampling", () => {
  const run = (...args) => JSON.parse(execFileSync(process.execPath, ["scripts/browser-profiles.mjs", ...args], { encoding: "utf8" }));
  assert.equal(run("show", "pw-pixel-7").id, "pw-pixel-7");
  assert.deepEqual(run("sample", "seed", "--engine", "chromium"), run("sample", "seed", "--engine", "chromium"));
  assert.ok(run("list", "--engine", "firefox").profiles.every(p => p.engine === "firefox"));
});

test("host profile matching guards against Windows and unrecognised platforms", () => {
  assert.throws(() => currentHostOs("win32"), /Windows is not supported/);
  assert.throws(() => currentHostOs("freebsd"), /unsupported host platform/);
  assert.equal(currentHostOs("darwin"), "macOS");
  assert.equal(currentHostOs("linux"), "Linux");

  const mac = getHostMatchedProfile({ platform: "darwin", seed: "test-seed" });
  assert.equal(mac.os, "macOS");
  assert.equal(mac.engine, "chromium");
  assert.equal(mac.deviceClass, "desktop");

  const linux = getHostMatchedProfile({ platform: "linux", seed: "test-seed" });
  assert.equal(linux.os, "Linux");
  assert.equal(linux.engine, "chromium");
  assert.equal(linux.deviceClass, "desktop");

  assert.throws(() => getHostMatchedProfile({ platform: "win32" }), /Windows is not supported/);
});
