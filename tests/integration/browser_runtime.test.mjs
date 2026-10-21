import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTaskContext, hydrateBrowserState, browserLaunchOptions, browserContextOptions, browserRuntimeInfo, validateBrowserConfig, browserConfigFromEnv, applyAutomationCompatibility } from "../../scripts/opencode-browser-runtime.mjs";

const channels = [...new Set(["default", "chromium", process.env.PROMETHEUS_TEST_BROWSER_CHANNEL].filter(Boolean))];

for (const channel of channels) {
  test(`supported ${channel} runtime restores private storage before page scripts`, async () => {
    const { browser, context } = await createTaskContext(chromium, { channel });
    try {
      await hydrateBrowserState(context, {
        storageState: { cookies: [], origins: [{ origin: "https://fixture.example", localStorage: [{ name: "local", value: "fixture" }] }] },
        sessionStorage: { "https://fixture.example": { session: "fixture" } },
      });
      await context.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: '<script>window.restored = localStorage.getItem("local") === "fixture" && sessionStorage.getItem("session") === "fixture";</script>' }));
      const page = await context.newPage();
      await page.goto("https://fixture.example");
      assert.equal(await page.evaluate(() => window.restored), true);
      await page.goto("https://other.example");
      assert.equal(await page.evaluate(() => window.restored), false);
    } finally { await browser.close(); }
  });
}

test("headed capture uses the same selected channel", () => {
  assert.deepEqual(browserLaunchOptions({ channel: "chromium" }, false), { headless: false, channel: "chromium" });
});

test("virtual-display mode selects headed task execution without changing human login", () => {
  const config = validateBrowserConfig({ channel: "chrome", executionMode: "virtual-display" });
  assert.equal(browserLaunchOptions(config).headless, false);
  assert.equal(browserLaunchOptions(config, false).headless, false);
  assert.equal(browserLaunchOptions({ channel: "chrome" }).headless, true);
  assert.throws(() => validateBrowserConfig({ channel: "chrome", executionMode: "headed" }));
  assert.equal(browserConfigFromEnv({ PROMETHEUS_BROWSER_EXECUTION_MODE: "virtual-display" }).executionMode, "virtual-display");
});

test("automation compatibility is opt-in and shared by headed and headless launches", () => {
  const config = { channel: "chrome", automationCompatibility: true };
  for (const headless of [false, true]) {
    assert.deepEqual(browserLaunchOptions(config, headless), {
      headless, channel: "chrome", ignoreDefaultArgs: ["--enable-automation"],
      args: ["--disable-blink-features=AutomationControlled"],
    });
    assert.deepEqual(browserLaunchOptions({ channel: "chrome", automationCompatibility: false }, headless), { headless, channel: "chrome" });
  }
  assert.throws(() => validateBrowserConfig({ channel: "chrome", automationCompatibility: "true" }));
  assert.deepEqual(browserConfigFromEnv({ PROMETHEUS_BROWSER_AUTOMATION_COMPATIBILITY: "true" }), { channel: "default", automationCompatibility: true });
  assert.throws(() => browserConfigFromEnv({ PROMETHEUS_BROWSER_AUTOMATION_COMPATIBILITY: "yes" }));
});

test("automation compatibility hides navigator.webdriver and overrides languages and plugins", async () => {
  const { browser, context } = await createTaskContext(chromium, { channel: "default", automationCompatibility: true });
  try {
    const page = await context.newPage();
    await page.goto("about:blank");
    const result = await page.evaluate(() => ({
      webdriver: navigator.webdriver,
      inNav: "webdriver" in navigator,
      languages: navigator.languages,
      plugins: Array.from(navigator.plugins),
    }));
    assert.equal(result.webdriver, undefined);
    assert.equal(result.inNav, false);
    assert.deepEqual(result.languages, ["en-US", "en"]);
    assert.deepEqual(result.plugins, [1, 2, 3, 4, 5]);
  } finally {
    await browser.close();
  }
});

test("identityProfile configuration validates profile IDs and parses environment", () => {
  assert.equal(validateBrowserConfig({ channel: "default", identityProfile: "win-chrome-124-intel" }).identityProfile, "win-chrome-124-intel");
  assert.equal(validateBrowserConfig({ channel: "default", identityProfile: true }).identityProfile, true);
  assert.equal(validateBrowserConfig({ channel: "default", identityProfile: "random" }).identityProfile, "random");
  assert.throws(() => validateBrowserConfig({ channel: "default", identityProfile: "invalid-profile" }));
  assert.throws(() => validateBrowserConfig({ channel: "default", identityProfile: 123 }));
  assert.equal(browserConfigFromEnv({ PROMETHEUS_BROWSER_IDENTITY_PROFILE: "win-chrome-124-intel" }).identityProfile, "win-chrome-124-intel");
  assert.equal(browserConfigFromEnv({ PROMETHEUS_BROWSER_IDENTITY_PROFILE: "true" }).identityProfile, true);
});

test("identity profile sets coherent user agent, platform, and WebGL vendor and renderer", async () => {
  const { browser, context } = await createTaskContext(chromium, {
    channel: "default",
    identityProfile: "win-chrome-124-intel",
  });
  try {
    const page = await context.newPage();
    await page.goto("about:blank");
    const result = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
      const debugInfo = gl?.getExtension("WEBGL_debug_renderer_info");
      return {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        glVendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : null,
        glRenderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : null,
      };
    });
    assert.match(result.userAgent, /Windows NT 10\.0; Win64; x64.*Chrome\/124/);
    assert.equal(result.platform, "Win32");
    assert.equal(result.glVendor, "Intel Inc.");
    assert.equal(result.glRenderer, "Intel(R) Iris(R) Xe Graphics");
  } finally {
    await browser.close();
  }
});

test("shared settings override inherited values and reject malformed files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "browser-profile-"));
  try {
    const settings = { channel: "chrome", executionMode: "virtual-display", automationCompatibility: true };
    await writeFile(path.join(dir, "prometheus-browser.json"), JSON.stringify(settings));
    const env = { PROMETHEUS_CONFIG_DIR: dir, PROMETHEUS_BROWSER_CHANNEL: "chromium",
      PROMETHEUS_BROWSER_EXECUTION_MODE: "headless", PROMETHEUS_BROWSER_AUTOMATION_COMPATIBILITY: "false" };
    const config = browserConfigFromEnv(env);
    assert.deepEqual(config, settings);
    assert.equal(browserLaunchOptions(config).headless, false);
    assert.equal(browserLaunchOptions(config, false).channel, "chrome");
    await writeFile(path.join(dir, "prometheus-browser.json"), "not json");
    assert.throws(() => browserConfigFromEnv(env), /settings/);
    await writeFile(path.join(dir, "prometheus-browser.json"), JSON.stringify({ ...settings, executionMode: "headed" }));
    assert.throws(() => browserConfigFromEnv(env), /settings/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("launch and context options are explicit, copied, and leave existing defaults unchanged", () => {
  assert.deepEqual(browserContextOptions({ channel: "default" }), { viewport: { width: 1280, height: 1024 } });
  const config = { channel: "chrome", automationCompatibility: true,
    launchOptions: { chromiumSandbox: true, slowMo: 10, timeout: 15000 },
    contextOptions: { viewport: { width: 1920, height: 1080 }, screen: { width: 1920, height: 1200 },
      deviceScaleFactor: 2, locale: "en-GB", timezoneId: "Europe/London", colorScheme: "dark", reducedMotion: "reduce" } };
  const selected = validateBrowserConfig(config);
  assert.deepEqual(selected, config);
  selected.contextOptions.viewport.width = 100;
  assert.equal(config.contextOptions.viewport.width, 1920, "normalization does not mutate caller options");
  assert.deepEqual(browserContextOptions(config), config.contextOptions);
  assert.deepEqual(browserLaunchOptions(config), { ...config.launchOptions, headless: true, channel: "chrome",
    ignoreDefaultArgs: ["--enable-automation"], args: ["--disable-blink-features=AutomationControlled"] });
  assert.equal(browserLaunchOptions(config, false).headless, false);
  assert.deepEqual(browserContextOptions({ channel: "chrome", contextOptions: { viewport: null, colorScheme: null } }), { viewport: null, colorScheme: null });
});

test("invalid context settings fail before a browser can start", async () => {
  const invalid = [null, [], { viewport: { width: 0, height: 10 } }, { viewport: { width: 10.5, height: 10 } },
    { viewport: { width: 10, height: 16385 } }, { screen: { width: 10 } }, { viewport: null, deviceScaleFactor: 2 },
    { viewport: null, screen: { width: 10, height: 10 } }, { deviceScaleFactor: 0 }, { deviceScaleFactor: 9 },
    { locale: "not_a_locale" }, { locale: [] }, { timezoneId: "No/Such_Zone" }, { timezoneId: 10 },
    { colorScheme: "auto" }, { reducedMotion: true }, { userAgent: "" }, { userAgent: 123 }, { arbitraryOption: "not accepted" }, { storageState: {} }];
  let launched = false;
  for (const contextOptions of invalid) {
    await assert.rejects(createTaskContext({ launch() { launched = true; } }, { channel: "default", contextOptions }));
  }
  assert.equal(launched, false);
});

test("contextOptions accepts valid userAgent overrides and passes them to context", async () => {
  const seen = {};
  const browser = { newContext: async options => { seen.context = options; return {}; } };
  const chromiumStub = { launch: async () => browser };
  const config = { channel: "default", contextOptions: { userAgent: "Mozilla/5.0 CustomResearchAgent/1.0" } };
  await createTaskContext(chromiumStub, config);
  assert.equal(seen.context.userAgent, "Mozilla/5.0 CustomResearchAgent/1.0");
});

test("launch settings reject arbitrary arguments, credentials, and unbounded delays", () => {
  for (const launchOptions of [null, [], { args: ["--anything"] }, { headless: false }, { proxy: {} },
    { chromiumSandbox: "true" }, { slowMo: -1 }, { slowMo: Infinity }, { slowMo: 1001 },
    { timeout: 0 }, { timeout: 120001 }, { timeout: "1000" }]) {
    assert.throws(() => validateBrowserConfig({ channel: "default", launchOptions }));
  }
});

test("the task launch applies context settings and closes the browser if context creation fails", async () => {
  const seen = {};
  let closed = false;
  const context = {};
  const browser = { newContext: async options => { seen.context = options; return context; }, close: async () => { closed = true; } };
  const chromiumStub = { launch: async options => { seen.launch = options; return browser; } };
  const config = { channel: "default", contextOptions: { locale: "en-GB" }, launchOptions: { slowMo: 0 } };
  assert.deepEqual(await createTaskContext(chromiumStub, config), { browser, context });
  assert.deepEqual(seen.context, { viewport: { width: 1280, height: 1024 }, locale: "en-GB" });
  assert.deepEqual(seen.launch, { slowMo: 0, headless: true });
  browser.newContext = async () => { throw new Error("fixture context failure"); };
  await assert.rejects(createTaskContext(chromiumStub, config), /fixture context failure/);
  assert.equal(closed, true);
});

test("runtime metadata identifies the selected distribution without starting a browser", () => {
  const shell = browserRuntimeInfo({ channel: "default" });
  assert.equal(shell.configuredDistribution, "chromium-headless-shell");
  assert.match(shell.playwrightVersion, /^\d+\.\d+\.\d+/);
  assert.equal(shell.platform, process.platform);
  assert.equal(shell.architecture, process.arch);
  assert.equal(shell.nodeVersion, process.versions.node);
  assert.deepEqual(shell.contextOptions, browserContextOptions({ channel: "default" }));
  assert.equal(browserRuntimeInfo({ channel: "chrome" }).configuredDistribution, "installed-chrome");
  assert.equal(browserRuntimeInfo({ channel: "default", executionMode: "virtual-display" }).configuredDistribution, "chromium");
});

test("settings files carry launch and context options through normalization", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "browser-assembly-"));
  try {
    const config = { channel: "chrome", launchOptions: { slowMo: 0 }, contextOptions: { locale: "en-GB" } };
    await writeFile(path.join(dir, "prometheus-browser.json"), JSON.stringify(config));
    assert.deepEqual(browserConfigFromEnv({ PROMETHEUS_CONFIG_DIR: dir }), config);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("external-cdp mode validates cdpOptions and environment variables", () => {
  const valid = validateBrowserConfig({ channel: "chrome", executionMode: "external-cdp", cdpOptions: { port: 9222, timeout: 5000 } });
  assert.equal(valid.executionMode, "external-cdp");
  assert.deepEqual(valid.cdpOptions, { port: 9222, timeout: 5000 });
  assert.throws(() => validateBrowserConfig({ channel: "chrome", executionMode: "external-cdp", cdpOptions: { port: -1 } }));
  assert.throws(() => validateBrowserConfig({ channel: "chrome", executionMode: "external-cdp", cdpOptions: { timeout: 0 } }));
  assert.throws(() => validateBrowserConfig({ channel: "chrome", executionMode: "external-cdp", cdpOptions: { endpoint: "" } }));
  assert.equal(browserRuntimeInfo({ channel: "chrome", executionMode: "external-cdp" }).configuredDistribution, "external-chrome-cdp");

  const env = { PROMETHEUS_BROWSER_CHANNEL: "chrome", PROMETHEUS_BROWSER_EXECUTION_MODE: "external-cdp", PROMETHEUS_BROWSER_CDP_PORT: "9222" };
  assert.deepEqual(browserConfigFromEnv(env), { channel: "chrome", executionMode: "external-cdp", cdpOptions: { port: 9222 } });
});

test("external-cdp mode attaches through remote debugging and uses the existing browser context", async () => {
  const { browser, context } = await createTaskContext(chromium, { channel: "default", executionMode: "external-cdp" });
  try {
    assert.ok(browser);
    assert.ok(context);
    const page = (typeof context.pages === "function" && context.pages()[0]) || await context.newPage();
    await page.goto("about:blank");
    assert.equal(await page.title(), "");
  } finally {
    await browser.close();
  }
});

