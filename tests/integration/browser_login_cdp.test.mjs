import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serveLogin, loginCommand, loginBrowserConfig } from "../../scripts/opencode-browser-login.mjs";
import { launchExternalCdpContext } from "../../scripts/opencode-browser-runtime.mjs";
import { statMetadata } from "../../scripts/opencode-browser-state.mjs";

test("ordinary Chromium login selects direct launch and CDP before site access", () => {
  for (const channel of ["default", "chromium", "chrome"]) {
    const selected = loginBrowserConfig({ channel, automationCompatibility: false });
    assert.deepEqual(selected, { channel, automationCompatibility: false, executionMode: "external-cdp" });
    assert.equal(selected.identityProfile, undefined);
    assert.equal(selected.profile, undefined);
  }
  assert.equal(loginBrowserConfig({ channel: "chrome", executionMode: "cdp" }).executionMode, "external-cdp");
  for (const config of [
    { channel: "default", profile: "pw-desktop-firefox" },
    { channel: "default", profile: "pw-desktop-safari" },
    { channel: "default", profile: "pw-pixel-7" },
    { channel: "default", identityProfile: "random" },
    { channel: "default", identityProfile: "pw-desktop-firefox" },
    { channel: "default", contextOptions: { viewport: { width: 1440, height: 900 } } },
    { channel: "default", launchOptions: { slowMo: 10 } },
    { channel: "default", executionMode: "virtual-display" },
    { channel: "msedge" },
  ]) assert.notEqual(loginBrowserConfig(config).executionMode, "external-cdp", JSON.stringify(config));
});

test("macOS and Linux retain the same login selection rules", () => {
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
  const expected = configs.map(config => loginBrowserConfig(config));
  for (const platform of ["darwin", "linux"]) {
    // Isolate the injected platform from this test process and Playwright imports.
    const script = `
      Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });
      const { loginBrowserConfig } = await import(${JSON.stringify(new URL("../../scripts/opencode-browser-login.mjs", import.meta.url).href)});
      console.log(JSON.stringify(${JSON.stringify(configs)}.map(config => loginBrowserConfig(config))));
    `;
    const actual = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 15000 }));
    assert.deepEqual(actual, expected, platform);
    assert.deepEqual(actual[0], { channel: "default", automationCompatibility: false, executionMode: "external-cdp" });
    assert.equal(actual[3].executionMode, undefined, "Edge retains its previous path");
    assert.equal(actual[4].identityProfile, false, "explicit identity opt-out is retained");
    assert.equal(actual[5].profile, "desktop-linux-chrome-fhd", "explicit presets are retained");
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
      await serveLogin({ configDir, name: "site", url: "https://site.example/", origins: ["https://site.example"], browser: browserConfig }, {
        chromium: { launchPersistentContext: async () => assert.fail("must not launch through Playwright") },
        launchExternalCdpContext: async (_engine, config, options) => {
          assert.deepEqual(config, { ...browserConfig, executionMode: "external-cdp" });
          assert.equal(options.headless, false);
          return { context, browser: { close: async () => { disconnected++; } } };
        },
      });
      assert.deepEqual(browserConfig, { channel, automationCompatibility: false });
      assert.equal(statMetadata(configDir, "site"), null);
      assert.equal((await loginCommand(configDir, "site", "cancel")).status, "cancelled");
      assert.equal(disconnected, 1);
      assert.equal(closed, 1);
    } finally {
      await loginCommand(configDir, "site", "cancel").catch(() => {});
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
    const chromium = {
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
      await serveLogin({ configDir, name: "site", url: "https://site.example/", origins: ["https://site.example"],
        browser: { channel: "chrome", executionMode: "external-cdp", automationCompatibility: false,
          cdpOptions: { endpoint, timeout: 1000 } } }, {
        chromium,
        launchExternalCdpContext: async (engine, config, options) => {
          assert.equal(options.headless, false, "login forces headed process startup");
          assert.equal(config.identityProfile, undefined, "no random identity added to CDP login");
          return launchExternalCdpContext(engine, config, options);
        },
      });
      assert.equal(connections, 1, "attachment is never automatically retried");
      assert.equal(statMetadata(configDir, "site"), null, "no capture before user completion");
      if (action === "complete" || action === "cancel") {
        assert.equal((await loginCommand(configDir, "site", "pending")).status, "awaiting-user");
        const result = await loginCommand(configDir, "site", action);
        assert.equal(result.status, action === "complete" ? "saved" : "cancelled");
        assert.equal(Boolean(statMetadata(configDir, "site")), action === "complete");
      }
      assert.equal(disconnects, action === "attachment-failure" ? 0 : 1);
      assert.equal(tabCloses, action === "attachment-failure" ? 0 : 1);
      assert.equal(navigations, action === "attachment-failure" ? 0 : 1);
      assert.equal((await loginCommand(configDir, "site", "pending")).status, "not-running");
    } finally {
      await loginCommand(configDir, "site", "cancel").catch(() => {});
      await rm(configDir, { recursive: true, force: true });
    }
  });
}
