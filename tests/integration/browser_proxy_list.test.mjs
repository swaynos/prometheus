import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { parseProxyList, readProxyList } from "../../scripts/opencode-browser-proxy-list.mjs";
import {
  acquireTaskSession, bindAuthRecord, createSession, diagnoseSessions,
  issueLoginHandoff, joinLoginHelper, listSessions, reconcileCursor,
  reconcileSession, rotateSession, sanitizePoolProxyError, showSession,
  verifySessionGeneration,
} from "../../scripts/opencode-browser-sessions.mjs";
import {
  browserConfigFromEnv, browserRuntimeInfo, createTaskContext, validateBrowserConfig,
} from "../../scripts/opencode-browser-runtime.mjs";
import { runBrowserSessionsCli } from "../../scripts/browser-sessions.mjs";
import { loginBrowserConfig } from "../../scripts/opencode-browser-login.mjs";
import { saveState } from "../../scripts/opencode-browser-state.mjs";
import { profile } from "../../scripts/browser-profile.mjs";

const first = "PrivateProxyA.invalid:18001:DistinctiveListUser:DistinctiveListPassword";
const second = "PrivateProxyB.invalid:18002:OtherListUser:OtherListPassword";
const cfg = () => ({ channel: "default", proxy: { session: "main", strategy: "round-robin" } });

function fixture(t, content = `${first}\n${second}\n`) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "prometheus-proxy-list-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.chmodSync(dir, 0o755); // The whole OpenCode config root need not be private.
  const file = path.join(dir, "proxies.txt");
  const config = cfg();
  const write = (text) => fs.writeFileSync(file, text, { mode: 0o600 });
  write(content);
  fs.writeFileSync(path.join(dir, "prometheus-browser.json"), JSON.stringify(config));
  return { dir, file, config, write };
}

function assertPrivate(value) {
  assert.doesNotMatch(typeof value === "string" ? value : JSON.stringify(value),
    /PrivateProxy|privateproxya|privateproxyb|18001|18002|DistinctiveList|OtherList|proxies\.txt|credentials|endpointFingerprint/i);
}

function snapshot(dir) {
  return fs.readdirSync(dir).sort().map(name => {
    const file = path.join(dir, name), st = fs.lstatSync(file, { bigint: true });
    return [name, st.mode, st.ino, st.mtimeNs, st.ctimeNs,
      st.isDirectory() ? snapshot(file) : st.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file)];
  });
}

test("text list parses LF/CRLF, BOM, comments, blank lines, IPv6 and literal colon passwords", () => {
  const entries = parseProxyList("\uFEFF# comment\r\n\r\n" +
    "Proxy.Example:080:user: pass:with:#:@:spaces \r\n[::1]:8080:ipv6:secret\n127.0.0.1:3128:local:pass");
  assert.equal(entries.length, 3);
  assert.equal(entries[0].server, "http://proxy.example:80");
  assert.deepEqual(entries[0].credentials, { username: "user", password: " pass:with:#:@:spaces " });
  assert.equal(entries[1].server, "http://[::1]:8080");
  assert.equal(entries[2].server, "http://127.0.0.1:3128");
  assert.match(entries[0].id, /^file-[0-9a-f]{32}$/);
  assert.equal(parseProxyList("proxy.example:80:user:updated")[0].id, entries[0].id);
  assert.notEqual(parseProxyList("proxy.example:80:other:updated")[0].id, entries[0].id);
  assert.equal(parseProxyList("proxy.example:80:a:p\nproxy.example:80:b:p").length, 2);
});

test("malformed and duplicate records fail with fixed codes and line numbers, not record contents", () => {
  for (const line of [
    "host:80", "host:80:user:", "host:80::pass", "host:0:u:p", "host:65536:u:p",
    "host:1e3:u:p", "host:12.5:u:p", "host:abc:u:p", "http://host:80:u:p",
    "::1:80:u:p", "[invalid]:80:u:p", "host/path:80:u:p", "host?x:80:u:p",
    "host#x:80:u:p", "u@host:80:u:p", " host:80:u:p", "host:80:u:\0p",
    "host:80:u:p\r", "host:80:u:p\t", "host:80:us\ter:p",
  ]) {
    assert.throws(() => parseProxyList(`# header\n${line}`), error => {
      assert.equal(error.code, "proxy-list-invalid-record");
      assert.equal(error.line, 2);
      assert.equal(error.message, "proxy-list-invalid-record at line 2");
      return true;
    });
  }
  assert.throws(() => parseProxyList(`${first}\n${first.replace("DistinctiveListPassword", "new-password")}`),
    { code: "proxy-list-duplicate", line: 2 });
  assert.throws(() => parseProxyList("# comments only\n \n"), { code: "proxy-list-empty" });
  assert.throws(() => parseProxyList("x".repeat(1024 * 1024 + 1)), { code: "proxy-list-too-large" });
  assert.throws(() => parseProxyList(Array.from({ length: 4097 }, (_, n) => `host:80:u${n}:p`).join("\n")),
    { code: "proxy-list-too-many-records" });
});

test("default file loads from a protected 0755 config root without changing permissions", t => {
  const f = fixture(t);
  const before = snapshot(f.dir);
  assert.equal(readProxyList(f.dir).length, 2);
  assert.deepEqual(snapshot(f.dir), before);
  fs.chmodSync(f.dir, 0o777);
  assert.throws(() => readProxyList(f.dir), { code: "proxy-list-unsafe" });
});

test("file loader rejects missing, unsafe, linked, nonregular, oversized and invalid UTF-8 files", t => {
  const f = fixture(t);
  for (const mode of [0o644, 0o400, 0o660, 0o1600]) {
    fs.chmodSync(f.file, mode);
    assert.throws(() => readProxyList(f.dir), { code: "proxy-list-unsafe" });
  }
  fs.chmodSync(f.file, 0o600);
  const target = path.join(f.dir, "target");
  fs.renameSync(f.file, target);
  assert.throws(() => readProxyList(f.dir), { code: "proxy-list-missing" });
  fs.symlinkSync(target, f.file);
  assert.throws(() => readProxyList(f.dir), { code: "proxy-list-unsafe" });
  fs.unlinkSync(f.file);
  fs.linkSync(target, f.file);
  assert.throws(() => readProxyList(f.dir), { code: "proxy-list-unsafe" });
  fs.unlinkSync(f.file);
  fs.mkdirSync(f.file, { mode: 0o600 });
  assert.throws(() => readProxyList(f.dir), { code: "proxy-list-unsafe" });
  fs.rmdirSync(f.file);
  execFileSync("mkfifo", ["-m", "600", f.file]);
  assert.throws(() => readProxyList(f.dir), { code: "proxy-list-unsafe" });
  fs.unlinkSync(f.file);
  fs.renameSync(target, f.file);
  fs.writeFileSync(f.file, Buffer.from([0xff, 0xfe, 0x00]));
  assert.throws(() => readProxyList(f.dir), { code: "proxy-list-invalid-encoding" });
  f.write("x".repeat(1024 * 1024 + 1));
  assert.throws(() => readProxyList(f.dir), { code: "proxy-list-too-large" });
  const linkRoot = path.join(f.dir, "linked-root");
  fs.symlinkSync(f.dir, linkRoot);
  assert.throws(() => readProxyList(linkRoot), { code: "proxy-list-unsafe" });
});

test("proxy lists are rejected inside repositories, including nested config roots and bare repos", t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dir, ".git"));
  assert.throws(() => readProxyList(f.dir), { code: "proxy-list-in-repository" });
  const nested = path.join(f.dir, "config");
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, "proxies.txt"), first, { mode: 0o600 });
  assert.throws(() => readProxyList(nested), { code: "proxy-list-in-repository" });
  fs.rmdirSync(path.join(f.dir, ".git"));
  fs.writeFileSync(path.join(f.dir, "HEAD"), "fixture");
  fs.mkdirSync(path.join(f.dir, "objects"));
  assert.throws(() => readProxyList(f.dir), { code: "proxy-list-in-repository" });
});

test("file and directory swaps and permission changes during a read fail closed", t => {
  for (const kind of ["file", "directory", "permissions"]) {
    const f = fixture(t);
    const saved = `${f.dir}-held`;
    let swapped = false;
    const originalRead = fs.readSync;
    const mocked = t.mock.method(fs, "readSync", (...args) => {
      const n = originalRead(...args);
      if (!swapped && n > 0) {
        swapped = true;
        if (kind === "file") {
          fs.renameSync(f.file, path.join(f.dir, "held-list"));
          fs.writeFileSync(f.file, second, { mode: 0o600 });
        } else if (kind === "directory") {
          fs.renameSync(f.dir, saved);
          fs.symlinkSync(saved, f.dir);
        } else {
          fs.chmodSync(f.file, 0o644);
        }
      }
      return n;
    });
    try {
      assert.throws(() => readProxyList(f.dir), { code: "proxy-list-unsafe" }, kind);
      assert.equal(swapped, true);
    } finally {
      mocked.mock.restore();
      if (kind === "directory" && swapped) {
        fs.unlinkSync(f.dir);
        fs.renameSync(saved, f.dir);
      }
    }
  }
});

test("explicit JSON pools take precedence without reading an unsafe default list", async t => {
  const f = fixture(t, "malformed secret content");
  fs.chmodSync(f.file, 0o644);
  f.config.proxy.pool = [{ id: "legacy", server: "http://127.0.0.1:18000" }];
  const before = fs.readFileSync(f.file);
  assert.equal((await createSession(f.dir, f.config)).proxyId, "legacy");
  assert.equal(diagnoseSessions(f.dir, f.config).ok, true);
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o644);
});

test("static config, status metadata and login config never resolve or serialize the list", t => {
  const f = fixture(t);
  fs.unlinkSync(f.file);
  const config = browserConfigFromEnv({ PROMETHEUS_CONFIG_DIR: f.dir });
  assert.deepEqual(config, f.config);
  assert.equal(loginBrowserConfig(config).executionMode, undefined);
  assertPrivate(browserRuntimeInfo(config));
  assert.equal(browserRuntimeInfo(config).proxy.routing, "configured");
  assert.throws(() => validateBrowserConfig({ ...config, executionMode: "external-cdp" }));
  assert.throws(() => validateBrowserConfig({ ...config, profile: "firefox-desktop" }));
  assert.throws(() => validateBrowserConfig({ ...config, proxy: { ...config.proxy, pool: [] } }));
  assert.throws(() => validateBrowserConfig({ ...config, proxy: { ...config.proxy, poolFile: "other.txt" } }));
  assert.equal(validateBrowserConfig({ channel: "default" }).proxy, undefined);
  let launches = 0;
  return assert.rejects(() => createTaskContext({ launch() { launches++; } }, config, undefined, { configDir: f.dir }),
    { code: "proxy-list-missing" }).then(() => {
    assert.equal(launches, 0);
    assert.equal(fs.existsSync(path.join(f.dir, "prometheus-proxy-sessions")), false);
  });
});

test("file-backed allocation, reorder, password refresh, rotation and username reconciliation preserve pinning", async t => {
  const f = fixture(t);
  const [a, b] = readProxyList(f.dir);
  const created = await createSession(f.dir, f.config);
  assert.equal(created.proxyId, a.id);
  assertPrivate(created);
  await createSession(f.dir, f.config, { session: "other" });
  assert.equal(listSessions(f.dir).nextProxyId, a.id);
  f.write(`${second}\n${first.replace("DistinctiveListPassword", "UpdatedPassword")}\n`);
  const lease = await acquireTaskSession(f.dir, f.config);
  assert.equal(lease.proxyId, a.id);
  assert.equal(lease.credentials.password, "UpdatedPassword");
  assert.equal(verifySessionGeneration(f.dir, f.config, 1).generation, 1);
  const handoff = await issueLoginHandoff(f.dir, f.config);
  const helper = await joinLoginHelper(f.dir, f.config, { session: "main", handoffId: handoff.handoffId });
  assert.equal(helper.proxyId, lease.proxyId);
  assert.deepEqual(helper.credentials, lease.credentials);
  await assert.rejects(() => rotateSession(f.dir, f.config), /active browser task owner/);
  lease.release();
  await assert.rejects(() => rotateSession(f.dir, f.config), /login helper is active/);
  helper.release();
  assert.equal((await rotateSession(f.dir, f.config)).generation, 2);
  assert.equal(showSession(f.dir, "main").proxyId, a.id);
  f.write(`${second}\n${first.replace("DistinctiveListUser", "ChangedUsername")}\n`);
  const changed = readProxyList(f.dir)[1];
  await assert.rejects(() => acquireTaskSession(f.dir, f.config), /no longer in pool/);
  const fixed = await reconcileSession(f.dir, f.config, { proxyId: changed.id });
  assert.equal(fixed.generation, 3);
  assert.equal(fixed.proxyId, changed.id);
  assert.equal(listSessions(f.dir).nextProxyId, b.id);
  // Removing the global cursor is never an instruction to silently skip it.
  f.write(first);
  await assert.rejects(() => rotateSession(f.dir, f.config), /cursor/);
  await reconcileCursor(f.dir, f.config, { nextProxyId: a.id });
  assert.equal((await rotateSession(f.dir, f.config)).proxyId, a.id);
});

test("single-entry rotation clears associations; failed launch releases its owner and redacts all list secrets", async t => {
  const f = fixture(t, first);
  saveState({ configDir: f.dir, name: "account", origins: ["https://example.com"],
    storageState: { cookies: [], origins: [] } });
  await createSession(f.dir, f.config);
  await bindAuthRecord(f.dir, "main", "account");
  const registryPath = path.join(f.dir, "prometheus-proxy-sessions", "registry.json");
  const before = fs.readFileSync(registryPath);
  const config = validateBrowserConfig(f.config);
  await assert.rejects(() => createTaskContext({
    launch() { throw new Error(`${first} proxies.txt`); },
  }, config, undefined, { configDir: f.dir }), error => {
    assertPrivate(error.message);
    return true;
  });
  assert.deepEqual(fs.readFileSync(registryPath), before);
  assert.equal(diagnoseSessions(f.dir, f.config).sessions[0].inactive, true);
  assertPrivate(sanitizePoolProxyError(`${first} proxies.txt`, config));
  assertPrivate(config);
  const rotated = await rotateSession(f.dir, f.config);
  assert.equal(rotated.generation, 2);
  assert.deepEqual(rotated.authRecords, []);
  assertPrivate(fs.readFileSync(registryPath, "utf8").replace(/"endpointFingerprint"/g, '"fingerprint"'));
});

test("doctor validates the text list read-only with sanitized failures and CLI exit statuses", async t => {
  const f = fixture(t);
  await createSession(f.dir, f.config);
  const before = snapshot(f.dir);
  const report = diagnoseSessions(f.dir, f.config);
  assert.equal(report.ok, true);
  assert.deepEqual(report.proxies.map(entry => entry.credentials), ["valid", "valid"]);
  // Credential validity is public metadata, never the credentials themselves.
  assertPrivate({ ...report, proxies: report.proxies.map(({ proxyId }) => ({ proxyId })) });
  assert.deepEqual(snapshot(f.dir), before);
  for (const [contents, code] of [["# empty", "proxy-list-empty"], [first + "\nINVALID", "proxy-list-invalid-record"]]) {
    f.write(contents);
    const snapshotBefore = snapshot(f.dir);
    const cli = await runBrowserSessionsCli(["doctor", "--config-dir", f.dir], {});
    assert.equal(cli.status, 1);
    assert.equal(JSON.parse(cli.stdout).issues[0].code, code);
    assertPrivate(cli);
    assert.deepEqual(snapshot(f.dir), snapshotBefore);
  }
  fs.unlinkSync(f.file);
  assert.equal(diagnoseSessions(f.dir, f.config).issues[0].code, "proxy-list-missing");
  const child = spawnSync(process.execPath, ["scripts/browser-sessions.mjs", "doctor", "--config-dir", f.dir],
    { cwd: path.resolve(import.meta.dirname, "../.."), encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 1);
  assert.equal(child.stderr, "");
  assertPrivate(child.stdout);
});

test("changed text identities invalidate pending login handoffs without moving assignments", async t => {
  const f = fixture(t);
  await createSession(f.dir, f.config);
  const handoff = await issueLoginHandoff(f.dir, f.config);
  f.write(`${second}\n${first.replace("DistinctiveListUser", "ChangedUsername")}\n`);
  await assert.rejects(() => joinLoginHelper(f.dir, f.config, { session: "main", handoffId: handoff.handoffId }),
    /no longer in pool/);
  assert.equal(showSession(f.dir, "main").generation, 1);
  assert.equal(showSession(f.dir, "main").activeHelperCount, 0);
});

test("session CLI reloads file-backed assignments in fresh processes without credentials in output", async t => {
  const f = fixture(t);
  const repo = path.resolve(import.meta.dirname, "../..");
  const run = (...args) => execFileSync(process.execPath, ["scripts/browser-sessions.mjs", ...args, "--config-dir", f.dir],
    { cwd: repo, encoding: "utf8", timeout: 10000 });
  const created = JSON.parse(run("create", "main"));
  assertPrivate(created);
  const shown = JSON.parse(run("show", "main"));
  assert.equal(shown.proxyId, created.proxyId);
  const rotated = JSON.parse(run("rotate", "main"));
  assert.equal(rotated.generation, 2);
  assert.notEqual(rotated.proxyId, created.proxyId);
  const report = JSON.parse(run("doctor"));
  assert.equal(report.ok, true);
  assertPrivate({ ...report, proxies: [] });
});

test("installer never opens, copies or overwrites the default proxy list", t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.file);
  // An invalid list must not affect a blank-page installation probe.
  f.write("DistinctiveListPassword malformed file");
  fs.chmodSync(f.file, 0o644);
  profile("install", { root: f.dir, quiescent: true, prepare() {}, verify(stage, selected) {
    assert.deepEqual(selected.proxy, f.config.proxy);
    assert.equal(fs.existsSync(path.join(stage, "proxies.txt")), false);
    assert.equal(fs.existsSync(path.join(stage, "proxies.txt.example")), true);
    assert.equal(fs.existsSync(path.join(stage, "opencode-browser-proxy-list.mjs")), true);
  } });
  assert.equal(fs.readFileSync(f.file, "utf8"), "DistinctiveListPassword malformed file");
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o644);
  assert.equal(fs.existsSync(path.join(f.dir, "prometheus-proxy-sessions")), false);
  const receipt = fs.readFileSync(path.join(f.dir, "prometheus-browser-migration.json"), "utf8");
  assert.doesNotMatch(receipt, /DistinctiveListPassword/);
  profile("remove", { root: f.dir, quiescent: true });
  assert.equal(fs.readFileSync(f.file, "utf8"), "DistinctiveListPassword malformed file");
  fs.chmodSync(f.file, 0o600);
  f.write(before);
});
