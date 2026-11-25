#!/usr/bin/env node
// Headed login helper. Saves approved origin state via opencode-browser-state.mjs
// only after explicit user completion. Never prints state values or polls for login.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import net from "node:net";
import {
  assertValidName,
  assertSafeSessionsDir,
  hostMatchesCookieDomain,
  saveState,
  statMetadata,
  readHealthContext,
  listStates,
  removeState,
} from "./opencode-browser-state.mjs";
import {
  captureLoginSnapshot,
  buildHealthContext,
} from "./opencode-browser-health.mjs";
import {
  browserLaunchOptions,
  browserContextOptions,
  browserConfigFromEnv,
  applyAutomationCompatibility,
  applyBrowserProfile,
  createLocalProxyRelay,
  resolveIdentityProfile,
  selectBrowserType,
  validateBrowserConfig,
  launchExternalCdpContext,
  assertBundledBrowserInstalled,
} from "./opencode-browser-runtime.mjs";
import {
  bindAuthRecord,
  BrowserSessionError,
  issueLoginHandoff,
  joinLoginHelper,
  sanitizePoolProxyError,
  verifySessionGeneration,
} from "./opencode-browser-sessions.mjs";

const OPERATION_TIMEOUT_MS = 30_000;

class LoginError extends Error {}

function parseArgs(argv) {
  const out = { _: [], origin: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    const value = next === undefined || next.startsWith("--") ? true : (i++, next);
    if (key === "origin") {
      if (value === true) throw new LoginError("--origin requires a value");
      out.origin.push(value);
    } else out[key] = value;
  }
  return out;
}

function requireConfigDir(args) {
  const dir = args["config-dir"] || process.env.OPENCODE_DEPLOY_CONFIG_DIR;
  if (!dir || dir === true) throw new LoginError("--config-dir is required");
  return dir;
}

export function validateStartArgs(args) {
  const configDir = requireConfigDir(args);
  if (!args.name || args.name === true) throw new LoginError("--name is required");
  try { assertValidName(args.name); }
  catch (err) { throw new LoginError(err instanceof Error ? err.message : String(err)); }
  if (!args.url || args.url === true) throw new LoginError("start requires --url");
  if (!args.origin?.length) throw new LoginError("start requires at least one --origin");

  let loginUrl;
  try { loginUrl = new URL(args.url); } catch { throw new LoginError("--url must be an https URL"); }
  if (loginUrl.protocol !== "https:") throw new LoginError("--url must be https");

  const origins = [];
  for (const raw of args.origin) {
    let url;
    try { url = new URL(raw); } catch { throw new LoginError(`--origin must be a bare https origin: ${raw}`); }
    if (url.protocol !== "https:") throw new LoginError(`--origin must be https: ${raw}`);
    if (raw !== url.origin) throw new LoginError(`--origin must be a bare origin (no path): ${raw}`);
    if (!origins.includes(url.origin)) origins.push(url.origin);
  }
  if (!origins.some((o) => new URL(o).host === loginUrl.host)) {
    throw new LoginError("--url host must be one of the configured --origin hosts");
  }
  for (const key of ["complete-selector", "complete-url", "cookie", "timeout"]) {
    if (args[key] !== undefined) throw new LoginError(`--${key} is not used by user-confirmed login; use start, then complete after the user's reply`);
  }
  if (args["browser-channel"] !== undefined) throw new LoginError("use shared browser settings instead of --browser-channel");

  const browser = browserConfigFromEnv({ ...process.env, PROMETHEUS_CONFIG_DIR: configDir });
  let session;
  let handoffId;
  if (browser?.proxy) {
    if (!args.session || args.session === true) {
      throw new LoginError("--session is required when browser.proxy is configured");
    }
    try { assertValidName(args.session); }
    catch (err) { throw new LoginError(err instanceof Error ? err.message : String(err)); }
    if (args.session !== browser.proxy.session) {
      throw new LoginError(`--session '${args.session}' must match configured proxy.session '${browser.proxy.session}'`);
    }
    session = args.session;
    if (args.handoff !== undefined) {
      if (args.handoff === true || typeof args.handoff !== "string" || !/^[0-9a-f]{32}$/.test(args.handoff)) {
        throw new LoginError("--handoff must be a valid handoff token");
      }
      handoffId = args.handoff;
    }
  } else {
    if (args.session !== undefined) throw new LoginError("--session requires browser.proxy configuration");
    if (args.handoff !== undefined) throw new LoginError("--handoff requires browser.proxy configuration");
  }

  return {
    configDir,
    name: args.name,
    url: args.url,
    origins,
    captureSessionStorage: Boolean(args["session-storage"]),
    browser,
    ...(session !== undefined ? { session } : {}),
    ...(handoffId !== undefined ? { handoffId } : {}),
  };
}

function assertGraphicalSession() {
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new LoginError("headed login requires a graphical session (DISPLAY or WAYLAND_DISPLAY)");
  }
}

export async function readApprovedState(context, origins) {
  const approved = new Set(origins);
  const hosts = origins.map((origin) => new URL(origin).hostname);
  const states = new Map();
  for (const page of context.pages()) {
    const origin = new URL(page.url()).origin;
    if (!approved.has(origin)) continue;
    const entry = await page.evaluate(() => ({
      origin: location.origin,
      localStorage: Object.keys(localStorage).map((name) => ({ name, value: localStorage.getItem(name) })),
    }));
    if (entry.origin !== origin) throw new Error("login page moved during state capture");
    states.set(origin, entry);
  }
  return {
    cookies: (await context.cookies()).filter((cookie) => hosts.some((host) => hostMatchesCookieDomain(host, cookie.domain))),
    origins: [...states.values()],
  };
}

async function beforeDeadline(action, deadline) {
  let timer;
  try {
    return await Promise.race([
      action(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new LoginError("login state read timed out; window remains open")), Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally { clearTimeout(timer); }
}

async function captureSessionStorage(page, origins) {
  let origin;
  try { origin = new URL(page.url()).origin; } catch { return undefined; }
  if (!origins.includes(origin)) return undefined;
  const snapshot = await page.evaluate(() => ({
    origin: location.origin,
    entries: Object.fromEntries(Object.keys(window.sessionStorage).map((key) => [key, window.sessionStorage.getItem(key)])),
  }));
  if (snapshot.origin !== origin) throw new LoginError("login page moved during state capture; confirm again when ready");
  return snapshot.entries && Object.keys(snapshot.entries).length ? { [origin]: snapshot.entries } : undefined;
}

function loginSocket(configDir, name) {
  assertValidName(name);
  assertSafeSessionsDir(configDir);
  const dir = path.join(path.resolve(configDir), "prometheus-logins");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new LoginError("unsafe login directory");
  fs.chmodSync(dir, 0o700);
  const socket = path.join(dir, `${name}.sock`);
  if (Buffer.byteLength(socket) > 103) throw new LoginError("login socket path is too long; use a shorter configuration directory");
  const socketInfo = fs.lstatSync(socket, { throwIfNoEntry: false });
  if (socketInfo && !socketInfo.isSocket()) throw new LoginError("unsafe login socket");
  return socket;
}

export async function loginCommand(configDir, name, action) {
  const socketPath = loginSocket(configDir, name);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = "";
    socket.setTimeout(OPERATION_TIMEOUT_MS + 5000, () => socket.destroy(new Error("login command timed out")));
    socket.once("connect", () => socket.write(`${JSON.stringify({ action })}\n`));
    socket.on("data", chunk => {
      data += chunk;
      if (data.length > 32768) socket.destroy(new Error("invalid login worker response"));
    });
    socket.once("error", error => {
      if (["ENOENT", "ECONNREFUSED"].includes(error.code) && action === "pending") resolve({ status: "not-running", name });
      else reject(new LoginError(["ENOENT", "ECONNREFUSED"].includes(error.code) ? "no pending login; start a new login window" : "login worker unavailable; inspect pending status before retrying"));
    });
    socket.once("end", () => {
      try {
        const result = JSON.parse(data);
        result.error ? reject(new LoginError(result.error)) : resolve(result);
      } catch { reject(new LoginError("login worker closed without a result; inspect saved state before retrying")); }
    });
  });
}

export async function startLogin(opts, dependencies = {}) {
  let workerOpts = opts;
  if (opts.browser?.proxy) {
    if (!opts.session || opts.session !== opts.browser.proxy.session) {
      throw new LoginError("proxied login requires --session matching configured proxy.session");
    }
    if (!opts.handoffId) {
      try {
        const issued = await (dependencies.issueLoginHandoff || issueLoginHandoff)(
          opts.configDir,
          opts.browser,
          { session: opts.session }
        );
        workerOpts = { ...opts, handoffId: issued.handoffId };
      } catch (error) {
        throw new LoginError(sanitizePoolProxyError(error, opts.browser));
      }
    }
  }
  const socketPath = loginSocket(opts.configDir, opts.name);
  const existing = fs.lstatSync(socketPath, { throwIfNoEntry: false });
  if ((await loginCommand(opts.configDir, opts.name, "pending")).status !== "not-running") {
    throw new LoginError("login window already open; ask the user to finish, then complete it");
  }
  if (existing && fs.lstatSync(socketPath, { throwIfNoEntry: false })?.ino === existing.ino) fs.unlinkSync(socketPath);
  const child = (dependencies.fork || fork)(fileURLToPath(import.meta.url), ["worker"], {
    detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { child.kill("SIGTERM"); finish(new LoginError("login window failed to open within 30 seconds")); }, OPERATION_TIMEOUT_MS);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners("message"); child.removeAllListeners("exit");
      if (child.connected) child.disconnect();
      child.unref();
      error ? reject(error) : resolve(result);
    };
    child.once("error", () => finish(new LoginError("login worker could not start")));
    child.once("exit", () => finish(new LoginError("login worker exited before opening a window")));
    child.once("message", result => finish(result.error ? new LoginError(sanitizePoolProxyError(result.error, opts.browser)) : null, result));
    // Only source configuration crosses IPC; the worker resolves proxies.txt
    // privately while joining the pinned session, not in serialized options.
    child.send(workerOpts);
  });
}

export async function captureConfirmedState(context, opts, { beforeSnapshot = null, preferredPage = null } = {}) {
  const pages = context.pages();
  if (!pages.length) throw new LoginError("login window closed before capture");
  const approved = pages.filter(page => opts.origins.includes(new URL(page.url()).origin));
  if (!approved.length) throw new LoginError("return to an approved site in the login window, then confirm again");
  const storageState = await readApprovedState(context, opts.origins);
  const sessionStorage = {};
  if (opts.captureSessionStorage) {
    for (const page of approved) Object.assign(sessionStorage, await captureSessionStorage(page, opts.origins));
  }
  const targetPage = preferredPage && approved.includes(preferredPage) ? preferredPage : approved[approved.length - 1];
  const afterSnapshot = await captureLoginSnapshot(targetPage, opts.origins);
  const health = afterSnapshot?.approvedOrigin
    ? buildHealthContext({ before: beforeSnapshot, after: afterSnapshot, origins: opts.origins })
    : undefined;
  return {
    storageState,
    sessionStorage: opts.captureSessionStorage ? sessionStorage : undefined,
    ...(health ? { health } : {}),
  };
}

export function loginBrowserConfig(config) {
  const selected = validateBrowserConfig(config);
  if (selected.executionMode === "external-cdp") return selected;
  if (selected.proxy) return selected;
  if (selected.channel !== "msedge" && !selected.profile && !selected.identityProfile &&
      selected.executionMode !== "virtual-display" &&
      !Object.keys(selected.contextOptions ?? {}).length &&
      !Object.keys(selected.launchOptions ?? {}).length) {
    return { ...selected, executionMode: "external-cdp" };
  }
  return selected;
}

export async function serveLogin(opts, dependencies = {}) {
  let context, cdpBrowser, loginPage, profileDir, closing, beforeSnapshot = null, helperLease = null, proxyRelay = null, busy = false, listening = false, ready = false;
  const closeBrowser = async () => {
    if (cdpBrowser) {
      await loginPage?.close().catch(() => {});
      await cdpBrowser.close().catch(() => {});
    } else await context?.close().catch(() => {});
  };
  const server = net.createServer();
  const cleanup = () => closing ||= (async () => {
    if (listening) server.close();
    await closeBrowser();
    if (proxyRelay) await proxyRelay.close().catch(() => {});
    if (helperLease) {
      try { helperLease.release(); } catch {}
    }
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true });
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    process.removeListener("disconnect", disconnected);
  })();
  const interrupt = () => { void cleanup(); };
  const disconnected = () => { if (!ready) void cleanup(); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  process.once("disconnect", disconnected);
  try {
    opts = { ...opts, browser: loginBrowserConfig(opts.browser) };
    const socketPath = loginSocket(opts.configDir, opts.name);
    if (opts.browser.proxy) {
      if (!opts.session || !opts.handoffId) {
        throw new LoginError("proxied login requires session and handoff capability");
      }
      helperLease = await (dependencies.joinLoginHelper || joinLoginHelper)(
        opts.configDir,
        opts.browser,
        { session: opts.session, handoffId: opts.handoffId }
      );
      proxyRelay = await (dependencies.createLocalProxyRelay || createLocalProxyRelay)({
        server: helperLease.server,
        credentials: helperLease.credentials,
      });
    }
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    listening = true;
    fs.chmodSync(socketPath, 0o600);
    server.on("connection", socket => {
      let data = "";
      socket.setTimeout(OPERATION_TIMEOUT_MS + 5000, () => socket.destroy());
      socket.on("error", () => {});
      socket.on("data", async chunk => {
        data += chunk;
        if (data.length > 1024) { socket.destroy(); return; }
        if (!data.includes("\n")) return;
        socket.removeAllListeners("data");
        let action;
        try { ({ action } = JSON.parse(data)); } catch { socket.end(JSON.stringify({ error: "invalid login command" })); return; }
        if (action === "pending") { socket.end(JSON.stringify({ status: !ready ? "opening" : busy ? "completing" : "awaiting-user", name: opts.name })); return; }
        if (!ready) { socket.end(JSON.stringify({ error: "login window is still opening" })); return; }
        if (busy || closing) { socket.end(JSON.stringify({ error: "login worker is busy" })); return; }
        if (!["complete", "cancel"].includes(action)) { socket.end(JSON.stringify({ error: "unknown login command" })); return; }
        busy = true;
        try {
          let captured = null;
          if (action === "complete") {
            captured = await beforeDeadline(
              () => captureConfirmedState(context, opts, { beforeSnapshot, preferredPage: loginPage }),
              Date.now() + OPERATION_TIMEOUT_MS,
            );
            if (opts.browser.proxy && helperLease) {
              (dependencies.verifySessionGeneration || verifySessionGeneration)(
                opts.configDir,
                opts.browser,
                helperLease.generation
              );
            }
            saveState({ configDir: opts.configDir, name: opts.name, origins: opts.origins, ...captured, verification: { method: "user-confirmed" } });
            if (opts.browser.proxy && helperLease) {
              await (dependencies.bindAuthRecord || bindAuthRecord)(
                opts.configDir,
                opts.session,
                opts.name,
                { expectedGeneration: helperLease.generation }
              );
            }
          }
          await cleanup();
          socket.end(JSON.stringify({
            status: action === "complete" ? "saved" : "cancelled",
            name: opts.name,
            ...(action === "complete" ? {
              authentication: "unverified",
              ...(captured?.health ? { healthCheck: { captured: true, checkUrl: captured.health.checkUrl } } : {}),
            } : {}),
          }));
        } catch (error) {
          const safeMsg = sanitizePoolProxyError(error, opts.browser, helperLease?.credentials);
          socket.end(JSON.stringify({
            error: error instanceof LoginError || error instanceof BrowserSessionError
              ? safeMsg
              : "login operation failed; inspect pending status and saved-state metadata before retrying",
          }));
          busy = false;
        }
      });
    });
    const { chromium } = dependencies.chromium ? dependencies : await import("playwright");
    if (opts.browser.executionMode === "external-cdp") {
      ({ browser: cdpBrowser, context } = await (dependencies.launchExternalCdpContext || launchExternalCdpContext)(chromium, opts.browser, { headless: false }));
    } else {
      if (opts.browser.identityProfile === true || opts.browser.identityProfile === "random") {
        opts.browser = validateBrowserConfig({ ...opts.browser, identityProfile: resolveIdentityProfile(opts.browser).id });
      }
      const engines = dependencies.chromium ? dependencies : undefined;
      const browserType = await selectBrowserType(chromium, opts.browser, engines);
      if (opts.browser.automationCompatibility === undefined && browserType === chromium) {
        opts.browser = { ...opts.browser, automationCompatibility: true };
      }
      if (opts.browser.proxy && helperLease) {
        (dependencies.verifySessionGeneration || verifySessionGeneration)(
          opts.configDir,
          opts.browser,
          helperLease.generation
        );
      }
      profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "prometheus-login-"));
      const profile = resolveIdentityProfile(opts.browser || {});
      const contextOpts = browserContextOptions(opts.browser);
      if (profile?.userAgent && !contextOpts.userAgent) contextOpts.userAgent = profile.userAgent;
      context = await browserType.launchPersistentContext(profileDir, {
        ...browserLaunchOptions(opts.browser, false),
        ...(proxyRelay ? { proxy: { server: proxyRelay.url } } : {}),
        ...contextOpts,
      });
      if (opts.browser?.automationCompatibility) await applyAutomationCompatibility(context);
      if (profile) await applyBrowserProfile(context, profile);
    }
    if (closing) { await closeBrowser(); if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true }); return; }
    context.once("close", () => { void cleanup(); });
    loginPage = cdpBrowser ? await context.newPage() : context.pages()[0] ?? await context.newPage();
    if (closing) { await closeBrowser(); return; }
    proxyRelay?.clearLastFailure();
    const loginResp = await loginPage.goto(opts.url, { waitUntil: "domcontentloaded", timeout: OPERATION_TIMEOUT_MS });
    const relayFailure = proxyRelay?.getLastFailure();
    if (loginResp?.status() === 407 || relayFailure?.kind === "proxy_auth") {
      throw new LoginError("proxy authentication failed (HTTP 407); do not retry automatically or fall back to direct connection");
    }
    if (relayFailure?.kind === "proxy_connection") {
      throw new LoginError(`proxy connection failed (${relayFailure.code}); do not retry automatically or fall back to direct connection`);
    }
    beforeSnapshot = await captureLoginSnapshot(loginPage, opts.origins);
    ready = true;
    if (process.connected) process.send({ status: "awaiting-user", name: opts.name });
  } catch (error) {
    const relayFailure = proxyRelay?.getLastFailure();
    const message = relayFailure?.kind === "proxy_auth"
      ? "proxy authentication failed (HTTP 407); do not retry automatically or fall back to direct connection"
      : relayFailure?.kind === "proxy_connection"
        ? `proxy connection failed (${relayFailure.code}); do not retry automatically or fall back to direct connection`
        : error instanceof LoginError || error instanceof BrowserSessionError
          ? sanitizePoolProxyError(error, opts.browser, helperLease?.credentials)
          : "login window could not open; check graphical session and browser installation";
    await cleanup();
    if (process.connected) process.send({ error: message }, () => { if (process.connected) process.disconnect(); });
  }
}

function status(args) {
  const configDir = requireConfigDir(args);
  if (args.name && args.name !== true) {
    const meta = statMetadata(configDir, args.name);
    process.stdout.write(meta ? `[${meta.name}] origins=${meta.origins.join(",")} capturedAt=${meta.capturedAt}${meta.checkUrl ? ` checkUrl=${meta.checkUrl}` : ""}\n` : `[missing] ${args.name}\n`);
    return 0;
  }
  const rows = listStates(configDir);
  if (!rows.length) { process.stdout.write("No captured sessions\n"); return 0; }
  for (const meta of rows) process.stdout.write(`[${meta.name}] origins=${(meta.origins || []).join(",")} capturedAt=${meta.capturedAt ?? "?"}${meta.checkUrl ? ` checkUrl=${meta.checkUrl}` : ""}\n`);
  return 0;
}

function health(args) {
  const configDir = requireConfigDir(args);
  if (!args.name || args.name === true) throw new LoginError("--name is required for health");
  const info = readHealthContext(configDir, args.name);
  if (!info) { process.stdout.write(`[missing] ${args.name}\n`); return 1; }
  process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
  return 0;
}

function remove(args) {
  const configDir = requireConfigDir(args);
  if (!args.name || args.name === true) throw new LoginError("--name is required for remove");
  process.stdout.write(removeState(configDir, args.name) ? `Removed captured session "${args.name}"\n` : `No captured session "${args.name}"\n`);
  return 0;
}

async function main(argv) {
  const args = parseArgs(argv);
  const action = args._[0];
  switch (action) {
    case "start": {
      const opts = validateStartArgs(args);
      assertGraphicalSession();
      assertBundledBrowserInstalled((await import("playwright")).chromium, opts.browser, "login");
      process.stdout.write(`${JSON.stringify(await startLogin(opts))}\n`);
      return 0;
    }
    case "complete":
    case "cancel":
    case "pending":
      process.stdout.write(`${JSON.stringify(await loginCommand(requireConfigDir(args), args.name, action))}\n`);
      return 0;
    case "worker":
      if (!process.send) throw new LoginError("login worker requires its private parent channel");
      process.once("message", opts => { void serveLogin(opts); });
      return null;
    case "capture":
      throw new LoginError("blocking capture was removed; use start, ask the user to log in and reply, then complete");
    case "status":
      return status(args);
    case "health":
      return health(args);
    case "remove":
      return remove(args);
    default:
      process.stderr.write("usage: opencode-browser-login.mjs <start|complete|cancel|pending|status|health|remove> --config-dir <dir> [--name <name>] ...\n");
      throw new LoginError(action ? `unknown action: ${action}` : "no action given");
  }
}

if (process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1])) {
  main(process.argv.slice(2))
    .then((code) => { if (code !== null) process.exit(code ?? 0); })
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}

export { parseArgs, LoginError };
