import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn, execSync } from "node:child_process";
import { createRequire } from "node:module";
import { BROWSER_PROFILES, getBrowserProfile, resolveBrowserProfile, browserProfileInfo } from "./browser-profiles.mjs";

const require = createRequire(import.meta.url);

function optionObject(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`invalid ${label}`);
  }
  return { ...value };
}

function dimensions(value, label) {
  const size = optionObject(value, ["width", "height"], label);
  if (![size.width, size.height].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 16384)) {
    throw new Error(`${label} dimensions must be integers from 1 to 16384`);
  }
  return size;
}

function validateLaunchOptions(value) {
  const options = optionObject(value, ["chromiumSandbox", "slowMo", "timeout"], "launchOptions");
  if (options.chromiumSandbox !== undefined && typeof options.chromiumSandbox !== "boolean") {
    throw new Error("chromiumSandbox must be boolean");
  }
  if (options.slowMo !== undefined && (!Number.isFinite(options.slowMo) || options.slowMo < 0 || options.slowMo > 1000)) {
    throw new Error("slowMo must be from 0 to 1000 milliseconds");
  }
  if (options.timeout !== undefined && (!Number.isSafeInteger(options.timeout) || options.timeout <= 0 || options.timeout > 120000)) {
    throw new Error("launch timeout must be from 1 to 120000 milliseconds");
  }
  return options;
}

function validateContextOptions(value) {
  const options = optionObject(value, ["viewport", "screen", "deviceScaleFactor", "locale", "timezoneId", "colorScheme", "reducedMotion", "userAgent"], "contextOptions");
  if (options.viewport !== undefined && options.viewport !== null) options.viewport = dimensions(options.viewport, "viewport");
  if (options.screen !== undefined) options.screen = dimensions(options.screen, "screen");
  if (options.deviceScaleFactor !== undefined && (!Number.isFinite(options.deviceScaleFactor) || options.deviceScaleFactor <= 0 || options.deviceScaleFactor > 8)) {
    throw new Error("deviceScaleFactor must be greater than 0 and at most 8");
  }
  if (options.viewport === null && (options.screen !== undefined || options.deviceScaleFactor !== undefined)) {
    throw new Error("screen and deviceScaleFactor require a fixed viewport");
  }
  if (options.userAgent !== undefined && (typeof options.userAgent !== "string" || !options.userAgent)) {
    throw new Error("userAgent must be a non-empty string");
  }
  if (options.locale !== undefined) {
    try {
      if (typeof options.locale !== "string" || !options.locale || Intl.getCanonicalLocales(options.locale).length !== 1) throw new Error();
    } catch { throw new Error("locale must be a valid language tag"); }
  }
  if (options.timezoneId !== undefined) {
    try {
      if (typeof options.timezoneId !== "string" || !options.timezoneId) throw new Error();
      new Intl.DateTimeFormat("en-US", { timeZone: options.timezoneId });
    } catch { throw new Error("timezoneId must be a valid timezone"); }
  }
  if (options.colorScheme !== undefined && ![null, "light", "dark", "no-preference"].includes(options.colorScheme)) {
    throw new Error("invalid colorScheme");
  }
  if (options.reducedMotion !== undefined && ![null, "reduce", "no-preference"].includes(options.reducedMotion)) {
    throw new Error("invalid reducedMotion");
  }
  return options;
}

function validateCdpOptions(value) {
  const options = optionObject(value, ["port", "endpoint", "userDataDir", "timeout"], "cdpOptions");
  if (options.port !== undefined && (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535)) {
    throw new Error("cdp port must be an integer from 0 to 65535");
  }
  if (options.endpoint !== undefined && (typeof options.endpoint !== "string" || !options.endpoint)) {
    throw new Error("cdp endpoint must be a non-empty string");
  }
  if (options.userDataDir !== undefined && (typeof options.userDataDir !== "string" || !options.userDataDir)) {
    throw new Error("cdp userDataDir must be a non-empty string");
  }
  if (options.timeout !== undefined && (!Number.isSafeInteger(options.timeout) || options.timeout <= 0 || options.timeout > 120000)) {
    throw new Error("cdp timeout must be from 1 to 120000 milliseconds");
  }
  return options;
}

export function validateBrowserConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      Object.keys(config).some((key) => !["channel", "profile", "automationCompatibility", "executionMode", "launchOptions", "contextOptions", "cdpOptions", "identityProfile", "humanize"].includes(key)) ||
      !["default", "chromium", "chrome", "msedge"].includes(config.channel)) {
    throw new Error("browser must specify channel: default, chromium, chrome, or msedge");
  }
  if (config.humanize !== undefined && typeof config.humanize !== "boolean") throw new Error("humanize must be boolean");
  if (config.automationCompatibility !== undefined && typeof config.automationCompatibility !== "boolean") {
    throw new Error("automationCompatibility must be boolean");
  }
  if (config.identityProfile !== undefined) {
    if (typeof config.identityProfile !== "boolean" && typeof config.identityProfile !== "string") {
      throw new Error("identityProfile must be boolean or a valid profile ID");
    }
    if (typeof config.identityProfile === "string" && config.identityProfile !== "random" && !BROWSER_PROFILES.some((p) => p.id === config.identityProfile)) {
      throw new Error(`invalid identityProfile: ${config.identityProfile}`);
    }
  }
  if (config.executionMode !== undefined && !["headless", "virtual-display", "external-cdp", "cdp"].includes(config.executionMode)) {
    throw new Error("executionMode must be headless, virtual-display, or external-cdp");
  }
  const mode = config.executionMode === "cdp" ? "external-cdp" : config.executionMode;
  if (mode === "external-cdp" && config.channel === "msedge") throw new Error("external-cdp does not support the msedge launcher");
  if (config.profile !== undefined && config.identityProfile) throw new Error("profile and identityProfile are mutually exclusive");
  const profile = config.profile !== undefined ? resolveBrowserProfile(config.profile)
    : typeof config.identityProfile === "string" && config.identityProfile !== "random" ? getBrowserProfile(config.identityProfile) : null;
  if (profile) {
    if (mode === "external-cdp") throw new Error("profiles require a new managed context, not external-cdp");
    if (profile.engine !== "chromium" && config.channel !== "default") throw new Error("non-Chromium profiles require channel: default");
    if (profile.channel === "msedge" && !["default", "msedge"].includes(config.channel)) throw new Error("Edge profiles require default or msedge channel");
    if (profile.channel !== "msedge" && config.channel === "msedge") throw new Error("msedge channel requires an Edge profile");
    if (profile.engine !== "chromium" && config.automationCompatibility) throw new Error("automationCompatibility is Chromium-only");
    if (Object.keys(config.contextOptions ?? {}).some(key => key in profile.contextOptions)) throw new Error("profile display settings cannot be overridden; select a different profile");
  }
  if (config.identityProfile && mode === "external-cdp") throw new Error("identity profiles are not supported with external-cdp");
  return {
    channel: config.channel,
    ...(config.automationCompatibility !== undefined ? { automationCompatibility: config.automationCompatibility } : {}),
    ...(config.humanize !== undefined ? { humanize: config.humanize } : {}),
    ...(config.profile !== undefined ? { profile: profile.id } : {}),
    ...(config.identityProfile !== undefined ? { identityProfile: config.identityProfile } : {}),
    ...(mode === "virtual-display" || mode === "external-cdp" ? { executionMode: mode } : {}),
    ...(config.launchOptions !== undefined ? { launchOptions: validateLaunchOptions(config.launchOptions) } : {}),
    ...(config.contextOptions !== undefined ? { contextOptions: validateContextOptions(config.contextOptions) } : {}),
    ...(config.cdpOptions !== undefined ? { cdpOptions: validateCdpOptions(config.cdpOptions) } : {}),
  };
}

export function browserConfigFromEnv(env = process.env) {
  if (env.PROMETHEUS_CONFIG_DIR) {
    const file = path.join(env.PROMETHEUS_CONFIG_DIR, "prometheus-browser.json");
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular file");
      return validateBrowserConfig(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error("invalid browser settings file");
    }
  }
  const compatibility = env.PROMETHEUS_BROWSER_AUTOMATION_COMPATIBILITY;
  if (compatibility !== undefined && !["true", "false"].includes(compatibility)) throw new Error("invalid browser automation compatibility setting");
  const rawIdentity = env.PROMETHEUS_BROWSER_IDENTITY_PROFILE;
  const identityProfile = rawIdentity === "true" || rawIdentity === "1" ? true
    : rawIdentity === "false" || rawIdentity === "0" ? false : rawIdentity;
  const cdpPort = env.PROMETHEUS_BROWSER_CDP_PORT ? Number(env.PROMETHEUS_BROWSER_CDP_PORT) : undefined;
  const cdpEndpoint = env.PROMETHEUS_BROWSER_CDP_ENDPOINT || undefined;
  const cdpUserDataDir = env.PROMETHEUS_BROWSER_CDP_USER_DATA_DIR || undefined;
  const cdpOptions = cdpPort !== undefined || cdpEndpoint !== undefined || cdpUserDataDir !== undefined ? {
    ...(cdpPort !== undefined ? { port: cdpPort } : {}),
    ...(cdpEndpoint !== undefined ? { endpoint: cdpEndpoint } : {}),
    ...(cdpUserDataDir !== undefined ? { userDataDir: cdpUserDataDir } : {}),
  } : undefined;
  let humanize;
  if (env.PROMETHEUS_BROWSER_HUMANIZE !== undefined) {
    const raw = env.PROMETHEUS_BROWSER_HUMANIZE.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(raw)) humanize = true;
    else if (["false", "0", "no", "off"].includes(raw)) humanize = false;
    else throw new Error("invalid browser humanize setting");
  }
  return validateBrowserConfig({
    channel: env.PROMETHEUS_BROWSER_CHANNEL || "default",
    ...(compatibility !== undefined ? { automationCompatibility: compatibility === "true" } : {}),
    ...(env.PROMETHEUS_BROWSER_PROFILE ? { profile: env.PROMETHEUS_BROWSER_PROFILE } : {}),
    ...(identityProfile !== undefined ? { identityProfile } : {}),
    ...(humanize !== undefined ? { humanize } : {}),
    executionMode: env.PROMETHEUS_BROWSER_EXECUTION_MODE,
    ...(cdpOptions ? { cdpOptions } : {}),
  });
}

export function browserLaunchOptions(config, headless) {
  const selected = validateBrowserConfig(config);
  const { automationCompatibility, executionMode, launchOptions } = selected;
  const channel = configuredProfile(selected)?.channel === "msedge" ? "msedge" : selected.channel;
  return {
    ...launchOptions,
    headless: headless ?? executionMode !== "virtual-display",
    ...(channel === "default" ? {} : { channel }),
    ...(automationCompatibility ? {
      ignoreDefaultArgs: ["--enable-automation"],
      args: ["--disable-blink-features=AutomationControlled"],
    } : {}),
  };
}

export function browserContextOptions(config) {
  const selected = validateBrowserConfig(config);
  const profile = configuredProfile(selected);
  return {
    viewport: { width: 1280, height: 1024 },
    ...(profile ? structuredClone(profile.contextOptions) : {}),
    ...selected.contextOptions,
  };
}

function configuredProfile(selected) {
  if (selected.profile) return getBrowserProfile(selected.profile);
  return typeof selected.identityProfile === "string" && selected.identityProfile !== "random"
    ? getBrowserProfile(selected.identityProfile) : null;
}

export async function selectBrowserType(chromium, config, engines) {
  const selected = validateBrowserConfig(config);
  const engine = configuredProfile(selected)?.engine ?? "chromium";
  if (engine === "chromium") return chromium;
  const available = engines ?? await import("playwright");
  if (!available[engine]) throw new Error(`browser engine unavailable: ${engine}`);
  return available[engine];
}

export async function collectBrowserProfileEvidence(page) {
  return page.evaluate(async () => {
    const graphics = type => {
      try {
        const gl = document.createElement("canvas").getContext(type);
        const ext = gl?.getExtension("WEBGL_debug_renderer_info");
        return ext ? { vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL), renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) } : null;
      } catch { return null; }
    };
    return {
      userAgent: navigator.userAgent, platform: navigator.platform,
      clientHints: navigator.userAgentData?.toJSON?.() ?? null,
      viewport: { width: innerWidth, height: innerHeight }, screen: { width: screen.width, height: screen.height },
      deviceScaleFactor: devicePixelRatio, maxTouchPoints: navigator.maxTouchPoints,
      webgl: graphics("webgl"), webgl2: graphics("webgl2"),
    };
  });
}

export function browserRuntimeInfo(config) {
  const selected = validateBrowserConfig(config);
  const profile = configuredProfile(selected);
  let playwrightVersion = null;
  try { playwrightVersion = require("playwright/package.json").version; } catch {}
  return {
    playwrightVersion,
    nodeVersion: process.versions.node,
    platform: process.platform,
    architecture: process.arch,
    ...(profile ? { profile: browserProfileInfo(profile.id) } : {}),
    configuredDistribution: profile && profile.engine !== "chromium" ? profile.engine
      : selected.channel === "msedge" || profile?.channel === "msedge" ? "installed-edge"
      : selected.executionMode === "external-cdp" ? "external-chrome-cdp"
      : selected.channel === "chrome" ? "installed-chrome"
      : selected.channel === "chromium" || selected.executionMode === "virtual-display" ? "chromium" : "chromium-headless-shell",
    contextOptions: browserContextOptions(selected),
    ...(selected.executionMode ? { executionMode: selected.executionMode } : {}),
  };
}

export function resolveChromeExecutablePath(chromium, channel) {
  if (channel === "chrome") {
    const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (process.platform === "darwin" && fs.existsSync(macChrome)) return macChrome;
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
      try {
        const full = execSync(`which ${name} 2>/dev/null`, { encoding: "utf8" }).trim();
        if (full && fs.existsSync(full)) return full;
      } catch {}
    }
  }
  if (typeof chromium?.executablePath === "function") {
    try { return chromium.executablePath({ channel: channel === "default" ? undefined : channel }); }
    catch { return chromium.executablePath(); }
  }
  throw new Error("unable to locate browser executable");
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on("error", reject);
  });
}

async function waitForCdp(endpoint, timeoutMs = 15000) {
  const start = Date.now();
  const versionUrl = new URL("/json/version", endpoint).href;
  while (Date.now() - start < timeoutMs) {
    try { if ((await fetch(versionUrl)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for remote debugging on ${endpoint}`);
}

export async function applyAutomationCompatibility(context) {
  if (typeof context?.addInitScript !== "function") return;
  await context.addInitScript(() => {
    try {
      if (/HeadlessChrome/.test(navigator.userAgent)) {
        const cleanUa = navigator.userAgent.replace(/HeadlessChrome/, "Chrome");
        Object.defineProperty(Object.getPrototypeOf(navigator), "userAgent", { get: () => cleanUa, configurable: true });
      }
    } catch {}
  });
}

export async function applyBrowserProfile(context, profile) {
  if (profile?.validation !== "unverified-legacy-preset" || typeof context?.addInitScript !== "function") return;
  await context.addInitScript((prof) => {
    const defineNav = (prop, value) => {
      for (const target of [Object.getPrototypeOf(navigator), navigator]) {
        try { Object.defineProperty(target, prop, { get: () => value, configurable: true }); return; } catch {}
      }
    };
    defineNav("platform", prof.platform);
    if (navigator.userAgentData) {
      const base = { brands: prof.brands, mobile: false, platform: prof.os };
      defineNav("userAgentData", {
        ...base,
        getHighEntropyValues: async (hints = []) => ({
          ...base,
          ...(hints.includes("platformVersion") ? { platformVersion: prof.os === "Windows" ? "15.0.0" : "14.4.1" } : {}),
          ...(hints.includes("architecture") ? { architecture: "x86" } : {}),
          ...(hints.includes("bitness") ? { bitness: "64" } : {}),
          ...(hints.includes("model") ? { model: "" } : {}),
        }),
        toJSON: () => base,
      });
    }
    const overrideGl = (proto) => {
      if (!proto?.getParameter) return;
      const orig = proto.getParameter;
      proto.getParameter = function (p) { return p === 37445 ? prof.glVendor : p === 37446 ? prof.glRenderer : orig.apply(this, arguments); };
      if (proto.getExtension) {
        const origExt = proto.getExtension;
        proto.getExtension = function (name) {
          const ext = origExt.apply(this, arguments);
          return name === "WEBGL_debug_renderer_info" ? ext || { UNMASKED_VENDOR_WEBGL: 37445, UNMASKED_RENDERER_WEBGL: 37446 } : ext;
        };
      }
    };
    try { if (typeof WebGLRenderingContext !== "undefined") overrideGl(WebGLRenderingContext.prototype); } catch {}
    try { if (typeof WebGL2RenderingContext !== "undefined") overrideGl(WebGL2RenderingContext.prototype); } catch {}
  }, profile);
}

export function resolveIdentityProfile(selected) {
  if (!selected.identityProfile) return null;
  if (typeof selected.identityProfile === "string" && selected.identityProfile !== "random") return getBrowserProfile(selected.identityProfile);
  const candidates = BROWSER_PROFILES.filter(p => p.validation === "unverified-legacy-preset");
  return candidates[Math.floor(Math.random() * candidates.length)];
}

export function nativeChromiumUserAgent(browserVersion, platform = process.platform, channel = "default") {
  const osToken = platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7" : "X11; Linux x86_64";
  const major = String(browserVersion || "").match(/^\d+/)?.[0] || "157";
  const suffix = channel === "msedge" ? ` Edg/${major}.0.0.0` : "";
  return `Mozilla/5.0 (${osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36${suffix}`;
}

async function prepareContext(context, selected, profile) {
  if (selected?.automationCompatibility) await applyAutomationCompatibility(context);
  if (profile) await applyBrowserProfile(context, profile);
}

export async function launchExternalCdpContext(chromium, selected, options = {}) {
  if (selected.automationCompatibility === undefined) selected = { ...selected, automationCompatibility: true };
  const cdp = selected.cdpOptions || {};
  let endpoint = cdp.endpoint;
  let child = null;
  let tempUserDataDir = null;
  const cleanupProcess = () => {
    if (child && !child.killed) { try { child.kill("SIGTERM"); } catch {} }
    if (tempUserDataDir) { try { fs.rmSync(tempUserDataDir, { recursive: true, force: true }); } catch {} }
  };

  if (!endpoint) {
    const port = cdp.port ?? (await getFreePort());
    endpoint = `http://127.0.0.1:${port}`;
    const userDataDir = cdp.userDataDir || (tempUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prometheus-cdp-")));
    const execPath = resolveChromeExecutablePath(chromium, selected.channel);
    const headless = options.headless ?? selected.launchOptions?.headless ?? (selected.executionMode !== "virtual-display");
    const ua = selected.contextOptions?.userAgent;
    child = spawn(execPath, [
      ...(headless ? ["--headless=new"] : []),
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      ...(selected.automationCompatibility ? ["--disable-blink-features=AutomationControlled"] : []),
      ...(ua ? [`--user-agent=${ua}`] : []),
      "about:blank",
    ], { stdio: "ignore" });
    try { await waitForCdp(endpoint, cdp.timeout ?? 15000); }
    catch (err) { cleanupProcess(); throw err; }
  }

  let browser;
  try { browser = await chromium.connectOverCDP(endpoint, { timeout: cdp.timeout ?? 15000 }); }
  catch (err) { cleanupProcess(); throw err; }

  const origClose = browser.close.bind(browser);
  browser.close = async () => {
    try { await origClose().catch(() => {}); }
    finally { cleanupProcess(); }
  };

  try {
    const profile = resolveIdentityProfile(selected);
    const contextOptions = browserContextOptions(selected);
    if (profile?.userAgent && !contextOptions.userAgent) contextOptions.userAgent = profile.userAgent;
    const existing = browser.contexts ? browser.contexts() : [];
    const context = existing.length > 0 ? existing[0] : await browser.newContext(contextOptions);
    await prepareContext(context, selected, profile);
    return { browser, context };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

export async function createTaskContext(chromium, config, engines) {
  let selected = validateBrowserConfig(config);
  if (selected.identityProfile === true || selected.identityProfile === "random") {
    selected = validateBrowserConfig({ ...selected, identityProfile: resolveIdentityProfile(selected).id });
  }
  if (selected.automationCompatibility === undefined && (configuredProfile(selected)?.engine ?? "chromium") === "chromium") {
    selected = { ...selected, automationCompatibility: true };
  }
  if (selected.executionMode === "virtual-display" && (!process.env.DISPLAY || process.env.PROMETHEUS_VIRTUAL_DISPLAY !== "1")) {
    throw new Error("virtual-display mode requires the managed Xvfb service launcher");
  }
  if (selected.executionMode === "external-cdp") return launchExternalCdpContext(chromium, selected);

  const profile = resolveIdentityProfile(selected);
  const contextOptions = browserContextOptions(selected);
  if (profile?.userAgent && !contextOptions.userAgent) contextOptions.userAgent = profile.userAgent;
  const browserType = await selectBrowserType(chromium, selected, engines);
  const browser = await browserType.launch(browserLaunchOptions(selected));
  try {
    const browserVersion = browser.version?.() ?? null;
    if (selected.automationCompatibility && !contextOptions.userAgent) {
      contextOptions.userAgent = nativeChromiumUserAgent(browserVersion, process.platform, selected.channel);
    }
    const context = await browser.newContext(contextOptions);
    await prepareContext(context, selected, profile);
    const runtime = configuredProfile(selected) || selected.automationCompatibility
      ? { ...browserRuntimeInfo(selected), contextOptions: structuredClone(contextOptions), browserVersion }
      : undefined;
    return { browser, context, ...(runtime ? { runtime } : {}) };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

export async function hydrateBrowserState(context, loaded) {
  const cookies = loaded.storageState?.cookies || [];
  const localStores = loaded.storageState?.origins || [];
  const sessionStores = loaded.sessionStorage || {};
  if (cookies.length) await context.addCookies(cookies);
  if (localStores.length || Object.keys(sessionStores).length) {
    await context.addInitScript(({ localStores, sessionStores }) => {
      const here = location.origin;
      const marker = `__prometheus_hydrated__:${here}`;
      if (window.name.includes(marker)) return;
      for (const entry of localStores) {
        if (entry.origin === here) for (const item of entry.localStorage || []) localStorage.setItem(item.name, item.value);
      }
      for (const [key, value] of Object.entries(sessionStores[here] || {})) sessionStorage.setItem(key, value);
      window.name += marker;
    }, { localStores, sessionStores });
  }
  return Boolean(cookies.length || localStores.length || Object.keys(sessionStores).length);
}
