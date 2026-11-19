import fs from "node:fs";
import http from "node:http";
import {
  acquireTaskSession,
  BrowserSessionError,
  sanitizePoolProxyError,
  validateProxyConfig,
  verifySessionGeneration,
  verifyTaskSessionOwner,
} from "./opencode-browser-sessions.mjs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn, execSync } from "node:child_process";
import { createRequire } from "node:module";
import { BROWSER_PROFILES, getBrowserProfile, resolveBrowserProfile, browserProfileInfo } from "./browser-profiles.mjs";
import { validateCaptchaConfig } from "./opencode-browser-2captcha.mjs";

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
  if (options.userAgent !== undefined) {
    if (typeof options.userAgent !== "string" || !options.userAgent) {
      throw new Error("userAgent must be a non-empty string");
    }
    if (/HeadlessChrome/i.test(options.userAgent)) {
      throw new Error("userAgent must not contain HeadlessChrome");
    }
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
      Object.keys(config).some((key) => !["channel", "profile", "automationCompatibility", "executionMode", "launchOptions", "contextOptions", "cdpOptions", "identityProfile", "humanize", "proxy", "captcha"].includes(key)) ||
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
  if (config.executionMode !== undefined && !["headless", "headed", "virtual-display", "external-cdp", "cdp"].includes(config.executionMode)) {
    throw new Error("executionMode must be headless, headed, virtual-display, or external-cdp");
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
  const launchOptions = config.launchOptions !== undefined ? validateLaunchOptions(config.launchOptions) : undefined;
  let proxy;
  if (config.proxy !== undefined) {
    if (mode === "external-cdp") throw new Error("proxy is not supported with external-cdp");
    if (profile && profile.engine !== "chromium") {
      throw new Error("proxy is only supported with chromium-engine browsers");
    }
    if (
      Array.isArray(launchOptions?.args) &&
      launchOptions.args.some((arg) => /^--(proxy-server|proxy-bypass-list|proxy-pac-url|no-proxy-server)(=|$)/i.test(String(arg)))
    ) {
      throw new Error("proxy cannot be combined with proxy launchOptions.args flags");
    }
    // Static validation never opens proxies.txt. File-backed endpoints and
    // credentials are resolved privately when acquiring a session.
    proxy = validateProxyConfig(config.proxy);
  }
  return {
    channel: config.channel,
    ...(config.automationCompatibility !== undefined ? { automationCompatibility: config.automationCompatibility } : {}),
    ...(config.humanize !== undefined ? { humanize: config.humanize } : {}),
    ...(config.profile !== undefined ? { profile: profile.id } : {}),
    ...(config.identityProfile !== undefined ? { identityProfile: config.identityProfile } : {}),
    ...(mode === "headed" || mode === "virtual-display" || mode === "external-cdp" ? { executionMode: mode } : {}),
    ...(launchOptions !== undefined ? { launchOptions } : {}),
    ...(config.contextOptions !== undefined ? { contextOptions: validateContextOptions(config.contextOptions) } : {}),
    ...(config.cdpOptions !== undefined ? { cdpOptions: validateCdpOptions(config.cdpOptions) } : {}),
    ...(proxy !== undefined ? { proxy } : {}),
    ...(config.captcha !== undefined ? { captcha: validateCaptchaConfig(config.captcha) } : {}),
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
    headless: headless ?? !["headed", "virtual-display"].includes(executionMode),
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
    const identity = nav => ({ userAgent: nav.userAgent, platform: nav.platform,
      language: nav.language, languages: [...nav.languages], hardwareConcurrency: nav.hardwareConcurrency,
      clientHints: nav.userAgentData?.toJSON?.() ?? null });
    let worker = null;
    try {
      const blob = new Blob([`onmessage = () => postMessage({userAgent:navigator.userAgent,platform:navigator.platform,language:navigator.language,languages:[...navigator.languages],hardwareConcurrency:navigator.hardwareConcurrency,clientHints:navigator.userAgentData?.toJSON?.() ?? null})`], { type: "text/javascript" });
      const url = URL.createObjectURL(blob);
      try {
        worker = await new Promise(resolve => {
          const w = new Worker(url);
          const timer = setTimeout(() => { w.terminate(); resolve(null); }, 1000);
          w.onmessage = event => { clearTimeout(timer); w.terminate(); resolve(event.data); };
          w.onerror = () => { clearTimeout(timer); w.terminate(); resolve(null); };
          w.postMessage(null);
        });
      } finally { URL.revokeObjectURL(url); }
    } catch { /* Worker may be restricted by the document. */ }
    let iframe = null;
    try {
      const el = document.createElement("iframe");
      el.hidden = true;
      document.body.append(el);
      iframe = identity(el.contentWindow.navigator);
      el.remove();
    } catch { /* A document may prohibit frame creation. */ }
    let notificationQuery = null;
    try { notificationQuery = (await navigator.permissions.query({ name: "notifications" })).state; } catch {}
    return {
      userAgent: navigator.userAgent, platform: navigator.platform,
      clientHints: navigator.userAgentData?.toJSON?.() ?? null,
      viewport: { width: innerWidth, height: innerHeight }, screen: { width: screen.width, height: screen.height },
      deviceScaleFactor: devicePixelRatio, maxTouchPoints: navigator.maxTouchPoints,
      webgl: graphics("webgl"), webgl2: graphics("webgl2"),
      document: identity(navigator), worker, iframe,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      plugins: Array.from(navigator.plugins, p => p.name),
      pdfViewerEnabled: navigator.pdfViewerEnabled,
      notification: { permission: typeof Notification === "undefined" ? null : Notification.permission, query: notificationQuery },
      window: { innerWidth, innerHeight, outerWidth, outerHeight },
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
      : selected.channel === "chromium" || ["headed", "virtual-display"].includes(selected.executionMode) ? "chromium" : "chromium-headless-shell",
    contextOptions: browserContextOptions(selected),
    ...(selected.executionMode ? { executionMode: selected.executionMode } : {}),
    ...(selected.proxy ? { proxy: { enabled: true, session: selected.proxy.session, routing: "configured" } } : {}),
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

const BUNDLED_BROWSERS = ["chromium-headless-shell", "chromium"];

// Login is headed, so it needs full Chromium even when tasks use the headless shell.
function bundledBrowsersFor(config, role) {
  const selected = validateBrowserConfig(config);
  const profile = configuredProfile(selected);
  if ((profile && profile.engine !== "chromium") || ["chrome", "msedge"].includes(selected.channel) || profile?.channel === "msedge") return [];
  if (selected.executionMode === "external-cdp") return selected.cdpOptions?.endpoint ? [] : ["chromium"];
  if (role === "login") return ["chromium"];
  const distribution = browserRuntimeInfo(selected).configuredDistribution;
  return BUNDLED_BROWSERS.includes(distribution) ? [distribution] : [];
}

function playwrightBrowsersRoot(chromium) {
  for (let dir = chromium.executablePath(); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (/^chromium-\d+$/.test(path.basename(dir))) return path.dirname(dir);
  }
  return null;
}

// Read the pinned revisions and install markers. Do not launch a browser.
export function bundledBrowserInstall(chromium, config, roles = ["task", "login"]) {
  if (typeof chromium?.executablePath !== "function") return null;
  const names = [...new Set(roles.flatMap(role => bundledBrowsersFor(config, role)))];
  if (!names.length) return null;
  const core = path.dirname(require.resolve("playwright-core/package.json"));
  const revisions = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(core, "browsers.json"), "utf8")).browsers.map(b => [b.name, b.revision]));
  const root = playwrightBrowsersRoot(chromium);
  const browsers = names.map(name => {
    const directory = root && revisions[name] ? path.join(root, `${name.replace(/-/g, "_")}-${revisions[name]}`) : null;
    return { name, revision: revisions[name] ?? null, directory, installed: Boolean(directory) && fs.existsSync(path.join(directory, "INSTALLATION_COMPLETE")) };
  });
  const cli = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
  const installCommand = [process.execPath, cli, "install", ...names].map(arg => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(" ");
  return { installed: browsers.every(b => b.installed), browsers, installCommand };
}

export function assertBundledBrowserInstalled(chromium, config, role) {
  const install = bundledBrowserInstall(chromium, config, [role]);
  if (!install || install.installed) return;
  const missing = install.browsers.filter(b => !b.installed).map(b => `${b.name} ${b.revision}`).join(", ");
  throw new Error(`Playwright browser not installed: ${missing}. Run: ${install.installCommand}`);
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

async function waitForCdp(endpoint, timeoutMs = 15000, child = null) {
  const start = Date.now();
  const versionUrl = new URL("/json/version", endpoint).href;
  let childError = null;
  if (child) child.on("error", (err) => { childError = err; });
  while (Date.now() - start < timeoutMs) {
    if (childError) throw childError;
    if (child && child.exitCode !== null) {
      throw new Error(`browser process exited prematurely with code ${child.exitCode}`);
    }
    try { if ((await fetch(versionUrl)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for remote debugging on ${endpoint}`);
}

export async function applyAutomationCompatibility(context) {
  if (typeof context?.addInitScript !== "function") return;
  await context.addInitScript(() => {
    try {
      if (/HeadlessChrome/i.test(navigator.userAgent)) {
        const cleanUa = navigator.userAgent.replace(/HeadlessChrome/gi, "Chrome");
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
  if ((configuredProfile(selected)?.engine ?? "chromium") === "chromium") {
    await applyAutomationCompatibility(context);
  }
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
    assertBundledBrowserInstalled(chromium, selected, "task");
    const port = cdp.port ?? (await getFreePort());
    endpoint = `http://127.0.0.1:${port}`;
    const userDataDir = cdp.userDataDir || (tempUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prometheus-cdp-")));
    const execPath = resolveChromeExecutablePath(chromium, selected.channel);
    const headless = options.headless ?? selected.launchOptions?.headless ?? (selected.executionMode !== "virtual-display");
    const ua = selected.contextOptions?.userAgent || (headless ? nativeChromiumUserAgent(null, process.platform, selected.channel) : null);
    const noSandbox = selected.launchOptions?.chromiumSandbox !== true;
    child = spawn(execPath, [
      ...(headless ? ["--headless=new"] : []),
      ...(noSandbox ? ["--no-sandbox"] : []),
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      ...(selected.automationCompatibility ? ["--disable-blink-features=AutomationControlled"] : []),
      ...(ua ? [`--user-agent=${ua}`] : []),
      "about:blank",
    ], { stdio: "ignore" });
    try { await waitForCdp(endpoint, cdp.timeout ?? 15000, child); }
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
    if (!contextOptions.userAgent) {
      contextOptions.userAgent = nativeChromiumUserAgent(browser.version?.() ?? null, process.platform, selected.channel);
    }
    const existing = browser.contexts ? browser.contexts() : [];
    const context = existing.length > 0 ? existing[0] : await browser.newContext(contextOptions);
    await prepareContext(context, selected, profile);
    return { browser, context };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

export async function createLocalProxyRelay({ server: upstreamServer, credentials = null }) {
  const upstreamUrl = new URL(upstreamServer);
  const upstreamHost = upstreamUrl.hostname.replace(/^\[(.*)\]$/, "$1");
  const upstreamPort = Number(upstreamUrl.port || 80);
  const authHeader = credentials
    ? `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`, "utf8").toString("base64")}`
    : null;

  let lastFailure = null;
  let closed = false;
  const activeSockets = new Set();

  const trackSocket = (socket) => {
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));
    socket.on("error", () => {});
  };

  const relayServer = http.createServer((req, res) => {
    trackSocket(req.socket);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lower = k.toLowerCase();
      if (lower === "proxy-connection" || lower === "proxy-authorization" || lower === "connection") continue;
      headers[k] = v;
    }
    if (authHeader) {
      headers["proxy-authorization"] = authHeader;
    }
    headers["connection"] = "close";

    let responded = false;
    const upReq = http.request(
      {
        host: upstreamHost,
        port: upstreamPort,
        method: req.method,
        path: req.url,
        headers,
        agent: false,
      },
      (upRes) => {
        responded = true;
        const status = upRes.statusCode || 502;
        if (status === 407) {
          lastFailure = {
            kind: "proxy_auth",
            status: 407,
            phase: "http",
            message: "proxy authentication failed (HTTP 407)",
          };
        }
        const resHeaders = {};
        for (const [k, v] of Object.entries(upRes.headers)) {
          const lower = k.toLowerCase();
          if (status === 407 && (lower === "proxy-authenticate" || lower === "proxy-authentication-info")) {
            continue;
          }
          resHeaders[k] = v;
        }
        res.writeHead(status, upRes.statusMessage, resHeaders);
        upRes.pipe(res);
      }
    );

    upReq.on("socket", (sock) => trackSocket(sock));
    upReq.on("error", (err) => {
      if (!responded) {
        lastFailure = {
          kind: "proxy_connection",
          code: err?.code || "PROXY_CONNECTION_FAILED",
          phase: "http",
          message: "proxy connection failed",
        };
      }
      if (!res.headersSent) {
        if (!req.socket.destroyed) req.socket.destroy();
      } else if (!res.destroyed) {
        res.destroy();
      }
    });

    req.on("aborted", () => upReq.destroy());
    req.pipe(upReq);
  });

  relayServer.on("connect", (req, clientSocket, head) => {
    trackSocket(clientSocket);
    const target = req.url;
    if (!target || /[\r\n]/.test(target)) {
      if (!clientSocket.destroyed) clientSocket.destroy();
      return;
    }

    const upSocket = net.connect({ host: upstreamHost, port: upstreamPort });
    trackSocket(upSocket);
    let tunnelEstablished = false;
    let headerBuf = Buffer.alloc(0);

    const failConnect = (failure) => {
      if (failure && !lastFailure) lastFailure = failure;
      if (!upSocket.destroyed) upSocket.destroy();
      if (!clientSocket.destroyed) clientSocket.destroy();
    };

    upSocket.on("connect", () => {
      const lines = [
        `CONNECT ${target} HTTP/1.1`,
        `Host: ${target}`,
        "Proxy-Connection: keep-alive",
      ];
      if (authHeader) lines.push(`Proxy-Authorization: ${authHeader}`);
      upSocket.write(lines.join("\r\n") + "\r\n\r\n");
    });

    const onUpData = (chunk) => {
      if (tunnelEstablished) return;
      headerBuf = Buffer.concat([headerBuf, chunk]);
      if (headerBuf.length > 32 * 1024) {
        failConnect({
          kind: "proxy_connection",
          code: "HEADER_OVERFLOW",
          phase: "connect",
          message: "proxy CONNECT response too large",
        });
        return;
      }
      const hdrEnd = headerBuf.indexOf("\r\n\r\n");
      if (hdrEnd === -1) return;

      upSocket.off("data", onUpData);
      const headText = headerBuf.subarray(0, hdrEnd).toString("latin1");
      const statusMatch = headText.match(/^HTTP\/\d+\.\d+\s+(\d{3})/);
      const status = statusMatch ? Number(statusMatch[1]) : 502;

      if (status === 200) {
        tunnelEstablished = true;
        if (!clientSocket.destroyed) {
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          const remainder = headerBuf.subarray(hdrEnd + 4);
          if (remainder.length > 0) clientSocket.write(remainder);
          if (head && head.length > 0) upSocket.write(head);
          clientSocket.pipe(upSocket);
          upSocket.pipe(clientSocket);
        }
        clientSocket.once("close", () => {
          if (!upSocket.destroyed) upSocket.destroy();
        });
        upSocket.once("close", () => {
          if (!clientSocket.destroyed) clientSocket.destroy();
        });
        return;
      }

      if (status === 407) {
        lastFailure = {
          kind: "proxy_auth",
          status: 407,
          phase: "connect",
          message: "proxy authentication failed (HTTP 407)",
        };
        if (!clientSocket.destroyed) {
          clientSocket.end("HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        }
        if (!upSocket.destroyed) upSocket.destroy();
        return;
      }

      if (!clientSocket.destroyed) {
        clientSocket.end(`HTTP/1.1 ${status} Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      }
      if (!upSocket.destroyed) upSocket.destroy();
    };

    upSocket.on("data", onUpData);
    upSocket.on("error", (err) => {
      if (!tunnelEstablished) {
        failConnect({
          kind: "proxy_connection",
          code: err?.code || "PROXY_CONNECTION_FAILED",
          phase: "connect",
          message: "proxy connection failed",
        });
      }
    });
    upSocket.on("end", () => {
      if (!tunnelEstablished) {
        failConnect({
          kind: "proxy_connection",
          code: "PROXY_EOF",
          phase: "connect",
          message: "proxy closed connection during CONNECT",
        });
      }
    });
    clientSocket.once("close", () => {
      if (!tunnelEstablished && !upSocket.destroyed) upSocket.destroy();
    });
  });

  await new Promise((resolve, reject) => {
    const onErr = (err) => reject(err);
    relayServer.once("error", onErr);
    relayServer.listen(0, "127.0.0.1", () => {
      relayServer.off("error", onErr);
      resolve();
    });
  });
  relayServer.unref();

  const addr = relayServer.address();
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    getLastFailure: () => lastFailure,
    clearLastFailure: () => {
      lastFailure = null;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const sock of activeSockets) {
        try {
          sock.destroy();
        } catch {}
      }
      activeSockets.clear();
      await new Promise((resolve) => relayServer.close(() => resolve()));
    },
  };
}

export async function createTaskContext(chromium, config, engines, options = {}) {
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

  const configDir = options?.configDir || process.env.PROMETHEUS_CONFIG_DIR;
  let proxySession = null;
  let proxyRelay = null;
  if (selected.proxy) {
    if (!configDir) {
      throw new BrowserSessionError("PROMETHEUS_CONFIG_DIR is required for proxy sessions");
    }
    proxySession = await acquireTaskSession(configDir, selected);
    try {
      proxyRelay = await createLocalProxyRelay({
        server: proxySession.server,
        credentials: proxySession.credentials,
      });
      verifySessionGeneration(configDir, selected, proxySession.generation);
    } catch (error) {
      await proxyRelay?.close().catch(() => {});
      proxySession.release();
      throw new Error(sanitizePoolProxyError(error, selected, proxySession.credentials));
    }
  }

  let browser = null;
  try {
    const browserType = await selectBrowserType(chromium, selected, engines);
    if (browserType === chromium) assertBundledBrowserInstalled(chromium, selected, "task");
    const launchOptions = browserLaunchOptions(selected);
    if (proxyRelay) {
      launchOptions.proxy = { server: proxyRelay.url };
      verifySessionGeneration(configDir, selected, proxySession.generation);
    }
    browser = await browserType.launch(launchOptions);
    const browserVersion = browser.version?.() ?? null;
    if ((configuredProfile(selected)?.engine ?? "chromium") === "chromium" && !contextOptions.userAgent) {
      contextOptions.userAgent = nativeChromiumUserAgent(browserVersion, process.platform, selected.channel);
    }
    const context = await browser.newContext(contextOptions);
    await prepareContext(context, selected, profile);

    if (proxySession && proxyRelay) {
      const originalClose = browser.close.bind(browser);
      let cleanedUp = false;
      const cleanupProxy = async () => {
        if (cleanedUp) return;
        cleanedUp = true;
        try {
          await proxyRelay.close().catch(() => {});
        } finally {
          proxySession.release();
        }
      };
      browser.close = async () => {
        try {
          await originalClose();
        } finally {
          await cleanupProxy();
        }
      };
    }

    const runtime = configuredProfile(selected) || selected.automationCompatibility || selected.proxy
      ? { ...browserRuntimeInfo(selected), contextOptions: structuredClone(contextOptions), browserVersion }
      : undefined;
    return {
      browser,
      context,
      ...(runtime ? { runtime } : {}),
      ...(proxySession && proxyRelay
        ? {
            proxySession: {
              session: proxySession.session,
              generation: proxySession.generation,
              proxyId: proxySession.proxyId,
              authRecords: proxySession.authRecords,
              ownerId: proxySession.ownerId,
            },
             proxyRelay,
             // Internal capability, not diagnostics. Never expose this return
             // value to page JavaScript, MCP responses or logs.
             getCaptchaProxy() {
               if (!browser.isConnected()) throw new Error("proxy task is closed");
               verifyTaskSessionOwner(configDir, selected, proxySession.generation, proxySession.ownerId);
               return {
                 server: proxySession.server,
                 credentials: proxySession.credentials ? { ...proxySession.credentials } : null,
               };
             },
          }
        : {}),
    };
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    if (proxyRelay) await proxyRelay.close().catch(() => {});
    if (proxySession) proxySession.release();
    if (selected.proxy) {
      throw new Error(sanitizePoolProxyError(error, selected, proxySession?.credentials));
    }
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
