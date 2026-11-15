import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assertValidName, statMetadata } from "./opencode-browser-state.mjs";
import { ProxyListError, readProxyList } from "./opencode-browser-proxy-list.mjs";

const { constants } = fs;

export const PROXY_SESSIONS_DIR = "prometheus-proxy-sessions";
const REGISTRY_FILE = "registry.json";
const REGISTRY_LOCK = "registry.lock";
const RECLAIM_LOCK = "registry.reclaim.lock";
const OWNERS_DIR = "owners";
const HANDOFFS_DIR = "handoffs";
const HANDOFF_SECRET_FILE = "handoff-secret";
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_HANDOFF_TTL_MS = 60_000;
const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024;
const MAX_REGISTRY_FILE_BYTES = 4 * 1024 * 1024;
const MAX_HANDOFF_FILE_BYTES = 16 * 1024;

const PROXY_KEYS = new Set(["session", "strategy", "pool"]);
const POOL_ENTRY_KEYS = new Set(["id", "server", "credentialsFile"]);
const CREDENTIAL_KEYS = new Set(["username", "password"]);
const REGISTRY_KEYS = new Set(["version", "nextProxyId", "sessions"]);
const SESSION_RECORD_KEYS = new Set([
  "generation",
  "proxyId",
  "endpointFingerprint",
  "authRecords",
  "createdAt",
  "rotatedAt",
]);

const activeLocalTokens = new Set();
// Share private redaction state across validated config copies, never across IPC
// or JSON serialization. The source proxy object owns its lifetime.
const proxySecrets = new WeakMap();

function shareProxySecrets(source, selected) {
  const secrets = proxySecrets.get(source) ?? new Map();
  proxySecrets.set(source, secrets);
  proxySecrets.set(selected, secrets);
  return selected;
}

export class BrowserSessionError extends Error {
  constructor(message) {
    super(message);
    this.name = "BrowserSessionError";
  }
}

function hasStrictOpenSupport() {
  return (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    typeof constants.O_NOFOLLOW === "number" &&
    typeof constants.O_DIRECTORY === "number"
  );
}

function assertStrictOpenSupport() {
  if (!hasStrictOpenSupport()) {
    throw new BrowserSessionError("race-resistant private storage requires POSIX O_NOFOLLOW, O_DIRECTORY, and getuid()");
  }
}

function ownUid() {
  assertStrictOpenSupport();
  return process.getuid();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactAllowedKeys(obj, allowed, label) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new BrowserSessionError(`unexpected ${label} key: ${key}`);
    }
  }
}

export function assertValidRelativeCredentialPath(relPath) {
  if (typeof relPath !== "string" || !relPath) {
    throw new BrowserSessionError("credentialsFile must be a non-empty relative path");
  }
  if (
    relPath.includes("\0") ||
    relPath.includes("\\") ||
    path.isAbsolute(relPath) ||
    relPath.startsWith("/") ||
    /^[A-Za-z]:/.test(relPath) ||
    /[\r\n]/.test(relPath)
  ) {
    throw new BrowserSessionError("credentialsFile must be a safe relative path within PROMETHEUS_CONFIG_DIR");
  }
  const segments = relPath.split("/");
  if (segments.length === 0) {
    throw new BrowserSessionError("credentialsFile must not be empty");
  }
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") {
      throw new BrowserSessionError("credentialsFile must not contain empty, '.', or '..' path segments");
    }
  }
  return segments;
}

export function canonicalizeProxyServer(rawServer) {
  if (typeof rawServer !== "string" || !rawServer || rawServer !== rawServer.trim() || /\s/.test(rawServer)) {
    throw new BrowserSessionError("proxy pool server must be a canonical http://host:port URL without whitespace");
  }
  if (rawServer.includes("@")) {
    throw new BrowserSessionError("proxy pool server must not embed credentials");
  }
  let parsed;
  try {
    parsed = new URL(rawServer);
  } catch {
    throw new BrowserSessionError("proxy pool server must be a valid http://host:port URL");
  }
  if (parsed.protocol !== "http:") {
    throw new BrowserSessionError("proxy pool server must use the http:// scheme");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new BrowserSessionError("proxy pool server must not contain credentials, query strings, or fragments");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new BrowserSessionError("proxy pool server must not include a path");
  }
  if (!parsed.hostname) {
    throw new BrowserSessionError("proxy pool server must include a hostname");
  }

  // URL strips explicit :80 from parsed.port, so inspect the authority section directly to enforce an explicit port.
  const withoutScheme = rawServer.replace(/^http:\/\//i, "");
  const authority = withoutScheme.endsWith("/") ? withoutScheme.slice(0, -1) : withoutScheme;
  const portMatch = authority.match(/:(\d+)$/);
  if (!portMatch) {
    throw new BrowserSessionError("proxy pool server must explicitly specify :port");
  }
  const port = Number(portMatch[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new BrowserSessionError("proxy pool server port must be between 1 and 65535");
  }
  return `http://${parsed.hostname.toLowerCase()}:${port}`;
}

export function fingerprintEndpoint(canonicalServer) {
  return crypto.createHash("sha256").update(canonicalServer, "utf8").digest("hex");
}

export function validateProxyConfig(rawProxy) {
  if (!isPlainObject(rawProxy)) {
    throw new BrowserSessionError("browser.proxy must be an object");
  }
  assertExactAllowedKeys(rawProxy, PROXY_KEYS, "proxy");
  try {
    assertValidName(rawProxy.session);
  } catch {
    throw new BrowserSessionError("browser.proxy.session must be a valid session name");
  }
  if (rawProxy.strategy !== "round-robin") {
    throw new BrowserSessionError("browser.proxy.strategy must be 'round-robin'");
  }
  if (!Object.hasOwn(rawProxy, "pool")) {
    return shareProxySecrets(rawProxy, { session: rawProxy.session, strategy: "round-robin" });
  }
  if (!Array.isArray(rawProxy.pool) || rawProxy.pool.length === 0) {
    throw new BrowserSessionError("browser.proxy.pool must be a non-empty array");
  }
  const seenIds = new Set();
  const pool = rawProxy.pool.map((entry) => {
    if (!isPlainObject(entry)) {
      throw new BrowserSessionError("browser.proxy.pool entries must be objects");
    }
    assertExactAllowedKeys(entry, POOL_ENTRY_KEYS, "proxy pool entry");
    try {
      assertValidName(entry.id);
    } catch {
      throw new BrowserSessionError("browser.proxy.pool entry id must be a valid identifier");
    }
    if (seenIds.has(entry.id)) {
      throw new BrowserSessionError(`duplicate proxy pool entry id: ${entry.id}`);
    }
    seenIds.add(entry.id);
    const server = canonicalizeProxyServer(entry.server);
    let credentialsFile;
    if (entry.credentialsFile !== undefined) {
      assertValidRelativeCredentialPath(entry.credentialsFile);
      credentialsFile = entry.credentialsFile;
    }
    return {
      id: entry.id,
      server,
      ...(credentialsFile !== undefined ? { credentialsFile } : {}),
    };
  });
  return shareProxySecrets(rawProxy, {
    session: rawProxy.session,
    strategy: "round-robin",
    pool,
  });
}

function resolveProxyConfig(configDir, rawProxy) {
  const proxy = validateProxyConfig(rawProxy);
  if (proxy.pool) return proxy;
  const pool = readProxyList(configDir);
  const secrets = proxySecrets.get(proxy);
  for (const entry of pool) {
    const { username, password } = entry.credentials;
    secrets.set(JSON.stringify([entry.server, username, password]), entry);
  }
  return { ...proxy, pool };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactSecrets(input, sensitive = {}) {
  let text = input instanceof Error ? input.message : String(input ?? "");
  if (!text) return "";

  text = text.replace(/((?:proxy-)?authorization\s*[:=]\s*basic\s+)[A-Za-z0-9+/=]+/gi, "$1[REDACTED]");
  text = text.replace(/https?:\/\/[^/\s:@]+:[^@\s]+@[^\s"'`<>]+/gi, "[REDACTED_PROXY_URL]");
  text = text.replace(/https?:\/\/[^\s"'`<>]+/gi, (match) => {
    const lower = match.toLowerCase();
    if (sensitive.urls?.some((u) => typeof u === "string" && lower.startsWith(u.toLowerCase()))) {
      return "[REDACTED_PROXY_URL]";
    }
    return match;
  });

  const literals = new Set();
  for (const val of sensitive.literals ?? []) {
    if (typeof val === "string" && val.length > 0) literals.add(val);
  }
  for (const url of sensitive.urls ?? []) {
    if (typeof url === "string" && url.length > 0) {
      literals.add(url);
      literals.add(url.replace(/^http:\/\//i, ""));
      const hostPort = url.replace(/^http:\/\//i, "");
      literals.add(hostPort);
    }
  }
  if (sensitive.credentials) {
    const { username, password } = sensitive.credentials;
    if (typeof username === "string" && typeof password === "string" && username && password) {
      literals.add(Buffer.from(`${username}:${password}`, "utf8").toString("base64"));
    }
    for (const part of [username, password]) {
      if (typeof part === "string" && part.length > 0) {
        if (part.length >= 4) {
          literals.add(part);
        }
        const encoded = encodeURIComponent(part);
        if (encoded.length >= 4) literals.add(encoded);
      }
    }
  }

  const ordered = [...literals].sort((a, b) => b.length - a.length);
  for (const secret of ordered) {
    text = text.replaceAll(secret, "[REDACTED]");
  }
  if (sensitive.credentials) {
    for (const part of [sensitive.credentials.username, sensitive.credentials.password]) {
      if (typeof part === "string" && part.length > 0 && part.length < 4) {
        const boundary = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(part)}(?![A-Za-z0-9_])`, "g");
        text = text.replace(boundary, "[REDACTED]");
      }
    }
  }
  return text;
}

export function sanitizePoolProxyError(error, config, credentials) {
  const urls = Array.isArray(config?.proxy?.pool) ? config.proxy.pool.map((entry) => entry.server) : [];
  const literals = Array.isArray(config?.proxy?.pool)
    ? config.proxy.pool.map((entry) => entry.credentialsFile).filter(Boolean)
    : [];
  literals.push("proxies.txt");
  const privateEntries = proxySecrets.get(config?.proxy)?.values() ?? [];
  let text = redactSecrets(error, { urls, literals, credentials });
  for (const entry of privateEntries) {
    text = redactSecrets(text, { urls: [entry.server], literals: entry.redactionLiterals, credentials: entry.credentials });
  }
  return text;
}

function openDirNoFollow(dirPath) {
  assertStrictOpenSupport();
  return fs.openSync(dirPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}

function assertDirModeAndOwner(fd, dirPath, { requirePrivate = true } = {}) {
  const st = fs.fstatSync(fd);
  if (!st.isDirectory()) {
    throw new BrowserSessionError(`expected directory at ${path.basename(dirPath)}`);
  }
  if (st.uid !== ownUid()) {
    throw new BrowserSessionError(`directory ownership mismatch at ${path.basename(dirPath)}`);
  }
  const badMask = requirePrivate ? 0o077 : 0o022;
  if ((st.mode & badMask) !== 0) {
    throw new BrowserSessionError(
      `directory permissions too open at ${path.basename(dirPath)}; expected ${requirePrivate ? "0700" : "non-group/world-writable"}`
    );
  }
  return st;
}

function verifyExistingDirNoFollow(dirPath, options = {}) {
  const fd = openDirNoFollow(dirPath);
  try {
    return assertDirModeAndOwner(fd, dirPath, options);
  } finally {
    fs.closeSync(fd);
  }
}

function ensurePrivateDirectory(dirPath) {
  assertStrictOpenSupport();
  try {
    return verifyExistingDirNoFollow(dirPath, { requirePrivate: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try { fs.mkdirSync(dirPath, { mode: 0o700 }); }
    catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
    return verifyExistingDirNoFollow(dirPath, { requirePrivate: true });
  }
}

function ensureConfigBaseDir(configDir, { createIfMissing = false } = {}) {
  assertStrictOpenSupport();
  if (!configDir || typeof configDir !== "string") {
    throw new BrowserSessionError("PROMETHEUS_CONFIG_DIR is required for proxy sessions");
  }
  let stat;
  try {
    stat = verifyExistingDirNoFollow(configDir, { requirePrivate: false });
  } catch (error) {
    if (error.code === "ENOENT" && createIfMissing) {
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
      stat = verifyExistingDirNoFollow(configDir, { requirePrivate: false });
    } else if (error.code === "ENOENT") {
      throw new BrowserSessionError("PROMETHEUS_CONFIG_DIR does not exist");
    } else {
      throw error;
    }
  }
  return stat;
}

function ensureSessionsLayout(configDir, { create = false } = {}) {
  ensureConfigBaseDir(configDir, { createIfMissing: create });
  const sessionsDir = path.join(configDir, PROXY_SESSIONS_DIR);
  if (create) {
    ensurePrivateDirectory(sessionsDir);
    ensurePrivateDirectory(path.join(sessionsDir, OWNERS_DIR));
    ensurePrivateDirectory(path.join(sessionsDir, HANDOFFS_DIR));
  } else {
    verifyExistingDirNoFollow(sessionsDir, { requirePrivate: true });
  }
  return {
    sessionsDir,
    registryPath: path.join(sessionsDir, REGISTRY_FILE),
    registryLockPath: path.join(sessionsDir, REGISTRY_LOCK),
    reclaimLockPath: path.join(sessionsDir, RECLAIM_LOCK),
    ownersDir: path.join(sessionsDir, OWNERS_DIR),
    handoffsDir: path.join(sessionsDir, HANDOFFS_DIR),
    handoffSecretPath: path.join(sessionsDir, HANDOFF_SECRET_FILE),
  };
}

function readPrivateFileNoFollow(filePath, { maxBytes = MAX_CREDENTIAL_FILE_BYTES, requireSingleLink = true } = {}) {
  assertStrictOpenSupport();
  const nonBlock = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
  let fd;
  try {
    fd = fs.openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | nonBlock);
  } catch (error) {
    if (error.code === "ELOOP") {
      throw new BrowserSessionError(`refusing symlink file ${path.basename(filePath)}`);
    }
    throw error;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      throw new BrowserSessionError(`refusing non-regular file ${path.basename(filePath)}`);
    }
    if (requireSingleLink && st.nlink !== 1) {
      throw new BrowserSessionError(`refusing hardlinked private file ${path.basename(filePath)}`);
    }
    if (st.uid !== ownUid()) {
      throw new BrowserSessionError(`ownership mismatch on private file ${path.basename(filePath)}`);
    }
    if ((st.mode & 0o077) !== 0) {
      throw new BrowserSessionError(`permissions too open on private file ${path.basename(filePath)}; expected 0600`);
    }
    if (st.size > maxBytes) {
      throw new BrowserSessionError(`private file ${path.basename(filePath)} exceeds size limit`);
    }
    const buf = fs.readFileSync(fd);
    if (buf.length > maxBytes) {
      throw new BrowserSessionError(`private file ${path.basename(filePath)} exceeds size limit`);
    }
    return { content: buf.toString("utf8"), stat: st };
  } finally {
    fs.closeSync(fd);
  }
}

export function readProxyCredentials(configDir, credentialsFile) {
  const segments = assertValidRelativeCredentialPath(credentialsFile);
  assertStrictOpenSupport();
  if (!configDir || typeof configDir !== "string") {
    throw new BrowserSessionError("PROMETHEUS_CONFIG_DIR is required to load proxy credentials");
  }

  const heldDirFds = [];
  const dirExpectations = [];
  try {
    const rootFd = openDirNoFollow(configDir);
    heldDirFds.push(rootFd);
    const rootStat = assertDirModeAndOwner(rootFd, configDir, { requirePrivate: segments.length === 1 });
    const rootReal = fs.realpathSync(configDir);
    const rootRealStat = fs.lstatSync(rootReal);
    if (rootRealStat.dev !== rootStat.dev || rootRealStat.ino !== rootStat.ino) {
      throw new BrowserSessionError("PROMETHEUS_CONFIG_DIR resolved inconsistently");
    }

    let currentPath = configDir;
    let currentReal = rootReal;
    const dirSegments = segments.slice(0, -1);
    for (const seg of dirSegments) {
      currentPath = path.join(currentPath, seg);
      currentReal = path.join(currentReal, seg);
      let dirFd;
      try {
        dirFd = openDirNoFollow(currentPath);
      } catch (error) {
        if (error.code === "ELOOP" || error.code === "ENOTDIR") {
          let isLink = false;
          try { isLink = fs.lstatSync(currentPath).isSymbolicLink(); } catch {}
          throw new BrowserSessionError(
            isLink
              ? "refusing symlink directory in credentialsFile path"
              : "refusing non-directory component in credentialsFile path"
          );
        }
        throw new BrowserSessionError(`unable to open private credentials directory (${error.code || "error"})`);
      }
      heldDirFds.push(dirFd);
      const st = assertDirModeAndOwner(dirFd, currentPath, { requirePrivate: true });
      dirExpectations.push({ fd: dirFd, realPath: currentReal, dev: st.dev, ino: st.ino });
    }

    const leafPath = path.join(currentPath, segments[segments.length - 1]);
    const leafRealExpected = path.join(currentReal, segments[segments.length - 1]);
    const nonBlock = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
    let fileFd;
    try {
      fileFd = fs.openSync(leafPath, constants.O_RDONLY | constants.O_NOFOLLOW | nonBlock);
    } catch (error) {
      if (error.code === "ELOOP") {
        throw new BrowserSessionError("refusing symlink credentialsFile");
      }
      throw new BrowserSessionError(`unable to open proxy credentialsFile (${error.code || "error"})`);
    }

    try {
      const leafStat = fs.fstatSync(fileFd);
      if (!leafStat.isFile()) {
        throw new BrowserSessionError("proxy credentialsFile must be a regular file");
      }
      if (leafStat.nlink !== 1) {
        throw new BrowserSessionError("refusing hardlinked proxy credentialsFile");
      }
      if (leafStat.uid !== ownUid()) {
        throw new BrowserSessionError("proxy credentialsFile ownership mismatch");
      }
      if ((leafStat.mode & 0o077) !== 0) {
        throw new BrowserSessionError("proxy credentialsFile must have 0600 permissions");
      }
      if (leafStat.size > MAX_CREDENTIAL_FILE_BYTES) {
        throw new BrowserSessionError("proxy credentialsFile exceeds maximum allowed size");
      }

      // Re-verify held directories and canonical path while keeping all FDs open to defeat path-swap races.
      const resolvedLeaf = fs.realpathSync(leafPath);
      if (resolvedLeaf !== leafRealExpected) {
        throw new BrowserSessionError("proxy credentialsFile path changed during open");
      }
      const resolvedLeafStat = fs.lstatSync(resolvedLeaf);
      if (resolvedLeafStat.dev !== leafStat.dev || resolvedLeafStat.ino !== leafStat.ino) {
        throw new BrowserSessionError("proxy credentialsFile target changed during verification");
      }
      for (const expected of dirExpectations) {
        const reStat = fs.fstatSync(expected.fd);
        const pathStat = fs.lstatSync(expected.realPath);
        if ((reStat.mode & 0o077) !== 0 || pathStat.dev !== expected.dev || pathStat.ino !== expected.ino) {
          throw new BrowserSessionError("proxy credentials directory changed during verification");
        }
      }

      const raw = fs.readFileSync(fileFd, "utf8");
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new BrowserSessionError("proxy credentialsFile contains invalid JSON");
      }
      if (!isPlainObject(parsed)) {
        throw new BrowserSessionError("proxy credentialsFile must contain a JSON object");
      }
      assertExactAllowedKeys(parsed, CREDENTIAL_KEYS, "proxy credentials");
      if (
        typeof parsed.username !== "string" ||
        !parsed.username ||
        /[\r\n\0:]/.test(parsed.username) ||
        typeof parsed.password !== "string" ||
        !parsed.password ||
        /[\r\n\0]/.test(parsed.password)
      ) {
        throw new BrowserSessionError("proxy credentialsFile must contain valid non-empty username and password strings");
      }
      return { username: parsed.username, password: parsed.password };
    } finally {
      fs.closeSync(fileFd);
    }
  } finally {
    for (const fd of heldDirFds) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function getBootId() {
  if (process.platform === "linux") {
    try {
      return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    try {
      return execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootuuid"], { encoding: "utf8", timeout: 2000 }).trim();
    } catch {
      return null;
    }
  }
  return null;
}

function parseLinuxProcStartSignature(pid) {
  const statRaw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const rparen = statRaw.lastIndexOf(")");
  if (rparen === -1) throw new Error("malformed proc stat");
  const after = statRaw.slice(rparen + 2).trim().split(/\s+/);
  const state = after[0];
  const starttime = after[19];
  if (!starttime || !/^\d+$/.test(starttime)) throw new Error("missing proc starttime");
  const statusRaw = fs.readFileSync(`/proc/${pid}/status`, "utf8");
  const uidLine = statusRaw.split("\n").find((line) => line.startsWith("Uid:"));
  if (!uidLine) throw new Error("missing proc Uid");
  const uidParts = uidLine.replace(/^Uid:\s*/, "").trim().split(/\s+/);
  const realUid = Number(uidParts[0]);
  if (!Number.isInteger(realUid)) throw new Error("invalid proc Uid");
  return { zombie: state === "Z", uid: realUid, startSignature: `linux:${realUid}:${starttime}` };
}

function execBinaryWithFallback(candidates, args, options) {
  let lastError;
  for (const bin of candidates) {
    try {
      return execFileSync(bin, args, options);
    } catch (error) {
      if (error.code === "ENOENT") {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

function parseDarwinPsIdentity(pid) {
  const stdout = execBinaryWithFallback(
    ["ps", "/bin/ps"],
    ["-p", String(pid), "-o", "state=", "-o", "uid=", "-o", "lstart=", "-o", "comm="],
    { encoding: "utf8", timeout: 3000 }
  );
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw Object.assign(new Error("ps returned empty"), { emptyPs: true });
  }
  const normalized = trimmed.replace(/\s+/g, " ");
  const parts = normalized.split(" ");
  if (parts.length < 8) {
    throw new Error("unexpected ps output");
  }
  const procState = parts[0];
  const uid = Number(parts[1]);
  const lstart = parts.slice(2, 7).join(" ");
  const comm = parts.slice(7).join(" ");
  if (!procState || !Number.isInteger(uid) || !lstart || !comm) {
    throw new Error("incomplete ps identity");
  }
  return { zombie: procState.startsWith("Z"), uid, startSignature: `darwin:${uid}:${lstart}:${comm}` };
}

function currentProcessIdentity() {
  const uid = ownUid();
  const pid = process.pid;
  const bootId = getBootId();
  if (process.platform === "linux") {
    const info = parseLinuxProcStartSignature(pid);
    return { pid, uid: info.uid, startSignature: info.startSignature, bootId };
  }
  if (process.platform === "darwin") {
    const info = parseDarwinPsIdentity(pid);
    return { pid, uid: info.uid, startSignature: info.startSignature, bootId };
  }
  throw new BrowserSessionError(`unsupported platform for non-reusable process identity: ${process.platform}`);
}

function isPidRunning(pid) {
  try {
    process.kill(pid, 0);
    return { running: true };
  } catch (error) {
    if (error.code === "ESRCH") return { running: false };
    return { running: "ambiguous", code: error.code || "UNKNOWN" };
  }
}

function checkOpenInodeOnLinux(pid, expectedInoStr) {
  const fdDir = `/proc/${pid}/fd`;
  let entries;
  try {
    entries = fs.readdirSync(fdDir);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") {
      return { status: "dead" };
    }
    return { status: "ambiguous", reason: `unable to inspect ${fdDir}: ${error.code || error.message}` };
  }
  for (const entry of entries) {
    try {
      const st = fs.statSync(path.join(fdDir, entry));
      if (String(st.ino) === expectedInoStr) {
        return { status: "open" };
      }
    } catch {}
  }
  return { status: "not-open" };
}

function checkOpenInodeOnDarwin(pid, expectedInoStr) {
  let stdout = "";
  try {
    stdout = execBinaryWithFallback(
      ["lsof", "/usr/sbin/lsof"],
      ["-a", "-p", String(pid), "-Fi"],
      { encoding: "utf8", timeout: 4000 }
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      return { status: "ambiguous", reason: "lsof unavailable to verify holder FD" };
    }
    const probe = isPidRunning(pid);
    if (probe.running === false) {
      return { status: "dead" };
    }
    try {
      const again = parseDarwinPsIdentity(pid);
      if (again.zombie) return { status: "dead" };
    } catch (psErr) {
      if (psErr.emptyPs) return { status: "dead" };
    }
    return { status: "ambiguous", reason: `lsof failed checking lock holder (${error.message})` };
  }
  const lines = stdout.split(/\r?\n/);
  if (!lines.includes(`p${pid}`)) {
    const probe = isPidRunning(pid);
    if (probe.running === false) {
      return { status: "dead" };
    }
    try {
      const again = parseDarwinPsIdentity(pid);
      if (again.zombie) return { status: "dead" };
    } catch (psErr) {
      if (psErr.emptyPs) return { status: "dead" };
    }
    return { status: "ambiguous", reason: "lsof output did not include target pid" };
  }
  if (lines.includes(`i${expectedInoStr}`)) {
    return { status: "open" };
  }
  return { status: "not-open" };
}

function recordStillMatchesInode(recordPath, expectedInoStr) {
  try {
    const afterStat = fs.lstatSync(recordPath);
    return String(afterStat.ino) === expectedInoStr;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    return null;
  }
}

function classifyRecordLiveness(recordPath) {
  assertStrictOpenSupport();
  let rawRead;
  try {
    rawRead = readPrivateFileNoFollow(recordPath, { maxBytes: 16 * 1024, requireSingleLink: false });
  } catch (error) {
    if (error.code === "ENOENT") return { status: "missing" };
    return { status: "ambiguous", reason: error.message };
  }

  let record;
  try {
    record = JSON.parse(rawRead.content);
  } catch {
    return { status: "ambiguous", reason: `corrupt lock/owner JSON in ${path.basename(recordPath)}` };
  }
  if (
    !isPlainObject(record) ||
    !Number.isInteger(record.pid) ||
    record.pid <= 0 ||
    !Number.isInteger(record.uid) ||
    typeof record.startSignature !== "string" ||
    !record.startSignature ||
    typeof record.token !== "string" ||
    !record.token ||
    record.ino === undefined
  ) {
    return { status: "ambiguous", reason: `invalid lock/owner schema in ${path.basename(recordPath)}` };
  }
  if (record.uid !== ownUid()) {
    return { status: "ambiguous", reason: "lock/owner uid mismatch" };
  }

  const inoStr = String(rawRead.stat.ino);
  if (String(record.ino) !== inoStr) {
    return { status: "ambiguous", reason: "lock/owner inode does not match recorded inode" };
  }

  if (record.pid === process.pid && activeLocalTokens.has(record.token)) {
    return { status: "alive", record, ino: rawRead.stat.ino };
  }

  const currentBootId = getBootId();
  if (record.bootId && currentBootId && record.bootId !== currentBootId) {
    return { status: "dead", record, ino: rawRead.stat.ino };
  }

  const pidCheck = isPidRunning(record.pid);
  if (pidCheck.running === false) {
    return { status: "dead", record, ino: rawRead.stat.ino };
  }
  if (pidCheck.running === "ambiguous") {
    return { status: "ambiguous", reason: `unable to probe pid ${record.pid} (${pidCheck.code})` };
  }

  if (process.platform === "linux") {
    let live;
    try {
      live = parseLinuxProcStartSignature(record.pid);
    } catch (error) {
      if (recordStillMatchesInode(recordPath, inoStr) === false) return { status: "missing" };
      if (error.code === "ENOENT" || error.code === "ESRCH") {
        return { status: "dead", record, ino: rawRead.stat.ino };
      }
      return { status: "ambiguous", reason: `unable to read proc identity for pid ${record.pid}` };
    }
    if (live.zombie || live.uid !== record.uid || live.startSignature !== record.startSignature) {
      return { status: "dead", record, ino: rawRead.stat.ino };
    }
    const fdCheck = checkOpenInodeOnLinux(record.pid, inoStr);
    if (fdCheck.status === "open") return { status: "alive", record, ino: rawRead.stat.ino };
    const unchanged = recordStillMatchesInode(recordPath, inoStr);
    if (unchanged === false) return { status: "missing" };
    if (unchanged === null) return { status: "ambiguous", reason: "unable to re-stat record during liveness check" };
    if (fdCheck.status === "dead" || fdCheck.status === "not-open") {
      return { status: "dead", record, ino: rawRead.stat.ino };
    }
    return fdCheck;
  }

  if (process.platform === "darwin") {
    let live;
    try {
      live = parseDarwinPsIdentity(record.pid);
    } catch (error) {
      if (recordStillMatchesInode(recordPath, inoStr) === false) return { status: "missing" };
      if (error.emptyPs) {
        const again = isPidRunning(record.pid);
        if (again.running === false) return { status: "dead", record, ino: rawRead.stat.ino };
      }
      return { status: "ambiguous", reason: `unable to verify darwin ps identity for pid ${record.pid}` };
    }
    if (live.zombie || live.uid !== record.uid || live.startSignature !== record.startSignature) {
      return { status: "dead", record, ino: rawRead.stat.ino };
    }
    const fdCheck = checkOpenInodeOnDarwin(record.pid, inoStr);
    if (fdCheck.status === "open") return { status: "alive", record, ino: rawRead.stat.ino };
    const unchanged = recordStillMatchesInode(recordPath, inoStr);
    if (unchanged === false) return { status: "missing" };
    if (unchanged === null) return { status: "ambiguous", reason: "unable to re-stat record during liveness check" };
    if (fdCheck.status === "dead" || fdCheck.status === "not-open") {
      return { status: "dead", record, ino: rawRead.stat.ino };
    }
    return fdCheck;
  }

  return { status: "ambiguous", reason: `unsupported platform ${process.platform}` };
}

function acquireAtomicLinkRecord(targetPath, metadata) {
  assertStrictOpenSupport();
  const dir = path.dirname(targetPath);
  ensurePrivateDirectory(dir);
  const token = crypto.randomBytes(16).toString("hex");
  const tmpPath = `${targetPath}.tmp.${process.pid}.${token}`;
  const proc = currentProcessIdentity();
  let fd;
  try {
    fd = fs.openSync(tmpPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
    const st = fs.fstatSync(fd);
    const payload = {
      ...metadata,
      token,
      pid: proc.pid,
      uid: proc.uid,
      startSignature: proc.startSignature,
      bootId: proc.bootId,
      ino: String(st.ino),
      acquiredAt: new Date().toISOString(),
    };
    const encoded = JSON.stringify(payload, null, 2) + "\n";
    fs.writeFileSync(fd, encoded, "utf8");
    fs.fsyncSync(fd);
    try {
      fs.linkSync(tmpPath, targetPath);
    } catch (error) {
      if (error.code === "EEXIST") {
        fs.closeSync(fd);
        fd = null;
        return { acquired: false };
      }
      throw error;
    }
    activeLocalTokens.add(token);
    const heldIno = st.ino;
    const heldFd = fd;
    fd = null;
    let released = false;
    return {
      acquired: true,
      token,
      ino: heldIno,
      release() {
        if (released) return;
        released = true;
        activeLocalTokens.delete(token);
        try {
          const cur = fs.lstatSync(targetPath);
          if (cur.ino === heldIno) {
            fs.unlinkSync(targetPath);
          }
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        } finally {
          try {
            fs.closeSync(heldFd);
          } catch {}
        }
      },
    };
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
    if (fd !== null && fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function tryReclaimDeadLockFile(lockPath, reclaimLockPath) {
  const outer = acquireAtomicLinkRecord(reclaimLockPath, { kind: "reclaim-lock" });
  if (!outer.acquired) {
    // Wait briefly if another process is actively reclaiming; never blindly delete reclaim.lock unless stale.
    const reclaimLiveness = classifyRecordLiveness(reclaimLockPath);
    if (reclaimLiveness.status === "ambiguous") {
      throw new BrowserSessionError(`ambiguous reclaim lock state: ${reclaimLiveness.reason}`);
    }
    if (reclaimLiveness.status === "dead") {
      try {
        const cur = fs.lstatSync(reclaimLockPath);
        if (cur.ino === reclaimLiveness.ino) fs.unlinkSync(reclaimLockPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return false;
  }
  try {
    const state = classifyRecordLiveness(lockPath);
    if (state.status === "missing") return true;
    if (state.status === "alive") return false;
    if (state.status === "ambiguous") {
      throw new BrowserSessionError(`ambiguous proxy registry lock; refusing unsafe cleanup (${state.reason})`);
    }
    const current = fs.lstatSync(lockPath);
    if (current.ino === state.ino) {
      fs.unlinkSync(lockPath);
      return true;
    }
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  } finally {
    outer.release();
  }
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRegistryLock(configDir, fn, { timeoutMs = DEFAULT_LOCK_TIMEOUT_MS } = {}) {
  const layout = ensureSessionsLayout(configDir, { create: true });
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const attempt = acquireAtomicLinkRecord(layout.registryLockPath, { kind: "registry-lock" });
    if (attempt.acquired) {
      try {
        return await fn(layout);
      } finally {
        attempt.release();
      }
    }

    const liveness = classifyRecordLiveness(layout.registryLockPath);
    if (liveness.status === "ambiguous") {
      throw new BrowserSessionError(`ambiguous proxy registry lock; failing closed (${liveness.reason})`);
    }
    if (liveness.status === "dead") {
      tryReclaimDeadLockFile(layout.registryLockPath, layout.reclaimLockPath);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new BrowserSessionError("timed out waiting for proxy session registry lock");
    }
    const remaining = Math.max(1, deadline - Date.now());
    await sleepMs(Math.min(remaining, 10 + Math.floor(Math.random() * 15)));
  }
}

function validateSessionRecordShape(name, rec) {
  try {
    assertValidName(name);
  } catch {
    throw new BrowserSessionError("corrupt proxy registry: invalid session name");
  }
  if (!isPlainObject(rec)) {
    throw new BrowserSessionError(`corrupt proxy registry: session '${name}' is not an object`);
  }
  assertExactAllowedKeys(rec, SESSION_RECORD_KEYS, `session '${name}'`);
  if (!Number.isInteger(rec.generation) || rec.generation < 1) {
    throw new BrowserSessionError(`corrupt proxy registry: invalid generation on session '${name}'`);
  }
  try {
    assertValidName(rec.proxyId);
  } catch {
    throw new BrowserSessionError(`corrupt proxy registry: invalid proxyId on session '${name}'`);
  }
  if (typeof rec.endpointFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(rec.endpointFingerprint)) {
    throw new BrowserSessionError(`corrupt proxy registry: invalid endpointFingerprint on session '${name}'`);
  }
  if (!Array.isArray(rec.authRecords)) {
    throw new BrowserSessionError(`corrupt proxy registry: authRecords must be an array on session '${name}'`);
  }
  for (const authName of rec.authRecords) {
    try {
      assertValidName(authName);
    } catch {
      throw new BrowserSessionError(`corrupt proxy registry: invalid auth record name on session '${name}'`);
    }
  }
  if (typeof rec.createdAt !== "string" || !rec.createdAt) {
    throw new BrowserSessionError(`corrupt proxy registry: invalid createdAt on session '${name}'`);
  }
  if (rec.rotatedAt !== null && (typeof rec.rotatedAt !== "string" || !rec.rotatedAt)) {
    throw new BrowserSessionError(`corrupt proxy registry: invalid rotatedAt on session '${name}'`);
  }
}

function emptyRegistry() {
  return {
    version: 1,
    nextProxyId: null,
    sessions: {},
  };
}

function readRegistryStrict(registryPath) {
  let raw;
  try {
    raw = readPrivateFileNoFollow(registryPath, { maxBytes: MAX_REGISTRY_FILE_BYTES, requireSingleLink: true });
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, registry: emptyRegistry() };
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.content);
  } catch {
    throw new BrowserSessionError("corrupt proxy session registry JSON; refusing to auto-reset");
  }
  if (!isPlainObject(parsed)) {
    throw new BrowserSessionError("corrupt proxy session registry root; refusing to auto-reset");
  }
  assertExactAllowedKeys(parsed, REGISTRY_KEYS, "registry");
  if (parsed.version !== 1) {
    throw new BrowserSessionError(`unsupported proxy session registry version: ${parsed.version}`);
  }
  if (parsed.nextProxyId !== null) {
    try {
      assertValidName(parsed.nextProxyId);
    } catch {
      throw new BrowserSessionError("corrupt proxy session registry nextProxyId; refusing to auto-reset");
    }
  }
  if (!isPlainObject(parsed.sessions)) {
    throw new BrowserSessionError("corrupt proxy session registry sessions map; refusing to auto-reset");
  }
  for (const [name, rec] of Object.entries(parsed.sessions)) {
    validateSessionRecordShape(name, rec);
  }
  return { exists: true, registry: parsed };
}

function writeRegistryAtomic(layout, registry) {
  const dir = layout.sessionsDir;
  ensurePrivateDirectory(dir);
  const token = crypto.randomBytes(12).toString("hex");
  const tmpPath = path.join(dir, `${REGISTRY_FILE}.tmp.${process.pid}.${token}`);
  const payload = JSON.stringify(registry, null, 2) + "\n";
  let fd;
  try {
    fd = fs.openSync(tmpPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, layout.registryPath);
    const dirFd = openDirNoFollow(dir);
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch (error) {
    if (fd !== null && fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
    throw error;
  }
}

export function sanitizeSessionView(sessionName, record, extra = {}) {
  return {
    session: sessionName,
    generation: record.generation,
    proxyId: record.proxyId,
    authRecords: [...record.authRecords],
    ...extra,
  };
}

function selectAndAdvanceRoundRobin(registry, pool) {
  let idx = 0;
  if (registry.nextProxyId !== null) {
    idx = pool.findIndex((entry) => entry.id === registry.nextProxyId);
    if (idx === -1) {
      throw new BrowserSessionError(
        `round-robin cursor '${registry.nextProxyId}' references a removed proxy pool entry; run reconcile-cursor before allocating or rotating`
      );
    }
  }
  const chosen = pool[idx];
  const next = pool[(idx + 1) % pool.length];
  registry.nextProxyId = next.id;
  return chosen;
}

function assertPinnedSessionMatchesPool(sessionName, record, pool) {
  const entry = pool.find((item) => item.id === record.proxyId);
  if (!entry) {
    throw new BrowserSessionError(
      `session '${sessionName}' pinned proxy '${record.proxyId}' is no longer in pool; rotate or run reconcile-session`
    );
  }
  const fp = fingerprintEndpoint(entry.server);
  if (fp !== record.endpointFingerprint) {
    throw new BrowserSessionError(
      `configured endpoint changed for session '${sessionName}' pinned proxy '${record.proxyId}'; rotate or run reconcile-session`
    );
  }
  return entry;
}

function sessionOwnerPaths(layout, session) {
  const dir = path.join(layout.ownersDir, session);
  return {
    sessionDir: dir,
    taskPath: path.join(dir, "task.json"),
    helpersDir: path.join(dir, "helpers"),
  };
}

function inspectAndPruneHelpers(helpersDir, { expectedGeneration = null, failOnActive = false, failOnGenerationMismatch = false } = {}) {
  let entries = [];
  try {
    verifyExistingDirNoFollow(helpersDir, { requirePrivate: true });
    entries = fs.readdirSync(helpersDir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const activeHelpers = [];
  for (const name of entries) {
    if (name.includes(".tmp.")) {
      // Ignore transient atomic link temp file only if empty? No, fail closed on unexpected files if corrupt, or wait:
      // temp files created in this dir follow `.json.tmp.<pid>.<tok>`. Only non-tmp .json files are active helpers.
      continue;
    }
    const helperPath = path.join(helpersDir, name);
    const state = classifyRecordLiveness(helperPath);
    if (state.status === "missing") continue;
    if (state.status === "ambiguous") {
      throw new BrowserSessionError(`ambiguous login helper ownership state: ${state.reason}`);
    }
    if (state.status === "dead") {
      try {
        const st = fs.lstatSync(helperPath);
        if (st.ino === state.ino) fs.unlinkSync(helperPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      continue;
    }
    if (failOnActive) {
      throw new BrowserSessionError("cannot modify or rotate session while a login helper is active");
    }
    if (failOnGenerationMismatch && expectedGeneration !== null && state.record.generation !== expectedGeneration) {
      throw new BrowserSessionError("active login helper belongs to a different session generation");
    }
    activeHelpers.push(state.record);
  }
  return activeHelpers;
}

function inspectSessionOwners(layout, session, options = {}) {
  const paths = sessionOwnerPaths(layout, session);
  let taskOwner = null;
  try {
    verifyExistingDirNoFollow(paths.sessionDir, { requirePrivate: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return { taskOwner: null, activeHelpers: [], paths };
    }
    throw error;
  }

  const taskState = classifyRecordLiveness(paths.taskPath);
  if (taskState.status === "ambiguous") {
    throw new BrowserSessionError(`ambiguous task ownership state for session '${session}': ${taskState.reason}`);
  }
  if (taskState.status === "dead") {
    try {
      const st = fs.lstatSync(paths.taskPath);
      if (st.ino === taskState.ino) fs.unlinkSync(paths.taskPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  } else if (taskState.status === "alive") {
    if (options.failOnActiveTask) {
      throw new BrowserSessionError(`session '${session}' already has an active browser task owner`);
    }
    taskOwner = taskState.record;
  }

  const activeHelpers = inspectAndPruneHelpers(paths.helpersDir, {
    expectedGeneration: options.expectedGeneration ?? null,
    failOnActive: options.failOnActiveHelper ?? false,
    failOnGenerationMismatch: options.failOnHelperGenerationMismatch ?? false,
  });

  return { taskOwner, activeHelpers, paths };
}

export function hasActiveSessionOwners(configDir) {
  let layout;
  try {
    layout = ensureSessionsLayout(configDir, { create: false });
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof BrowserSessionError && error.message.includes("does not exist")) {
      return false;
    }
    throw error;
  }
  let sessionDirs = [];
  try {
    verifyExistingDirNoFollow(layout.ownersDir, { requirePrivate: true });
    sessionDirs = fs.readdirSync(layout.ownersDir);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  for (const session of sessionDirs) {
    assertValidName(session);
    const { taskOwner, activeHelpers } = inspectSessionOwners(layout, session);
    if (taskOwner || activeHelpers.length > 0) return true;
  }
  return false;
}

function getOrCreateHandoffKey(layout) {
  assertStrictOpenSupport();
  try {
    const existing = readPrivateFileNoFollow(layout.handoffSecretPath, { maxBytes: 256, requireSingleLink: true });
    const trimmed = existing.content.trim();
    if (!/^[0-9a-f]{64}$/.test(trimmed)) {
      throw new BrowserSessionError("corrupt handoff signing secret");
    }
    return Buffer.from(trimmed, "hex");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const keyHex = crypto.randomBytes(32).toString("hex");
    const fd = fs.openSync(layout.handoffSecretPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      fs.writeFileSync(fd, keyHex + "\n", "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return Buffer.from(keyHex, "hex");
  }
}

function canonicalHandoffSigningInput(payload) {
  return JSON.stringify({
    version: payload.version,
    handoffId: payload.handoffId,
    session: payload.session,
    generation: payload.generation,
    proxyId: payload.proxyId,
    endpointFingerprint: payload.endpointFingerprint,
    ownerId: payload.ownerId,
    nonce: payload.nonce,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    expiresAtMs: payload.expiresAtMs,
  });
}

function signHandoffPayload(key, payload) {
  return crypto.createHmac("sha256", key).update(canonicalHandoffSigningInput(payload), "utf8").digest("hex");
}

function verifyHandoffSignature(key, payload) {
  if (typeof payload.sig !== "string" || !/^[0-9a-f]{64}$/.test(payload.sig)) return false;
  const expected = Buffer.from(signHandoffPayload(key, payload), "hex");
  const actual = Buffer.from(payload.sig, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export async function createSession(configDir, rawConfig, { session } = {}) {
  const proxy = resolveProxyConfig(configDir, rawConfig?.proxy);
  const targetSession = session ?? proxy.session;
  try {
    assertValidName(targetSession);
  } catch {
    throw new BrowserSessionError("invalid session name");
  }

  return await withRegistryLock(configDir, (layout) => {
    const { registry } = readRegistryStrict(layout.registryPath);
    if (registry.sessions[targetSession]) {
      throw new BrowserSessionError(`proxy session '${targetSession}' already exists`);
    }
    const chosen = selectAndAdvanceRoundRobin(registry, proxy.pool);
    const record = {
      generation: 1,
      proxyId: chosen.id,
      endpointFingerprint: fingerprintEndpoint(chosen.server),
      authRecords: [],
      createdAt: new Date().toISOString(),
      rotatedAt: null,
    };
    registry.sessions[targetSession] = record;
    writeRegistryAtomic(layout, registry);
    return sanitizeSessionView(targetSession, record);
  });
}

export function listSessions(configDir) {
  let layout;
  try {
    layout = ensureSessionsLayout(configDir, { create: false });
  } catch (error) {
    if (error.code === "ENOENT" || (error instanceof BrowserSessionError && error.message.includes("does not exist"))) {
      return { nextProxyId: null, sessions: [] };
    }
    throw error;
  }
  const { registry } = readRegistryStrict(layout.registryPath);
  const sessions = Object.keys(registry.sessions)
    .sort()
    .map((name) => sanitizeSessionView(name, registry.sessions[name]));
  return {
    nextProxyId: registry.nextProxyId,
    sessions,
  };
}

export function showSession(configDir, sessionName) {
  try {
    assertValidName(sessionName);
  } catch {
    throw new BrowserSessionError("invalid session name");
  }
  const layout = ensureSessionsLayout(configDir, { create: false });
  const { registry } = readRegistryStrict(layout.registryPath);
  const record = registry.sessions[sessionName];
  if (!record) {
    throw new BrowserSessionError(`proxy session '${sessionName}' not found`);
  }
  const { taskOwner, activeHelpers } = inspectSessionOwners(layout, sessionName);
  return sanitizeSessionView(sessionName, record, {
    activeTaskOwner: Boolean(taskOwner),
    activeHelperCount: activeHelpers.length,
  });
}

// Diagnostics must not acquire locks or call the ownership inspectors that prune
// dead records. Return only fixed status codes, never raw filesystem errors,
// owner records, endpoints, paths, or credential values.
function diagnoseSessionOwners(layout, session, generation) {
  const paths = sessionOwnerPaths(layout, session);
  const counts = { alive: 0, dead: 0, ambiguous: 0 };
  let task = "missing";
  const classify = (file) => {
    const state = classifyRecordLiveness(file);
    if (state.status === "alive" && (state.record.session !== session || state.record.generation !== generation)) {
      return "ambiguous";
    }
    return state.status;
  };
  try {
    verifyExistingDirNoFollow(layout.ownersDir, { requirePrivate: true });
    verifyExistingDirNoFollow(paths.sessionDir, { requirePrivate: true });
    task = classify(paths.taskPath);
    try {
      verifyExistingDirNoFollow(paths.helpersDir, { requirePrivate: true });
      for (const name of fs.readdirSync(paths.helpersDir)) {
        if (name.includes(".tmp.")) continue;
        const status = classify(path.join(paths.helpersDir, name));
        if (status !== "missing") counts[status] += 1;
      }
    } catch (error) {
      if (error.code !== "ENOENT") counts.ambiguous += 1;
    }
  } catch (error) {
    if (error.code !== "ENOENT") task = "ambiguous";
  }
  return { task, helpers: counts };
}

export function diagnoseSessions(configDir, rawConfig) {
  let proxy = validateProxyConfig(rawConfig?.proxy);
  const issues = [];
  const addIssue = (code, details = {}, severity = "error") => issues.push({ code, severity, ...details });
  const result = {
    scope: "local-only",
    selectedSession: proxy.session,
    registry: "missing",
    locks: { registry: "missing", reclaim: "missing" },
    nextProxyId: null,
    proxies: [],
    sessions: [],
    issues,
  };
  try {
    proxy = resolveProxyConfig(configDir, rawConfig?.proxy);
  } catch (error) {
    addIssue(error instanceof ProxyListError ? error.code : "proxy-list-invalid",
      error instanceof ProxyListError && error.line !== undefined ? { line: error.line } : {});
    return { ...result, ok: false };
  }

  // Read and validate credentials locally, but never retain them in the report.
  for (const entry of proxy.pool) {
    let credentials = entry.credentials ? "valid" : "not-required";
    if (entry.credentialsFile) {
      try {
        readProxyCredentials(configDir, entry.credentialsFile);
        credentials = "valid";
      } catch {
        credentials = "invalid";
        addIssue("credentials-invalid", { proxyId: entry.id });
      }
    }
    result.proxies.push({ proxyId: entry.id, credentials });
  }

  let layout;
  let registry;
  try {
    layout = ensureSessionsLayout(configDir, { create: false });
    for (const [key, file] of [["registry", layout.registryLockPath], ["reclaim", layout.reclaimLockPath]]) {
      const { status } = classifyRecordLiveness(file);
      result.locks[key] = status;
      if (status === "ambiguous") addIssue("lock-ambiguous", { lock: key });
      if (status === "alive" || status === "dead") addIssue(`lock-${status}`, { lock: key }, "warning");
    }
    const read = readRegistryStrict(layout.registryPath);
    registry = read.registry;
    result.registry = read.exists ? "valid" : "missing";
  } catch (error) {
    // ENOENT at this level means that the layout has not been created.
    result.registry = error.code === "ENOENT" ? "missing" : "invalid";
    addIssue(result.registry === "missing" ? "registry-missing" : "registry-invalid");
  }

  if (registry) {
    if (result.registry === "missing") addIssue("registry-missing");
    result.nextProxyId = registry.nextProxyId;
    if (registry.nextProxyId !== null && !proxy.pool.some((entry) => entry.id === registry.nextProxyId)) {
      addIssue("cursor-proxy-missing");
    }
    for (const session of Object.keys(registry.sessions).sort()) {
      const record = registry.sessions[session];
      const entry = proxy.pool.find((item) => item.id === record.proxyId);
      const assignment = !entry ? "proxy-missing"
        : fingerprintEndpoint(entry.server) !== record.endpointFingerprint ? "endpoint-changed" : "configured";
      if (assignment !== "configured") addIssue(assignment, { session, proxyId: record.proxyId });
      const owners = diagnoseSessionOwners(layout, session, record.generation);
      const ambiguous = owners.task === "ambiguous" || owners.helpers.ambiguous > 0;
      if (ambiguous) addIssue("ownership-ambiguous", { session });
      if (owners.task === "dead" || owners.helpers.dead > 0) addIssue("ownership-dead", { session }, "warning");
      result.sessions.push({
        session,
        generation: record.generation,
        proxyId: record.proxyId,
        assignment,
        owners,
        inactive: !ambiguous && owners.task !== "alive" && owners.helpers.alive === 0,
      });
    }
  }
  if (result.registry !== "invalid" && !registry?.sessions[proxy.session]) {
    addIssue("selected-session-missing", { session: proxy.session });
  }
  return { ...result, ok: !issues.some((issue) => issue.severity === "error") };
}

export async function bindAuthRecord(configDir, sessionName, authName, { expectedGeneration } = {}) {
  try {
    assertValidName(sessionName);
    assertValidName(authName);
  } catch {
    throw new BrowserSessionError("invalid session or auth record name");
  }
  const stateMeta = statMetadata(configDir, authName);
  if (!stateMeta) {
    throw new BrowserSessionError(`auth state record '${authName}' not found`);
  }

  return await withRegistryLock(configDir, (layout) => {
    const { exists, registry } = readRegistryStrict(layout.registryPath);
    if (!exists || !registry.sessions[sessionName]) {
      throw new BrowserSessionError(`proxy session '${sessionName}' not found`);
    }
    const record = registry.sessions[sessionName];
    if (expectedGeneration !== undefined && record.generation !== expectedGeneration) {
      throw new BrowserSessionError(`proxy session '${sessionName}' rotated before auth binding`);
    }
    if (!record.authRecords.includes(authName)) {
      record.authRecords.push(authName);
      writeRegistryAtomic(layout, registry);
    }
    return sanitizeSessionView(sessionName, record);
  });
}

export async function unbindAuthRecord(configDir, sessionName, authName) {
  try {
    assertValidName(sessionName);
    assertValidName(authName);
  } catch {
    throw new BrowserSessionError("invalid session or auth record name");
  }
  return await withRegistryLock(configDir, (layout) => {
    const { exists, registry } = readRegistryStrict(layout.registryPath);
    if (!exists || !registry.sessions[sessionName]) {
      throw new BrowserSessionError(`proxy session '${sessionName}' not found`);
    }
    const record = registry.sessions[sessionName];
    const next = record.authRecords.filter((item) => item !== authName);
    if (next.length !== record.authRecords.length) {
      record.authRecords = next;
      writeRegistryAtomic(layout, registry);
    }
    return sanitizeSessionView(sessionName, record);
  });
}

function purgePendingSessionHandoffs(layout, sessionName) {
  let files = [];
  try {
    verifyExistingDirNoFollow(layout.handoffsDir, { requirePrivate: true });
    files = fs.readdirSync(layout.handoffsDir);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const name of files) {
    if (!name.endsWith(".json") || name.includes(".tmp.")) continue;
    const p = path.join(layout.handoffsDir, name);
    try {
      const read = readPrivateFileNoFollow(p, { maxBytes: MAX_HANDOFF_FILE_BYTES, requireSingleLink: true });
      const parsed = JSON.parse(read.content);
      if (parsed?.session === sessionName || (typeof parsed?.expiresAtMs === "number" && parsed.expiresAtMs <= Date.now())) {
        fs.unlinkSync(p);
      }
    } catch {}
  }
}

export async function rotateSession(configDir, rawConfig, { session, retainAssociations = false } = {}) {
  const proxy = resolveProxyConfig(configDir, rawConfig?.proxy);
  const targetSession = session ?? proxy.session;
  try {
    assertValidName(targetSession);
  } catch {
    throw new BrowserSessionError("invalid session name");
  }

  return await withRegistryLock(configDir, (layout) => {
    const { exists, registry } = readRegistryStrict(layout.registryPath);
    if (!exists || !registry.sessions[targetSession]) {
      throw new BrowserSessionError(`proxy session '${targetSession}' not found`);
    }
    inspectSessionOwners(layout, targetSession, {
      failOnActiveTask: true,
      failOnActiveHelper: true,
    });

    const record = registry.sessions[targetSession];
    const chosen = selectAndAdvanceRoundRobin(registry, proxy.pool);
    record.generation += 1;
    record.proxyId = chosen.id;
    record.endpointFingerprint = fingerprintEndpoint(chosen.server);
    record.rotatedAt = new Date().toISOString();
    if (!retainAssociations) {
      record.authRecords = [];
    }
    purgePendingSessionHandoffs(layout, targetSession);
    writeRegistryAtomic(layout, registry);
    const warnings = retainAssociations
      ? ["retained prior auth associations across proxy rotation; different exit identities share the same auth records"]
      : [];
    return sanitizeSessionView(targetSession, record, warnings.length ? { warnings } : {});
  });
}

export async function reconcileCursor(configDir, rawConfig, { nextProxyId }) {
  const proxy = resolveProxyConfig(configDir, rawConfig?.proxy);
  try {
    assertValidName(nextProxyId);
  } catch {
    throw new BrowserSessionError("invalid nextProxyId");
  }
  if (!proxy.pool.some((entry) => entry.id === nextProxyId)) {
    throw new BrowserSessionError(`proxy id '${nextProxyId}' is not present in configured pool`);
  }

  return await withRegistryLock(configDir, (layout) => {
    const { registry } = readRegistryStrict(layout.registryPath);
    registry.nextProxyId = nextProxyId;
    writeRegistryAtomic(layout, registry);
    return { nextProxyId: registry.nextProxyId };
  });
}

export async function reconcileSession(configDir, rawConfig, { session, proxyId, retainAssociations = false } = {}) {
  const proxy = resolveProxyConfig(configDir, rawConfig?.proxy);
  const targetSession = session ?? proxy.session;
  try {
    assertValidName(targetSession);
  } catch {
    throw new BrowserSessionError("invalid session name");
  }
  if (proxyId !== undefined) {
    try {
      assertValidName(proxyId);
    } catch {
      throw new BrowserSessionError("invalid proxyId");
    }
  }

  return await withRegistryLock(configDir, (layout) => {
    const { exists, registry } = readRegistryStrict(layout.registryPath);
    if (!exists || !registry.sessions[targetSession]) {
      throw new BrowserSessionError(`proxy session '${targetSession}' not found`);
    }
    inspectSessionOwners(layout, targetSession, {
      failOnActiveTask: true,
      failOnActiveHelper: true,
    });

    const record = registry.sessions[targetSession];
    const desiredProxyId = proxyId ?? record.proxyId;
    const entry = proxy.pool.find((item) => item.id === desiredProxyId);
    if (!entry) {
      throw new BrowserSessionError(`proxy id '${desiredProxyId}' is not present in configured pool`);
    }
    const nextFp = fingerprintEndpoint(entry.server);
    const proxyChanged = record.proxyId !== entry.id;
    const endpointChanged = record.endpointFingerprint !== nextFp;
    if (proxyChanged || endpointChanged) {
      record.generation += 1;
      record.proxyId = entry.id;
      record.endpointFingerprint = nextFp;
      record.rotatedAt = new Date().toISOString();
      if (!retainAssociations) {
        record.authRecords = [];
      }
      purgePendingSessionHandoffs(layout, targetSession);
      writeRegistryAtomic(layout, registry);
    }
    const warnings = (proxyChanged || endpointChanged) && retainAssociations
      ? ["retained prior auth associations across proxy reconciliation; changed routing may require renewed verification"]
      : [];
    return sanitizeSessionView(targetSession, record, warnings.length ? { warnings } : {});
  });
}

function requirePinnedSessionLocked(layout, proxy) {
  const { exists, registry } = readRegistryStrict(layout.registryPath);
  const record = exists ? registry.sessions[proxy.session] : null;
  if (!record) {
    throw new BrowserSessionError(
      `proxy session '${proxy.session}' does not exist; create it explicitly before launch or login`
    );
  }
  const poolEntry = assertPinnedSessionMatchesPool(proxy.session, record, proxy.pool);
  return { record, poolEntry };
}

export async function acquireTaskSession(configDir, rawConfig) {
  const proxy = resolveProxyConfig(configDir, rawConfig?.proxy);
  const pinned = await withRegistryLock(configDir, (layout) => {
    const { record, poolEntry } = requirePinnedSessionLocked(layout, proxy);
    const { paths } = inspectSessionOwners(layout, proxy.session, {
      failOnActiveTask: true,
      failOnHelperGenerationMismatch: true,
      expectedGeneration: record.generation,
    });
    ensurePrivateDirectory(paths.sessionDir);
    ensurePrivateDirectory(paths.helpersDir);
    const lease = acquireAtomicLinkRecord(paths.taskPath, {
      kind: "task",
      session: proxy.session,
      generation: record.generation,
    });
    if (!lease.acquired) {
      throw new BrowserSessionError(`proxy session '${proxy.session}' already has an active browser owner`);
    }
    return {
      session: proxy.session,
      generation: record.generation,
      proxyId: record.proxyId,
      authRecords: [...record.authRecords],
      poolEntry,
      ownerId: lease.token,
      release: lease.release,
    };
  });

  // Load 0600 credentials strictly outside the registry lock so slow checks never stall other processes.
  try {
    const credentials = pinned.poolEntry.credentialsFile
      ? readProxyCredentials(configDir, pinned.poolEntry.credentialsFile)
      : pinned.poolEntry.credentials ?? null;
    return {
      session: pinned.session,
      generation: pinned.generation,
      proxyId: pinned.proxyId,
      authRecords: pinned.authRecords,
      server: pinned.poolEntry.server,
      credentials,
      ownerId: pinned.ownerId,
      release: pinned.release,
    };
  } catch (error) {
    try {
      pinned.release();
    } catch {}
    throw error;
  }
}

export function verifySessionGeneration(configDir, rawConfig, expectedGeneration) {
  const proxy = resolveProxyConfig(configDir, rawConfig?.proxy);
  const layout = ensureSessionsLayout(configDir, { create: false });
  const { exists, registry } = readRegistryStrict(layout.registryPath);
  const record = exists ? registry.sessions[proxy.session] : null;
  if (!record) {
    throw new BrowserSessionError(`proxy session '${proxy.session}' no longer exists`);
  }
  if (record.generation !== expectedGeneration) {
    throw new BrowserSessionError(`proxy session '${proxy.session}' rotated before launch`);
  }
  assertPinnedSessionMatchesPool(proxy.session, record, proxy.pool);
  return sanitizeSessionView(proxy.session, record);
}

export function verifyTaskSessionOwner(configDir, rawConfig, expectedGeneration, expectedOwnerId) {
  verifySessionGeneration(configDir, rawConfig, expectedGeneration);
  const proxy = validateProxyConfig(rawConfig?.proxy);
  const layout = ensureSessionsLayout(configDir, { create: false });
  const { taskOwner } = inspectSessionOwners(layout, proxy.session);
  if (!expectedOwnerId || !taskOwner || taskOwner.token !== expectedOwnerId || taskOwner.generation !== expectedGeneration) {
    throw new BrowserSessionError("task session ownership unavailable or changed");
  }
}

export async function issueLoginHandoff(configDir, rawConfig, { session, expectedOwnerId, expectedGeneration, ttlMs = DEFAULT_HANDOFF_TTL_MS } = {}) {
  const proxy = resolveProxyConfig(configDir, rawConfig?.proxy);
  if (session && session !== proxy.session) {
    throw new BrowserSessionError(`login session '${session}' does not match configured proxy.session '${proxy.session}'`);
  }
  return await withRegistryLock(configDir, (layout) => {
    const { record, poolEntry } = requirePinnedSessionLocked(layout, proxy);
    if (expectedGeneration !== undefined && record.generation !== expectedGeneration) {
      throw new BrowserSessionError(`proxy session '${proxy.session}' generation changed before handoff issuance`);
    }
    const { taskOwner } = inspectSessionOwners(layout, proxy.session);
    if (expectedOwnerId && (!taskOwner || taskOwner.token !== expectedOwnerId)) {
      throw new BrowserSessionError(`active task owner mismatch for session '${proxy.session}'`);
    }
    if (taskOwner && taskOwner.generation !== record.generation) {
      throw new BrowserSessionError(`task owner generation mismatch for session '${proxy.session}'`);
    }

    const key = getOrCreateHandoffKey(layout);
    const handoffId = crypto.randomBytes(16).toString("hex");
    const issuedAtMs = Date.now();
    const numericTtl = Number(ttlMs);
    const effectiveTtlMs = Number.isFinite(numericTtl) && numericTtl > 0 ? numericTtl : DEFAULT_HANDOFF_TTL_MS;
    const expiresAtMs = issuedAtMs + effectiveTtlMs;
    const payload = {
      version: 1,
      handoffId,
      session: proxy.session,
      generation: record.generation,
      proxyId: record.proxyId,
      endpointFingerprint: fingerprintEndpoint(poolEntry.server),
      ownerId: taskOwner ? taskOwner.token : null,
      nonce: crypto.randomBytes(16).toString("hex"),
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
    };
    const signed = { ...payload, sig: signHandoffPayload(key, payload) };
    ensurePrivateDirectory(layout.handoffsDir);
    const handoffPath = path.join(layout.handoffsDir, `${handoffId}.json`);
    const fd = fs.openSync(handoffPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(signed, null, 2) + "\n", "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return {
      handoffId,
      session: proxy.session,
      generation: record.generation,
      proxyId: record.proxyId,
      expiresAt: payload.expiresAt,
    };
  });
}

export async function joinLoginHelper(configDir, rawConfig, { session, handoffId }) {
  const proxy = resolveProxyConfig(configDir, rawConfig?.proxy);
  if (session !== proxy.session) {
    throw new BrowserSessionError(`login helper session '${session}' does not match configured proxy.session '${proxy.session}'`);
  }
  if (typeof handoffId !== "string" || !/^[0-9a-f]{32}$/.test(handoffId)) {
    throw new BrowserSessionError("invalid login handoff token");
  }

  const joined = await withRegistryLock(configDir, (layout) => {
    const { exists, registry } = readRegistryStrict(layout.registryPath);
    const record = exists ? registry.sessions[proxy.session] : null;
    if (!record) {
      throw new BrowserSessionError(`proxy session '${proxy.session}' not found for handoff`);
    }
    const poolEntry = assertPinnedSessionMatchesPool(proxy.session, record, proxy.pool);
    const handoffPath = path.join(layout.handoffsDir, `${handoffId}.json`);
    let handoffRaw;
    try {
      handoffRaw = readPrivateFileNoFollow(handoffPath, { maxBytes: MAX_HANDOFF_FILE_BYTES, requireSingleLink: true });
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new BrowserSessionError("missing or already-consumed login handoff capability");
      }
      throw error;
    }

    let consumed = false;
    const consumeHandoff = () => {
      if (consumed) return;
      consumed = true;
      try {
        fs.unlinkSync(handoffPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    };

    let payload;
    try {
      payload = JSON.parse(handoffRaw.content);
    } catch {
      consumeHandoff();
      throw new BrowserSessionError("corrupt login handoff capability");
    }
    const key = getOrCreateHandoffKey(layout);
    if (!isPlainObject(payload) || !verifyHandoffSignature(key, payload)) {
      consumeHandoff();
      throw new BrowserSessionError("invalid login handoff signature");
    }
    consumeHandoff();

    if (typeof payload.expiresAtMs !== "number" || Date.now() > payload.expiresAtMs) {
      throw new BrowserSessionError("login handoff capability has expired");
    }
    if (
      payload.handoffId !== handoffId ||
      payload.session !== proxy.session ||
      payload.generation !== record.generation ||
      payload.proxyId !== record.proxyId ||
      payload.endpointFingerprint !== record.endpointFingerprint
    ) {
      throw new BrowserSessionError("login handoff capability does not match current session generation or proxy");
    }

    const { taskOwner, paths } = inspectSessionOwners(layout, proxy.session);
    if (payload.ownerId !== null && taskOwner && taskOwner.token !== payload.ownerId) {
      throw new BrowserSessionError("login handoff capability belongs to a superseded task owner");
    }

    ensurePrivateDirectory(paths.sessionDir);
    ensurePrivateDirectory(paths.helpersDir);
    const helperId = crypto.randomBytes(12).toString("hex");
    const helperPath = path.join(paths.helpersDir, `${helperId}.json`);
    const lease = acquireAtomicLinkRecord(helperPath, {
      kind: "helper",
      session: proxy.session,
      generation: record.generation,
      helperId,
    });
    if (!lease.acquired) {
      throw new BrowserSessionError("failed to register login helper ownership");
    }
    return {
      session: proxy.session,
      generation: record.generation,
      proxyId: record.proxyId,
      poolEntry,
      helperId,
      release: lease.release,
    };
  });

  try {
    const credentials = joined.poolEntry.credentialsFile
      ? readProxyCredentials(configDir, joined.poolEntry.credentialsFile)
      : joined.poolEntry.credentials ?? null;
    return {
      session: joined.session,
      generation: joined.generation,
      proxyId: joined.proxyId,
      server: joined.poolEntry.server,
      credentials,
      helperId: joined.helperId,
      release: joined.release,
    };
  } catch (error) {
    try {
      joined.release();
    } catch {}
    throw error;
  }
}

export function getSessionAuthRecords(configDir, sessionName) {
  try {
    assertValidName(sessionName);
  } catch {
    throw new BrowserSessionError("invalid session name");
  }
  let layout;
  try {
    layout = ensureSessionsLayout(configDir, { create: false });
  } catch (error) {
    if (error.code === "ENOENT" || (error instanceof BrowserSessionError && error.message.includes("does not exist"))) {
      return null;
    }
    throw error;
  }
  const { exists, registry } = readRegistryStrict(layout.registryPath);
  if (!exists) return null;
  const record = registry.sessions[sessionName];
  if (!record) return null;
  return {
    session: sessionName,
    generation: record.generation,
    proxyId: record.proxyId,
    authRecords: [...record.authRecords],
  };
}
