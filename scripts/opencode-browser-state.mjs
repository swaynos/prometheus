#!/usr/bin/env node
// opencode-browser-state.mjs
//
// Secure store for Playwright browser login state used by the Playwright-only
// browser stack. Each record holds Playwright storage state (cookies + origin
// localStorage) plus optional explicitly-captured session storage, scoped to a
// set of approved HTTPS origins, for one site or account.
//
// Security invariants (see docs/REQUIREMENTS.md "Browser Credentials"):
//   - Records live under <config_dir>/prometheus-sessions/<name>.json with
//     owner-only permissions (mode 0600).
//   - State values (cookies, tokens, storage) never appear in listings, status
//     output, logs, or any value returned toward model context. Only metadata
//     (name, origins, capture time) is ever surfaced.
//   - State is loaded only for a matching approved origin; a login redirect to
//     an unapproved origin must not release state.
//   - The sessions directory and record files must be real files, never
//     symlinks that could redirect writes/reads outside the config root.
//
// This module is import-safe (pure functions, no side effects at import) and
// also exposes a metadata-only CLI: `list`, `status`, `remove`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SESSIONS_DIRNAME = "prometheus-sessions";
export const STATE_SCHEMA_VERSION = 1;

/** Characters allowed in a session/account name. Deliberately excludes path
 * separators, so a name can never escape the sessions directory. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class BrowserStateError extends Error {}

/** Validate a session name. Returns the name or throws BrowserStateError. */
export function assertValidName(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 128) {
    throw new BrowserStateError("session name must be a non-empty string (<=128 chars)");
  }
  if (name === "." || name === "..") {
    throw new BrowserStateError(`invalid session name: ${name}`);
  }
  if (!NAME_RE.test(name)) {
    throw new BrowserStateError(
      `invalid session name: ${name} (allowed: letters, digits, '.', '_', '-'; no path separators)`,
    );
  }
  return name;
}

/** Validate and normalise a list of approved origins. Only HTTPS origins are
 * accepted; each is reduced to scheme+host(+port) with no path. */
export function normaliseOrigins(origins) {
  if (!Array.isArray(origins) || origins.length === 0) {
    throw new BrowserStateError("at least one https origin is required");
  }
  const out = [];
  for (const raw of origins) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new BrowserStateError(`invalid origin: ${raw}`);
    }
    if (url.protocol !== "https:") {
      throw new BrowserStateError(`origin must be https: ${raw}`);
    }
    const origin = url.origin;
    if (!out.includes(origin)) out.push(origin);
  }
  return out;
}

/** Absolute path to the sessions directory for a config root. */
export function sessionsDir(configDir) {
  if (!configDir || typeof configDir !== "string") {
    throw new BrowserStateError("configDir is required");
  }
  return path.join(configDir, SESSIONS_DIRNAME);
}

/** Reject a sessions directory that exists but is a symlink. Returns the path. */
export function assertSafeSessionsDir(configDir) {
  const dir = sessionsDir(configDir);
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (err) {
    if (err && err.code === "ENOENT") return dir; // not created yet: fine
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new BrowserStateError(`sessions directory is a symlink: ${dir}`);
  }
  if (!st.isDirectory()) {
    throw new BrowserStateError(`sessions path is not a directory: ${dir}`);
  }
  return dir;
}

/** Absolute path to one record file, with name + symlink safety checks. */
export function recordPath(configDir, name) {
  assertValidName(name);
  const dir = assertSafeSessionsDir(configDir);
  const file = path.join(dir, `${name}.json`);
  // Defence in depth: the joined path must stay directly inside the dir.
  if (path.dirname(file) !== dir) {
    throw new BrowserStateError(`resolved record path escapes sessions dir: ${file}`);
  }
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    if (err && err.code === "ENOENT") return file;
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new BrowserStateError(`record file is a symlink: ${file}`);
  }
  return file;
}

function ensureSessionsDir(configDir) {
  const dir = assertSafeSessionsDir(configDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best effort on platforms without full chmod support */
  }
  return dir;
}

function hostMatchesCookieDomain(host, domain) {
  if (typeof domain !== "string" || !domain) return false;
  const normalized = domain.replace(/^\./, "").toLowerCase();
  const target = host.toLowerCase();
  return target === normalized || target.endsWith(`.${normalized}`);
}

function filterState(origins, storageState, sessionStorage) {
  const allowed = new Set(origins);
  const hosts = origins.map((origin) => new URL(origin).hostname);
  const cookies = (Array.isArray(storageState?.cookies) ? storageState.cookies : [])
    .filter((cookie) => cookie && hosts.some((host) => hostMatchesCookieDomain(host, cookie.domain)));
  const originStores = (Array.isArray(storageState?.origins) ? storageState.origins : [])
    .filter((entry) => entry && allowed.has(entry.origin));
  const sessions = {};
  if (sessionStorage && typeof sessionStorage === "object") {
    for (const origin of origins) {
      const entries = sessionStorage[origin];
      if (entries && typeof entries === "object") sessions[origin] = entries;
    }
  }
  return { storageState: { cookies, origins: originStores }, sessionStorage: Object.keys(sessions).length ? sessions : undefined };
}

function normaliseVerification(verification) {
  if (verification === undefined || verification === null) return undefined;
  if (!verification || typeof verification !== "object" || Array.isArray(verification)) {
    throw new BrowserStateError("verification must be an object");
  }
  if (verification.method === "user-confirmed") return { method: "user-confirmed" };
  const selector = typeof verification.selector === "string" ? verification.selector.trim() : "";
  if (!selector) throw new BrowserStateError("verification selector is required");
  if (selector.length > 1000) throw new BrowserStateError("verification selector is too long");
  return { selector };
}

/**
 * Persist a state record (mode 0600). Overwrites any existing record of the
 * same name. `storageState` is the object returned by Playwright's
 * `context.storageState()`. `sessionStorage` is an optional map of
 * origin -> { key: value } captured explicitly for sites that need it.
 */
export function saveState({ configDir, name, origins, storageState, sessionStorage, verification }) {
  assertValidName(name);
  const normOrigins = normaliseOrigins(origins);
  if (!storageState || typeof storageState !== "object") {
    throw new BrowserStateError("storageState object is required");
  }
  ensureSessionsDir(configDir);
  const file = recordPath(configDir, name);
  const filtered = filterState(normOrigins, storageState, sessionStorage);
  const record = {
    schemaVersion: STATE_SCHEMA_VERSION,
    name,
    origins: normOrigins,
    capturedAt: new Date().toISOString(),
    storageState: filtered.storageState,
  };
  if (filtered.sessionStorage) {
    record.sessionStorage = filtered.sessionStorage;
  }
  const normalizedVerification = normaliseVerification(verification);
  if (normalizedVerification) record.verification = normalizedVerification;
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* best effort */
  }
  fs.renameSync(tmp, file);
  return file;
}

/** Read a full record from disk (internal / runtime use only — contains
 * secret values, never return this toward model context). */
export function readRecord(configDir, name) {
  const file = recordPath(configDir, name);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BrowserStateError(`record is not valid JSON: ${file}`);
  }
  if (parsed.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new BrowserStateError(
      `unsupported state schema version ${parsed.schemaVersion} in ${file}`,
    );
  }
  return parsed;
}

/**
 * Return the Playwright storage state for a record ONLY if `origin` is one of
 * its approved origins. Returns null when the record is missing or the origin
 * is not approved. The returned value feeds directly into a browser context;
 * callers must never place it in model context, logs, or tool output.
 */
export function loadStateForOrigin({ configDir, name, origin }) {
  let normOrigin;
  try {
    normOrigin = new URL(origin).origin;
  } catch {
    throw new BrowserStateError(`invalid origin: ${origin}`);
  }
  const record = readRecord(configDir, name);
  if (!record) return null;
  if (!record.origins.includes(normOrigin)) return null;
  const filtered = filterState(record.origins, record.storageState, record.sessionStorage);
  return {
    storageState: filtered.storageState,
    sessionStorage: filtered.sessionStorage || null,
    verification: normaliseVerification(record.verification) || null,
    origins: record.origins.slice(),
  };
}

/** Metadata-only view of one record (safe to surface). */
export function statMetadata(configDir, name) {
  const record = readRecord(configDir, name);
  if (!record) return null;
  return {
    name: record.name,
    origins: record.origins.slice(),
    capturedAt: record.capturedAt,
    hasSessionStorage: Boolean(record.sessionStorage),
    hasVerificationSelector: Boolean(normaliseVerification(record.verification)?.selector),
    userConfirmed: normaliseVerification(record.verification)?.method === "user-confirmed",
  };
}

/** Metadata-only listing of every record (safe to surface). */
export function listStates(configDir) {
  const dir = assertSafeSessionsDir(configDir);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const name = entry.slice(0, -".json".length);
    try {
      const meta = statMetadata(configDir, name);
      if (meta) out.push(meta);
    } catch {
      out.push({ name, origins: [], capturedAt: null, error: "unreadable" });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Remove exactly one record. Returns true if a file was deleted. */
export function removeState(configDir, name) {
  const file = recordPath(configDir, name);
  try {
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// CLI (metadata only; never prints state values)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function resolveConfigDir(args) {
  const dir = args["config-dir"] || process.env.OPENCODE_DEPLOY_CONFIG_DIR;
  if (!dir) {
    throw new BrowserStateError(
      "config dir required: pass --config-dir or set OPENCODE_DEPLOY_CONFIG_DIR",
    );
  }
  return dir;
}

function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  switch (command) {
    case "list": {
      const configDir = resolveConfigDir(args);
      const rows = listStates(configDir);
      process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
      return 0;
    }
    case "status": {
      const configDir = resolveConfigDir(args);
      if (!args.name) throw new BrowserStateError("--name is required for status");
      const meta = statMetadata(configDir, args.name);
      if (!meta) {
        process.stderr.write(`no saved state named ${args.name}\n`);
        return 1;
      }
      process.stdout.write(JSON.stringify(meta, null, 2) + "\n");
      return 0;
    }
    case "remove": {
      const configDir = resolveConfigDir(args);
      if (!args.name) throw new BrowserStateError("--name is required for remove");
      const removed = removeState(configDir, args.name);
      process.stdout.write(removed ? `removed ${args.name}\n` : `no such state ${args.name}\n`);
      return 0;
    }
    default:
      process.stderr.write(
        "usage: opencode-browser-state.mjs <list|status|remove> --config-dir <dir> [--name <name>]\n",
      );
      return command ? 1 : 0;
  }
}

// Compare canonical (symlink-resolved) paths with fileURLToPath rather than
// path.resolve(...pathname): on macOS the config dir is a /var -> /private/var
// symlink and paths may contain spaces, either of which breaks a lexical match
// and silently skips the CLI body.
const invokedDirectly =
  process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);

if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
