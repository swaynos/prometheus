#!/usr/bin/env node
// opencode-browser-login.mjs
//
// Headed Playwright login helper. This is the ONLY place a visible browser
// window opens in the Playwright-only browser stack. A person completes a
// required login here; the approved Playwright storage state is saved through
// opencode-browser-state.mjs (owner-only, origin-scoped) and later loaded
// privately by the task MCP server. This helper never performs task work
// and never prints state values.
//
// start opens a detached login worker and returns. The person replies when
// ready; only a later complete command captures state. No login polling or
// human deadline. Task access must be checked after capture.
//
// CLI:
//   start --config-dir <dir> --name <name> --url <https-login-url>
//         --origin <https-origin> [--origin ...] [--session-storage]
//   complete|cancel|pending --config-dir <dir> --name <name>
//   status  --config-dir <dir> [--name <name>]   (metadata only)
//   remove  --config-dir <dir> --name <name>

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import net from "node:net";
import {
  assertValidName,
  assertSafeSessionsDir,
  saveState,
  statMetadata,
  listStates,
  removeState,
} from "./opencode-browser-state.mjs";

import { browserLaunchOptions, browserContextOptions, browserConfigFromEnv, applyAutomationCompatibility, applyBrowserProfile, resolveIdentityProfile, selectBrowserType, validateBrowserConfig } from "./opencode-browser-runtime.mjs";

const OPERATION_TIMEOUT_MS = 30_000;

class LoginError extends Error {}

// --- argument parsing (repeatable --origin) --------------------------------

function parseArgs(argv) {
  const out = { _: [], origin: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    const value = next === undefined || next.startsWith("--") ? true : (i++, next);
    if (key === "origin") {
      if (value === true) throw new LoginError("--origin requires a value");
      out.origin.push(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function requireConfigDir(args) {
  const dir = args["config-dir"] || process.env.OPENCODE_DEPLOY_CONFIG_DIR;
  if (!dir || dir === true) throw new LoginError("--config-dir is required");
  return dir;
}

// Validate start arguments fully, BEFORE any browser launch. Returns a
// normalised option object.
export function validateStartArgs(args) {
  const configDir = requireConfigDir(args);
  if (!args.name || args.name === true) throw new LoginError("--name is required");
  try {
    assertValidName(args.name);
  } catch (err) {
    throw new LoginError(err instanceof Error ? err.message : String(err));
  }
  if (!args.url || args.url === true) throw new LoginError("start requires --url");
  if (!args.origin?.length) throw new LoginError("start requires at least one --origin");

  let loginUrl;
  try {
    loginUrl = new URL(args.url);
  } catch {
    throw new LoginError("--url must be an https URL");
  }
  if (loginUrl.protocol !== "https:") throw new LoginError("--url must be https");

  const origins = [];
  for (const raw of args.origin) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new LoginError(`--origin must be a bare https origin: ${raw}`);
    }
    if (url.protocol !== "https:") throw new LoginError(`--origin must be https: ${raw}`);
    // Compare against the raw string: new URL() normalises "https://host" and
    // "https://host/" to the same origin, so a trailing slash or any path is
    // only detectable before normalisation.
    if (raw !== url.origin) {
      throw new LoginError(`--origin must be a bare origin (no path): ${raw}`);
    }
    if (!origins.includes(url.origin)) origins.push(url.origin);
  }

  const originHosts = new Set(origins.map((o) => new URL(o).host));
  if (!originHosts.has(loginUrl.host)) {
    throw new LoginError("--url host must be one of the configured --origin hosts");
  }

  for (const key of ["complete-selector", "complete-url", "cookie", "timeout"]) {
    if (args[key] !== undefined) throw new LoginError(`--${key} is not used by user-confirmed login; use start, then complete after the user's reply`);
  }
  if (args["browser-channel"] !== undefined) throw new LoginError("use shared browser settings instead of --browser-channel");

  return {
    configDir,
    name: args.name,
    url: args.url,
    origins,
    captureSessionStorage: Boolean(args["session-storage"]),
    browser: browserConfigFromEnv({ ...process.env, PROMETHEUS_CONFIG_DIR: configDir }),
  };
}

// --- headed capture --------------------------------------------------------

function assertGraphicalSession() {
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new LoginError("headed login requires a graphical session (DISPLAY or WAYLAND_DISPLAY)");
  }
}

function cookieMatchesOrigins(cookie, origins) {
  const domain = String(cookie.domain || "").replace(/^\./, "");
  return origins.some((origin) => {
    const host = new URL(origin).hostname;
    return host === domain || host.endsWith(`.${domain}`);
  });
}

// storageState() can open temporary pages and intercept their requests. Never
// call it in the login context, including final capture.
export async function readApprovedState(context, origins) {
  const approved = new Set(origins);
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
    cookies: (await context.cookies()).filter((cookie) => cookieMatchesOrigins(cookie, origins)),
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

// Capture session storage per approved origin, only when explicitly requested.
async function captureSessionStorage(page, origins) {
  const result = {};
  let origin;
  try {
    origin = new URL(page.url()).origin;
  } catch {
    return undefined;
  }
  if (!origins.includes(origin)) return undefined;
  const snapshot = await page.evaluate(() => ({ origin: location.origin, entries: Object.fromEntries(Object.keys(window.sessionStorage).map((key) => [key, window.sessionStorage.getItem(key)])) }));
  if (snapshot.origin !== origin) throw new LoginError("login page moved during state capture; confirm again when ready");
  const entries = snapshot.entries;
  if (entries && Object.keys(entries).length) result[origin] = entries;
  return Object.keys(result).length ? result : undefined;
}

// A private Unix socket carries commands and metadata only, never browser state.
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
        if (result.error) reject(new LoginError(result.error));
        else resolve(result);
      } catch { reject(new LoginError("login worker closed without a result; inspect saved state before retrying")); }
    });
  });
}

export async function startLogin(opts, dependencies = {}) {
  const socketPath = loginSocket(opts.configDir, opts.name);
  const existing = fs.lstatSync(socketPath, { throwIfNoEntry: false });
  if ((await loginCommand(opts.configDir, opts.name, "pending")).status !== "not-running") throw new LoginError("login window already open; ask the user to finish, then complete it");
  // Never unlink another concurrent starter's newly bound socket.
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
    child.once("message", result => finish(result.error ? new LoginError(result.error) : null, result));
    child.send(opts);
  });
}

export async function captureConfirmedState(context, opts) {
  const pages = context.pages();
  if (!pages.length) throw new LoginError("login window closed before capture");
  const approved = pages.filter(page => opts.origins.includes(new URL(page.url()).origin));
  if (!approved.length) throw new LoginError("return to an approved site in the login window, then confirm again");
  const storageState = await readApprovedState(context, opts.origins);
  const sessionStorage = {};
  if (opts.captureSessionStorage) {
    for (const page of approved) Object.assign(sessionStorage, await captureSessionStorage(page, opts.origins));
  }
  return { storageState, sessionStorage: opts.captureSessionStorage ? sessionStorage : undefined };
}

export async function serveLogin(opts, dependencies = {}) {
  const socketPath = loginSocket(opts.configDir, opts.name);
  let context, profileDir, closing, busy = false, listening = false, ready = false;
  const server = net.createServer();
  const cleanup = () => closing ||= (async () => {
    if (listening) server.close();
    await context?.close().catch(() => {});
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true });
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    process.removeListener("disconnect", disconnected);
  })();
  const interrupt = () => { void cleanup(); };
  const disconnected = () => { if (!ready) void cleanup(); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  process.once("disconnect", disconnected);
  try {
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
          if (action === "complete") {
            const captured = await beforeDeadline(() => captureConfirmedState(context, opts), Date.now() + OPERATION_TIMEOUT_MS);
            // Save only after the bounded read succeeded, never after a timeout.
            saveState({ configDir: opts.configDir, name: opts.name, origins: opts.origins,
              ...captured, verification: { method: "user-confirmed" } });
          }
          await cleanup();
          socket.end(JSON.stringify({ status: action === "complete" ? "saved" : "cancelled", name: opts.name,
            ...(action === "complete" ? { authentication: "unverified" } : {}) }));
        } catch (error) {
          socket.end(JSON.stringify({ error: error instanceof LoginError ? error.message : "login operation failed; inspect pending status and saved-state metadata before retrying" }));
          busy = false;
        }
      });
    });
    const { chromium } = dependencies.chromium ? dependencies : await import("playwright");
    if (opts.browser.identityProfile === true || opts.browser.identityProfile === "random") {
      opts.browser = validateBrowserConfig({ ...opts.browser, identityProfile: resolveIdentityProfile(opts.browser).id });
    }
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "prometheus-login-"));
    const profile = resolveIdentityProfile(opts.browser || {});
    const contextOpts = browserContextOptions(opts.browser);
    if (profile?.userAgent && !contextOpts.userAgent) {
      contextOpts.userAgent = profile.userAgent;
    }
    const browserType = await selectBrowserType(chromium, opts.browser, dependencies.chromium ? dependencies : undefined);
    context = await browserType.launchPersistentContext(profileDir, { ...browserLaunchOptions(opts.browser, false), ...contextOpts });
    if (opts.browser?.automationCompatibility) {
      await applyAutomationCompatibility(context);
    }
    if (profile) {
      await applyBrowserProfile(context, profile);
    }
    if (closing) { await context.close(); fs.rmSync(profileDir, { recursive: true, force: true }); return; }
    context.once("close", () => { void cleanup(); });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: OPERATION_TIMEOUT_MS });
    ready = true;
    if (process.connected) process.send({ status: "awaiting-user", name: opts.name });
  } catch {
    await cleanup();
    if (process.connected) process.send({ error: "login window could not open; check graphical session and browser installation" }, () => { if (process.connected) process.disconnect(); });
  }
}

// --- metadata-only status / remove -----------------------------------------

function status(args) {
  const configDir = requireConfigDir(args);
  if (args.name && args.name !== true) {
    const meta = statMetadata(configDir, args.name);
    if (!meta) {
      // The lookup itself succeeded: it correctly reports that no record
      // exists. That is a normal, successful query, not an error.
      process.stdout.write(`[missing] ${args.name}\n`);
      return 0;
    }
    process.stdout.write(`[${meta.name}] origins=${meta.origins.join(",")} capturedAt=${meta.capturedAt}\n`);
    return 0;
  }
  const rows = listStates(configDir);
  if (!rows.length) {
    process.stdout.write("No captured sessions\n");
    return 0;
  }
  for (const meta of rows) {
    process.stdout.write(`[${meta.name}] origins=${(meta.origins || []).join(",")} capturedAt=${meta.capturedAt ?? "?"}\n`);
  }
  return 0;
}

function remove(args) {
  const configDir = requireConfigDir(args);
  if (!args.name || args.name === true) throw new LoginError("--name is required for remove");
  const removed = removeState(configDir, args.name);
  process.stdout.write(removed ? `Removed captured session "${args.name}"\n` : `No captured session "${args.name}"\n`);
  return 0;
}

// --- CLI -------------------------------------------------------------------

async function main(argv) {
  const args = parseArgs(argv);
  const action = args._[0];
  switch (action) {
    case "start": {
      const opts = validateStartArgs(args);
      assertGraphicalSession();
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
    case "remove":
      return remove(args);
    default:
      process.stderr.write(
        "usage: opencode-browser-login.mjs <start|complete|cancel|pending|status|remove> --config-dir <dir> [--name <name>] ...\n",
      );
      throw new LoginError(action ? `unknown action: ${action}` : "no action given");
  }
}

// Compare canonical (symlink-resolved) paths with fileURLToPath rather than
// path.resolve(...pathname): on macOS the config dir is a /var -> /private/var
// symlink and paths may contain spaces, either of which breaks a lexical match
// and silently skips the CLI body.
const invokedDirectly =
  process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => { if (code !== null) process.exit(code ?? 0); })
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}

export { parseArgs, LoginError };
