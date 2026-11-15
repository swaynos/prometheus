import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PROXY_LIST_FILE = "proxies.txt";
const MAX_BYTES = 1024 * 1024;
const MAX_PROXIES = 4096;

export class ProxyListError extends Error {
  constructor(code, line) {
    super(`${code}${line === undefined ? "" : ` at line ${line}`}`);
    this.name = "ProxyListError";
    this.code = code;
    if (line !== undefined) this.line = line;
  }
}

// Returns private runtime data, never browser configuration or public metadata.
export function parseProxyList(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_BYTES) {
    throw new ProxyListError("proxy-list-too-large");
  }
  const entries = [];
  const seen = new Set();
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const lineNumber = index + 1;
    const fail = () => { throw new ProxyListError("proxy-list-invalid-record", lineNumber); };
    // Brackets disambiguate IPv6; everything after USER: belongs to PASS.
    const match = /^(\[[^\]\r\n]+\]|[^:\s/\\?#@%\[\]]+):([0-9]+):([^:\r\n]+):(.+)$/u.exec(line);
    if (!match || /[\u0000-\u001F\u007F]/u.test(line)) fail();
    const [, host, portText, username, password] = match;
    const port = Number(portText);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) fail();
    let url;
    try { url = new URL(`http://${host}:${port}`); } catch { fail(); }
    if (!url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== "/") fail();
    const server = `http://${url.hostname.toLowerCase()}:${port}`;
    // Provider usernames often encode sticky sessions/routes. Password refreshes
    // preserve identity; changing host, port or username requires reconciliation.
    const id = `file-${crypto.createHash("sha256").update(JSON.stringify([server, username])).digest("hex").slice(0, 32)}`;
    if (seen.has(id)) throw new ProxyListError("proxy-list-duplicate", lineNumber);
    seen.add(id);
    entries.push({ id, server, credentials: { username, password },
      redactionLiterals: [line, `${host}:${portText}`] });
    if (entries.length > MAX_PROXIES) throw new ProxyListError("proxy-list-too-many-records");
  }
  if (!entries.length) throw new ProxyListError("proxy-list-empty");
  return entries;
}

// The default list lives directly in the config root. That root and its
// ancestors need not be 0700, but must be protected against untrusted writes.
// Keep all directory descriptors open and recheck identities after the read.
export function readProxyList(configDir) {
  const { constants } = fs;
  if (typeof configDir !== "string" || !configDir ||
      typeof process.getuid !== "function" ||
      typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_DIRECTORY !== "number") {
    throw new ProxyListError("proxy-list-unsafe");
  }
  const uid = process.getuid();
  const root = path.resolve(configDir);
  const held = [];
  let fileFd;
  try {
    const directories = [];
    for (let dir = root; ; dir = path.dirname(dir)) {
      directories.unshift(dir);
      if (path.dirname(dir) === dir) break;
    }
    for (const dir of directories) {
      const fd = fs.openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd);
      held.push({ fd, dir, stat });
      const stickySystemDirectory = stat.uid === 0 && (stat.mode & 0o1000);
      if (!stat.isDirectory() || (stat.uid !== uid && stat.uid !== 0) ||
          ((stat.mode & 0o022) && !stickySystemDirectory) ||
          (dir === root && (stat.uid !== uid || (stat.mode & 0o022)))) {
        throw new ProxyListError("proxy-list-unsafe");
      }
      if (fs.existsSync(path.join(dir, ".git")) ||
          (fs.existsSync(path.join(dir, "HEAD")) &&
           ["objects", "refs", "commondir"].some(name => fs.existsSync(path.join(dir, name))))) {
        throw new ProxyListError("proxy-list-in-repository");
      }
    }
    const file = path.join(root, PROXY_LIST_FILE);
    try {
      fileFd = fs.openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    } catch (error) {
      throw new ProxyListError(error.code === "ENOENT" ? "proxy-list-missing" : "proxy-list-unsafe");
    }
    const stat = fs.fstatSync(fileFd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o7777) !== 0o600) {
      throw new ProxyListError("proxy-list-unsafe");
    }
    if (stat.size > MAX_BYTES) throw new ProxyListError("proxy-list-too-large");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let count = 0, n;
    while (count < bytes.length && (n = fs.readSync(fileFd, bytes, count, bytes.length - count, null)) > 0) count += n;
    if (count > MAX_BYTES) throw new ProxyListError("proxy-list-too-large");
    const after = fs.fstatSync(fileFd);
    const target = fs.lstatSync(file);
    if (target.isSymbolicLink() || target.dev !== stat.dev || target.ino !== stat.ino ||
        after.nlink !== 1 || after.uid !== uid || (after.mode & 0o7777) !== 0o600 ||
        after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
      throw new ProxyListError("proxy-list-unsafe");
    }
    for (const item of held) {
      const current = fs.fstatSync(item.fd);
      const targetDir = fs.lstatSync(item.dir);
      if (targetDir.isSymbolicLink() || targetDir.dev !== item.stat.dev || targetDir.ino !== item.stat.ino ||
          current.uid !== item.stat.uid || current.mode !== item.stat.mode) {
        throw new ProxyListError("proxy-list-unsafe");
      }
    }
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)); }
    catch { throw new ProxyListError("proxy-list-invalid-encoding"); }
    return parseProxyList(text);
  } catch (error) {
    if (error instanceof ProxyListError) throw error;
    throw new ProxyListError("proxy-list-unsafe");
  } finally {
    if (fileFd !== undefined) fs.closeSync(fileFd);
    for (const { fd } of held.reverse()) fs.closeSync(fd);
  }
}
