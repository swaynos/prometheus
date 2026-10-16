import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTaskContext, hydrateBrowserState, browserLaunchOptions, validateBrowserConfig, browserConfigFromEnv } from "../../scripts/opencode-browser-runtime.mjs";

for (const channel of ["default", "chromium"]) {
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
