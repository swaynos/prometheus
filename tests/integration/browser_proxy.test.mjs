import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync, fork, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";
import {
  browserLaunchOptions,
  browserRuntimeInfo,
  createTaskContext,
  hydrateBrowserState,
  validateBrowserConfig,
} from "../../scripts/opencode-browser-runtime.mjs";
import {
  acquireTaskSession,
  bindAuthRecord,
  BrowserSessionError,
  createSession,
  getSessionAuthRecords,
  issueLoginHandoff,
  joinLoginHelper,
  listSessions,
  PROXY_SESSIONS_DIR,
  readProxyCredentials,
  reconcileCursor,
  reconcileSession,
  redactSecrets,
  rotateSession,
  showSession,
} from "../../scripts/opencode-browser-sessions.mjs";
import { loadStateForOrigin, saveState, statMetadata } from "../../scripts/opencode-browser-state.mjs";
import * as login from "../../scripts/opencode-browser-login.mjs";
import { profile } from "../../scripts/browser-profile.mjs";
import { readProxyList } from "../../scripts/opencode-browser-proxy-list.mjs";
import { repoRoot, spawnMcpClient } from "./helpers.mjs";

const execFileAsync = promisify(execFile);
const testChannel = process.env.PROMETHEUS_TEST_BROWSER_CHANNEL || "default";
const testMode = process.env.PROMETHEUS_TEST_PROXY_MODE || "headless";
if (!["headless", "virtual-display"].includes(testMode)) {
  throw new Error("PROMETHEUS_TEST_PROXY_MODE must be headless or virtual-display");
}

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aW1sAAAAASUVORK5CYII=",
  "base64"
);

function makeConfigDir(t, prefix = "prometheus-proxy-test-") {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeSecretFile(configDir, relPath, creds, { fileMode = 0o600, dirMode = 0o700 } = {}) {
  const full = path.join(configDir, relPath);
  const parent = path.dirname(full);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (parent !== configDir) fs.chmodSync(parent, dirMode);
  fs.writeFileSync(full, JSON.stringify(creds) + "\n", { mode: 0o600 });
  fs.chmodSync(full, fileMode);
  return full;
}

function writeBrowserSettings(configDir, settings) {
  fs.writeFileSync(path.join(configDir, "prometheus-browser.json"), JSON.stringify(settings, null, 2) + "\n", {
    mode: 0o600,
  });
}

function configurePoolSource(configDir, config, source) {
  const pool = config.proxy.pool;
  if (source === "json") return Object.fromEntries(pool.map(entry => [entry.id, entry.id]));
  const lines = pool.map(entry => {
    const credentials = entry.credentialsFile
      ? readProxyCredentials(configDir, entry.credentialsFile)
      : { username: "unused-user", password: "unused-password" };
    return `${entry.server.replace(/^http:\/\//, "")}:${credentials.username}:${credentials.password}`;
  });
  fs.writeFileSync(path.join(configDir, "proxies.txt"), lines.join("\n") + "\n", { mode: 0o600 });
  // The text-file variants must work without per-proxy credential JSON files.
  for (const entry of pool) {
    if (entry.credentialsFile) fs.unlinkSync(path.join(configDir, entry.credentialsFile));
  }
  delete config.proxy.pool;
  const entries = readProxyList(configDir);
  return Object.fromEntries(pool.map((entry, index) => [entry.id, entries[index].id]));
}

function createAuthProxyFixture(t, opts = {}) {
  let expectedAuth = opts.username && opts.password
    ? `Basic ${Buffer.from(`${opts.username}:${opts.password}`, "utf8").toString("base64")}`
    : null;
  let force407 = Boolean(opts.force407);
  const httpRequests = [];
  const connectRequests = [];
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    httpRequests.push({
      method: req.method,
      url: req.url,
      proxyAuth: req.headers["proxy-authorization"] || null,
      auth: req.headers["authorization"] || null,
    });
    if (force407 || (expectedAuth && req.headers["proxy-authorization"] !== expectedAuth)) {
      res.writeHead(407, {
        "Proxy-Authenticate": 'Basic realm="TestProxy"',
        "Content-Type": "text/plain",
      });
      res.end("Proxy Authentication Required");
      return;
    }
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400);
      res.end("bad proxy url");
      return;
    }
    const headers = { ...req.headers };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const upReq = http.request(
      {
        host: target.hostname.replace(/^\[(.*)\]$/, "$1"),
        port: Number(target.port || 80),
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
      }
    );
    upReq.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end("upstream error");
    });
    req.pipe(upReq);
  });

  server.on("connect", (req, clientSocket, head) => {
    sockets.add(clientSocket);
    clientSocket.once("close", () => sockets.delete(clientSocket));
    clientSocket.on("error", () => {});
    connectRequests.push({
      target: req.url,
      proxyAuth: req.headers["proxy-authorization"] || null,
    });
    if (force407 || (expectedAuth && req.headers["proxy-authorization"] !== expectedAuth)) {
      clientSocket.end(
        "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"TestProxy\"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
      );
      return;
    }
    const lastColon = req.url.lastIndexOf(":");
    const host = req.url.slice(0, lastColon).replace(/^\[(.*)\]$/, "$1");
    const port = Number(req.url.slice(lastColon + 1));
    const targetSocket = net.connect({ host, port }, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) targetSocket.write(head);
      targetSocket.pipe(clientSocket);
      clientSocket.pipe(targetSocket);
    });
    sockets.add(targetSocket);
    targetSocket.once("close", () => sockets.delete(targetSocket));
    targetSocket.on("error", () => clientSocket.destroy());
    clientSocket.on("close", () => targetSocket.destroy());
  });

  const start = async () => {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    return `http://127.0.0.1:${addr.port}`;
  };
  const close = async () => {
    for (const s of sockets) {
      try { s.destroy(); } catch {}
    }
    sockets.clear();
    await new Promise((resolve) => server.close(() => resolve()));
  };
  t.after(() => close().catch(() => {}));

  return {
    start,
    close,
    httpRequests,
    connectRequests,
    setForce407(val) { force407 = Boolean(val); },
    setCredentials(username, password) {
      expectedAuth = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
    },
  };
}

function generateSelfSignedCert(t, workDir) {
  const keyPath = path.join(workDir, "tls-key.pem");
  const certPath = path.join(workDir, "tls-cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath,
    "-out", certPath,
    "-days", "1",
    "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ], { stdio: "pipe" });
  const key = fs.readFileSync(keyPath, "utf8");
  const cert = fs.readFileSync(certPath, "utf8");
  const x509 = new crypto.X509Certificate(cert);
  const spkiDer = x509.publicKey.export({ type: "spki", format: "der" });
  const spkiPin = crypto.createHash("sha256").update(spkiDer).digest("base64");
  t.after(() => {
    try { fs.unlinkSync(keyPath); } catch {}
    try { fs.unlinkSync(certPath); } catch {}
  });
  return { key, cert, spkiPin };
}

test("proxy config validation, canonicalization, engine/mode exclusions, and non-allocation", (t) => {
  const valid = validateBrowserConfig({
    channel: testChannel,
    proxy: {
      session: "shopping",
      strategy: "round-robin",
      pool: [
        { id: "proxy-a", server: "HTTP://Proxy-A.Example:8000/", credentialsFile: "prometheus-proxy-secrets/a.json" },
        { id: "proxy-b", server: "http://[::1]:80/" },
      ],
    },
  });
  assert.equal(valid.proxy.pool[0].server, "http://proxy-a.example:8000");
  assert.equal(valid.proxy.pool[1].server, "http://[::1]:80");

  // Validation and metadata inspection must never leak endpoints or credentialsFile paths.
  assert.equal(browserLaunchOptions(valid).proxy, undefined);
  const infoText = JSON.stringify(browserRuntimeInfo(valid));
  assert.doesNotMatch(infoText, /proxy-a\.example|8000|\[::1\]|credentialsFile|a\.json/);
  assert.equal(browserRuntimeInfo(valid).proxy.routing, "configured");

  // Invalid configurations fail closed.
  const badConfigs = [
    { channel: "default", executionMode: "external-cdp", proxy: valid.proxy },
    { channel: "default", profile: "firefox-desktop", proxy: valid.proxy },
    { channel: "default", profile: "webkit-desktop", proxy: valid.proxy },
    { channel: "default", launchOptions: { args: ["--proxy-server=http://evil:1"] }, proxy: valid.proxy },
    { channel: "default", proxy: { session: "../bad", strategy: "round-robin", pool: [{ id: "a", server: "http://127.0.0.1:8080" }] } },
    { channel: "default", proxy: { session: "ok", strategy: "random", pool: [{ id: "a", server: "http://127.0.0.1:8080" }] } },
    { channel: "default", proxy: { session: "ok", strategy: "round-robin", pool: [] } },
    { channel: "default", proxy: { session: "ok", strategy: "round-robin", pool: [{ id: "dup", server: "http://127.0.0.1:8080" }, { id: "dup", server: "http://127.0.0.1:8081" }] } },
    { channel: "default", proxy: { session: "ok", strategy: "round-robin", pool: [{ id: "a", server: "https://127.0.0.1:8080" }] } },
    { channel: "default", proxy: { session: "ok", strategy: "round-robin", pool: [{ id: "a", server: "socks5://127.0.0.1:1080" }] } },
    { channel: "default", proxy: { session: "ok", strategy: "round-robin", pool: [{ id: "a", server: "http://user:pass@127.0.0.1:8080" }] } },
    { channel: "default", proxy: { session: "ok", strategy: "round-robin", pool: [{ id: "a", server: "http://127.0.0.1:8080/path" }] } },
    { channel: "default", proxy: { session: "ok", strategy: "round-robin", pool: [{ id: "a", server: "http://127.0.0.1:8080?x=1" }] } },
    { channel: "default", proxy: { session: "ok", strategy: "round-robin", pool: [{ id: "a", server: "http://127.0.0.1" }] } },
    { channel: "default", proxy: { session: "ok", strategy: "round-robin", pool: [{ id: "a", server: "http://127.0.0.1:0" }] } },
    { channel: "default", proxy: { session: "ok", strategy: "round-robin", pool: [{ id: "a", server: "http://127.0.0.1:8080", credentialsFile: "/etc/passwd" }] } },
    { channel: "default", proxy: { session: "ok", strategy: "round-robin", pool: [{ id: "a", server: "http://127.0.0.1:8080", credentialsFile: "../escape.json" }] } },
    { channel: "default", proxy: { session: "ok", strategy: "round-robin", pool: [{ id: "a", server: "http://127.0.0.1:8080", credentialsFile: "a\\b.json" }] } },
  ];
  for (const cfg of badConfigs) {
    assert.throws(() => validateBrowserConfig(cfg));
  }

  // Non-proxy config remains completely unchanged.
  assert.equal(browserRuntimeInfo({ channel: "default" }).proxy, undefined);
});

test("race-resistant credential loader rejects unsafe modes, symlinks, hardlinks, and malformed JSON", (t) => {
  const dir = makeConfigDir(t);
  writeSecretFile(dir, "prometheus-proxy-secrets/good.json", { username: "proxyUser99", password: "SecretValue!99" });
  assert.deepEqual(readProxyCredentials(dir, "prometheus-proxy-secrets/good.json"), {
    username: "proxyUser99",
    password: "SecretValue!99",
  });

  // Mode 0644 credential file rejected.
  writeSecretFile(dir, "prometheus-proxy-secrets/open-file.json", { username: "u1", password: "p1" }, { fileMode: 0o644 });
  assert.throws(() => readProxyCredentials(dir, "prometheus-proxy-secrets/open-file.json"), /0600/);

  // Mode 0755 subdirectory rejected.
  writeSecretFile(dir, "open-dir/cred.json", { username: "u1", password: "p1" }, { dirMode: 0o755, fileMode: 0o600 });
  assert.throws(() => readProxyCredentials(dir, "open-dir/cred.json"), /0700/);

  // Direct credential file inside 0755 root rejected.
  const openRoot = makeConfigDir(t);
  writeSecretFile(openRoot, "direct.json", { username: "u1", password: "p1" }, { fileMode: 0o600 });
  fs.chmodSync(openRoot, 0o755);
  assert.throws(() => readProxyCredentials(openRoot, "direct.json"), /0700/);

  // Hardlink rejected (nlink > 1).
  const hardTarget = path.join(dir, "prometheus-proxy-secrets/hardlinked.json");
  fs.linkSync(path.join(dir, "prometheus-proxy-secrets/good.json"), hardTarget);
  assert.throws(() => readProxyCredentials(dir, "prometheus-proxy-secrets/hardlinked.json"), /hardlink/i);

  // Symlinked file & symlinked dir rejected.
  fs.symlinkSync(path.join(dir, "prometheus-proxy-secrets/good.json"), path.join(dir, "prometheus-proxy-secrets/sym.json"));
  assert.throws(() => readProxyCredentials(dir, "prometheus-proxy-secrets/sym.json"), /symlink/i);
  fs.symlinkSync(path.join(dir, "prometheus-proxy-secrets"), path.join(dir, "sym-dir"));
  assert.throws(() => readProxyCredentials(dir, "sym-dir/good.json"), /symlink/i);

  // Secret redaction scrubs credentials, basic base64, short secrets, paths, and proxy URLs.
  const creds = { username: "aliceProxy", password: "TopSecretPassword#42" };
  const b64 = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  const dirty = `Proxy-Authorization: Basic ${b64} to http://127.0.0.1:9999 via prometheus-proxy-secrets/good.json with aliceProxy / TopSecretPassword#42`;
  const clean = redactSecrets(dirty, {
    urls: ["http://127.0.0.1:9999"],
    literals: ["prometheus-proxy-secrets/good.json"],
    credentials: creds,
  });
  assert.doesNotMatch(clean, new RegExp(`${creds.username}|${creds.password}|${b64}|9999|good\\.json`));
});

test("round-robin allocation, wraparound, reorder, removal, endpoint change, corrupt registry, and crash locks", async (t) => {
  const dir = makeConfigDir(t);
  const pool = [
    { id: "proxy-a", server: "http://127.0.0.1:18001" },
    { id: "proxy-b", server: "http://127.0.0.1:18002" },
    { id: "proxy-c", server: "http://127.0.0.1:18003" },
  ];
  const cfg = (session) => ({ channel: "default", proxy: { session, strategy: "round-robin", pool } });

  // Uncreated session must not auto-allocate on task launch or login handoff.
  await assert.rejects(() => acquireTaskSession(dir, cfg("s1")), /does not exist/);
  await assert.rejects(() => issueLoginHandoff(dir, cfg("s1")), /does not exist/);

  assert.equal((await createSession(dir, cfg("s1"))).proxyId, "proxy-a");
  assert.equal((await createSession(dir, cfg("s2"))).proxyId, "proxy-b");

  // Reordering pool keeps s1 on proxy-a and advances cursor by nextProxyId ('proxy-c').
  const reorderedPool = [pool[1], pool[0], pool[2]];
  const reorderedCfg = (session) => ({ channel: "default", proxy: { session, strategy: "round-robin", pool: reorderedPool } });
  assert.equal((await createSession(dir, reorderedCfg("s3"))).proxyId, "proxy-c");
  // Next in reorderedPool after index 2 ('proxy-c') wraps to index 0 ('proxy-b').
  assert.equal((await createSession(dir, reorderedCfg("s4"))).proxyId, "proxy-b");

  // Removed cursor ID fails cleanly without guessing, then reconcile-cursor recovers.
  const withoutNext = [pool[0], pool[1]]; // cursor is 'proxy-a'? Wait: next after 'proxy-b' (idx 0 of reorderedPool) was 'proxy-a'!
  // Let's explicitly check cursor removal by omitting current nextProxyId.
  const currentNext = listSessions(dir).nextProxyId;
  const missingCursorPool = reorderedPool.filter((p) => p.id !== currentNext);
  const missingCursorCfg = (session) => ({ channel: "default", proxy: { session, strategy: "round-robin", pool: missingCursorPool } });
  await assert.rejects(() => createSession(dir, missingCursorCfg("s5")), /reconcile-cursor/);
  await reconcileCursor(dir, missingCursorCfg("s5"), { nextProxyId: missingCursorPool[0].id });
  assert.equal((await createSession(dir, missingCursorCfg("s5"))).proxyId, missingCursorPool[0].id);

  // Changing endpoint on s1 blocks launch without leaking endpoint, until reconcile-session.
  const driftedPool = [
    { id: "proxy-a", server: "http://127.0.0.1:19999" },
    pool[1],
    pool[2],
  ];
  const driftedCfg = { channel: "default", proxy: { session: "s1", strategy: "round-robin", pool: driftedPool } };
  await assert.rejects(
    () => acquireTaskSession(dir, driftedCfg),
    (err) => /endpoint changed/.test(err.message) && !err.message.includes("19999")
  );
  const reconciled = await reconcileSession(dir, driftedCfg, { session: "s1" });
  assert.equal(reconciled.generation, 2);
  const leaseAfterReconcile = await acquireTaskSession(dir, driftedCfg);
  assert.equal(leaseAfterReconcile.proxyId, "proxy-a");
  leaseAfterReconcile.release();

  // Sanitized views must never expose endpointFingerprint, timestamps, or server URLs.
  const listed = listSessions(dir);
  const shown = showSession(dir, "s1");
  for (const textView of [JSON.stringify(listed), JSON.stringify(shown)]) {
    assert.doesNotMatch(textView, /endpointFingerprint|createdAt|rotatedAt|18001|19999/);
  }

  // Concurrent multi-process allocation produces exact unique round-robin picks with no lost cursor updates.
  const concDir = makeConfigDir(t);
  writeBrowserSettings(concDir, { channel: "default", proxy: { session: "base", strategy: "round-robin", pool } });
  const cliPath = path.join(repoRoot, "scripts/browser-sessions.mjs");
  const concResults = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      execFileAsync(process.execPath, [cliPath, "create", `c${i}`], {
        env: { ...process.env, PROMETHEUS_CONFIG_DIR: concDir },
      })
    )
  );
  const assignedIds = concResults.map((r) => JSON.parse(r.stdout).proxyId);
  assert.deepEqual(
    assignedIds.slice().sort(),
    ["proxy-a", "proxy-a", "proxy-b", "proxy-b", "proxy-c", "proxy-c"]
  );

  // Real SIGKILLed writer holding registry.lock with open FD is reclaimed cleanly via OS identity + inode verification.
  const killedWriter = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { withRegistryLock } from ${JSON.stringify(new URL("../../scripts/opencode-browser-sessions.mjs", import.meta.url).href)};
       await withRegistryLock(${JSON.stringify(concDir)}, async () => {
         process.stdout.write("locked\\n");
         await new Promise(() => {});
       });`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  t.after(() => { try { killedWriter.kill("SIGKILL"); } catch {} });
  await new Promise((resolve, reject) => {
    let out = "";
    killedWriter.stdout.on("data", (d) => {
      out += d;
      if (out.includes("locked")) resolve();
    });
    killedWriter.once("exit", (c) => reject(new Error(`lock holder exited (${c})`)));
  });
  killedWriter.kill("SIGKILL");
  await new Promise((r) => killedWriter.once("exit", r));
  const reclaimed = await createSession(concDir, { channel: "default", proxy: { session: "c6", strategy: "round-robin", pool } });
  assert.ok(["proxy-a", "proxy-b", "proxy-c"].includes(reclaimed.proxyId));

  // CLI list / show / bind-auth / unbind-auth / rotate / reconcile-cursor work cleanly without exposing secrets/timestamps.
  const listCli = await execFileAsync(process.execPath, [cliPath, "list"], {
    env: { ...process.env, PROMETHEUS_CONFIG_DIR: concDir },
  });
  assert.doesNotMatch(listCli.stdout, /endpointFingerprint|createdAt|rotatedAt|18001|18002|18003/);
  saveState({
    configDir: concDir,
    name: "cli-auth",
    origins: ["https://example.com"],
    storageState: { cookies: [{ name: "c", value: "v", domain: "example.com", path: "/", secure: true }], origins: [] },
  });
  const boundCli = JSON.parse((await execFileAsync(process.execPath, [cliPath, "bind-auth", "c0", "cli-auth"], {
    env: { ...process.env, PROMETHEUS_CONFIG_DIR: concDir },
  })).stdout);
  assert.deepEqual(boundCli.authRecords, ["cli-auth"]);
  const shownCli = JSON.parse((await execFileAsync(process.execPath, [cliPath, "show", "c0"], {
    env: { ...process.env, PROMETHEUS_CONFIG_DIR: concDir },
  })).stdout);
  assert.deepEqual(shownCli.authRecords, ["cli-auth"]);
  const unboundCli = JSON.parse((await execFileAsync(process.execPath, [cliPath, "unbind-auth", "c0", "cli-auth"], {
    env: { ...process.env, PROMETHEUS_CONFIG_DIR: concDir },
  })).stdout);
  assert.deepEqual(unboundCli.authRecords, []);
  const rotCli = await execFileAsync(process.execPath, [cliPath, "rotate", "c0"], {
    env: { ...process.env, PROMETHEUS_CONFIG_DIR: concDir },
  });
  assert.equal(JSON.parse(rotCli.stdout).generation, 2);

  // Ambiguous (corrupt JSON) lock MUST fail closed and NOT be deleted.
  const lockPath = path.join(concDir, PROXY_SESSIONS_DIR, "registry.lock");
  fs.writeFileSync(lockPath, "{corrupt-lock", { mode: 0o600 });
  await assert.rejects(
    () => createSession(concDir, { channel: "default", proxy: { session: "c7", strategy: "round-robin", pool } }),
    /ambiguous/i
  );
  assert.equal(fs.existsSync(lockPath), true);
  fs.unlinkSync(lockPath);

  // Corrupt registry.json fails closed and is NEVER auto-reset.
  const regPath = path.join(concDir, PROXY_SESSIONS_DIR, "registry.json");
  const badJson = "{not-valid-registry-json";
  fs.writeFileSync(regPath, badJson, { mode: 0o600 });
  assert.throws(() => listSessions(concDir), /corrupt/);
  assert.equal(fs.readFileSync(regPath, "utf8"), badJson);
});

test("session ownership, generation checks, active rotation rejection, login handoff, and helper surviving task crash", async (t) => {
  const dir = makeConfigDir(t);
  const credRel = "prometheus-proxy-secrets/cred-a.json";
  writeSecretFile(dir, credRel, { username: "helperUser", password: "HelperPassword!1" });
  const cfg = {
    channel: testChannel,
    proxy: {
      session: "work",
      strategy: "round-robin",
      pool: [
        { id: "proxy-a", server: "http://127.0.0.1:18101", credentialsFile: credRel },
        { id: "proxy-b", server: "http://127.0.0.1:18102" },
      ],
    },
  };
  writeBrowserSettings(dir, cfg);
  await createSession(dir, cfg);

  // Login browser config must NOT auto-select external-cdp when proxy is enabled.
  assert.equal(login.loginBrowserConfig(cfg).executionMode, undefined);

  // Start external owner subprocess holding task ownership.
  const ownerChild = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { acquireTaskSession } from ${JSON.stringify(new URL("../../scripts/opencode-browser-sessions.mjs", import.meta.url).href)};
       const lease = await acquireTaskSession(${JSON.stringify(dir)}, ${JSON.stringify(cfg)});
       process.stdout.write(JSON.stringify({ ownerId: lease.ownerId, generation: lease.generation }) + '\\n');
       setInterval(() => {}, 10000);`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  t.after(() => { try { ownerChild.kill("SIGKILL"); } catch {} });
  const ownerLine = await new Promise((resolve, reject) => {
    let out = "";
    ownerChild.stdout.on("data", (d) => {
      out += d;
      if (out.includes("\n")) resolve(JSON.parse(out.trim()));
    });
    ownerChild.once("exit", (code) => reject(new Error(`owner exited early (${code})`)));
  });

  // Rotation is refused while task owner is alive.
  await assert.rejects(() => rotateSession(dir, cfg), /active browser task owner/);

  // Handoff capability is single-use, private, and joins helper child.
  const handoff = await issueLoginHandoff(dir, cfg, { expectedOwnerId: ownerLine.ownerId });
  assert.equal(handoff.generation, 1);

  const helperChild = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { joinLoginHelper } from ${JSON.stringify(new URL("../../scripts/opencode-browser-sessions.mjs", import.meta.url).href)};
       const helper = await joinLoginHelper(${JSON.stringify(dir)}, ${JSON.stringify(cfg)}, ${JSON.stringify({ session: "work", handoffId: handoff.handoffId })});
       process.stdout.write(JSON.stringify({ helperId: helper.helperId, generation: helper.generation, proxyId: helper.proxyId }) + '\\n');
       setInterval(() => {}, 10000);`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  t.after(() => { try { helperChild.kill("SIGKILL"); } catch {} });
  const helperLine = await new Promise((resolve, reject) => {
    let out = "";
    helperChild.stdout.on("data", (d) => {
      out += d;
      if (out.includes("\n")) resolve(JSON.parse(out.trim()));
    });
    helperChild.once("exit", (code) => reject(new Error(`helper exited early (${code})`)));
  });
  assert.equal(helperLine.proxyId, "proxy-a");

  // Replaying consumed handoff must fail.
  await assert.rejects(
    () => joinLoginHelper(dir, cfg, { session: "work", handoffId: handoff.handoffId }),
    /consumed|missing/i
  );

  // Expired / tampered handoffs must fail.
  const shortHandoff = await issueLoginHandoff(dir, cfg, { ttlMs: 1 });
  await new Promise((r) => setTimeout(r, 25));
  await assert.rejects(
    () => joinLoginHelper(dir, cfg, { session: "work", handoffId: shortHandoff.handoffId }),
    /expired/i
  );

  // Kill the task owner with SIGKILL while login helper survives: rotation MUST STILL BE REFUSED!
  ownerChild.kill("SIGKILL");
  await new Promise((r) => ownerChild.once("exit", r));
  await assert.rejects(() => rotateSession(dir, cfg), /login helper is active/);

  // Once helper closes, rotation succeeds, advances to proxy-b, and clears authRecords unless --retain-associations.
  helperChild.kill("SIGKILL");
  await new Promise((r) => helperChild.once("exit", r));

  saveState({
    configDir: dir,
    name: "acct-gen1",
    origins: ["https://example.com"],
    storageState: { cookies: [{ name: "sid", value: "v1", domain: "example.com", path: "/", secure: true }], origins: [] },
  });
  await bindAuthRecord(dir, "work", "acct-gen1");
  const rotated1 = await rotateSession(dir, cfg);
  assert.equal(rotated1.generation, 2);
  assert.equal(rotated1.proxyId, "proxy-b");
  assert.deepEqual(rotated1.authRecords, []);
  assert.ok(statMetadata(dir, "acct-gen1"), "saved auth state file is preserved across rotation");

  await bindAuthRecord(dir, "work", "acct-gen1");
  const rotated2 = await rotateSession(dir, cfg, { retainAssociations: true });
  assert.equal(rotated2.generation, 3);
  assert.equal(rotated2.proxyId, "proxy-a");
  assert.deepEqual(rotated2.authRecords, ["acct-gen1"]);
  assert.ok(rotated2.warnings?.length > 0);
});

for (const poolSource of ["json", "text"]) {
test(`${poolSource}: end-to-end Playwright MCP HTTP proxy, transfers, target 401 non-leak, hydration filtering, 407, proxy-down, and non-replay`, async (t) => {
  const dir = makeConfigDir(t);
  const proxyCreds = { username: "proxyAuthUser77", password: "ProxyAuthPassword#77" };
  const credRel = "prometheus-proxy-secrets/proxy-a.json";
  writeSecretFile(dir, credRel, proxyCreds);

  const proxyA = createAuthProxyFixture(t, proxyCreds);
  const proxyAUrl = await proxyA.start();
  const proxyB = createAuthProxyFixture(t);
  const proxyBUrl = await proxyB.start();

  // Destination HTTP server tracking received auth headers and actions.
  let directHitsWhenProxyDown = 0;
  let proxyDownArmed = false;
  let nonIdempotentPostCount = 0;
  const targetReceivedAuth = [];
  const uploadedBytes = [];
  const targetServer = http.createServer((req, res) => {
    if (proxyDownArmed) directHitsWhenProxyDown += 1;
    targetReceivedAuth.push({
      url: req.url,
      authorization: req.headers["authorization"] || null,
      proxyAuthorization: req.headers["proxy-authorization"] || null,
    });
    if (req.url === "/require-target-auth") {
      res.writeHead(401, {
        "WWW-Authenticate": 'Basic realm="Destination"',
        "Content-Type": "text/plain",
      });
      res.end("Target Auth Required");
      return;
    }
    if (req.url === "/forbidden") {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }
    if (req.url === "/home") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html><html><body>
        <h1>Proxy Home</h1>
        <img id="logo" src="/asset.png" width="10" height="10" />
        <a id="dl" href="/download.bin" download="item.bin">Download</a>
        <a id="pop" href="/popup" target="_blank">Popup</a>
        <iframe id="sub" src="/frame"></iframe>
        <form action="/upload" method="post" enctype="multipart/form-data">
          <input id="fileInput" type="file" name="media" />
          <button id="submitBtn" type="submit">Send</button>
        </form>
        <button id="postBtn" onclick="fetch('/submit-once', {method:'POST'})">Submit</button>
      </body></html>`);
      return;
    }
    if (req.url === "/asset.png" || req.url === "/asset.png?url-download=1") {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(TINY_PNG);
      return;
    }
    if (req.url === "/download.bin") {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="item.bin"',
      });
      res.end(Buffer.from("proxied-download-bytes-ok"));
      return;
    }
    if (req.url === "/popup") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><div id='popup-ok'>Popup Ready</div></body></html>");
      return;
    }
    if (req.url === "/frame") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><div id='frame-ok'>Frame Ready</div></body></html>");
      return;
    }
    if (req.url === "/upload" && req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        uploadedBytes.push(Buffer.concat(chunks));
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><div id='uploaded'>Uploaded</div></body></html>");
      });
      return;
    }
    if (req.url === "/submit-once" && req.method === "POST") {
      nonIdempotentPostCount += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ count: nonIdempotentPostCount }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><body><div id='ok'>OK</div></body></html>");
  });
  await new Promise((resolve) => targetServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((r) => targetServer.close(() => r())));
  const targetOrigin = `http://127.0.0.1:${targetServer.address().port}`;

  const cfg = {
    channel: testChannel,
    executionMode: testMode,
    automationCompatibility: true,
    proxy: {
      session: "shopping",
      strategy: "round-robin",
      pool: [
        { id: "proxy-a", server: proxyAUrl, credentialsFile: credRel },
        { id: "proxy-b", server: proxyBUrl },
      ],
    },
  };
  const proxyIds = configurePoolSource(dir, cfg, poolSource);
  writeBrowserSettings(dir, cfg);
  await createSession(dir, cfg);

  // Seed unrelated saved auth state on same origin/https test, ensuring proxy session ignores unbound state.
  saveState({
    configDir: dir,
    name: "unrelated-state",
    origins: ["https://example.com"],
    storageState: { cookies: [{ name: "leak", value: "must-not-load", domain: "example.com", path: "/", secure: true }], origins: [] },
  });

  let mcp = spawnMcpClient({ PROMETHEUS_CONFIG_DIR: dir }, { captureStderr: true });
  t.after(async () => { await mcp.close().catch(() => {}); });

  await mcp.rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "proxy-test", version: "1.0" },
  });

  // Pre-launch status is sanitized and does not reveal secrets/URLs.
  const preStatus = JSON.parse(mcp.textOf(await mcp.call("browser_status")));
  assert.deepEqual(preStatus.proxy, {
    enabled: true,
    session: "shopping",
    generation: 1,
    proxyId: proxyIds["proxy-a"],
    routing: "configured",
  });
  assert.doesNotMatch(JSON.stringify(preStatus), /proxyAuthUser77|ProxyAuthPassword|credentialsFile|endpointFingerprint|18202/);
  assert.equal(JSON.stringify(preStatus).includes(proxyAUrl), false);


  // Navigate to home page via authenticated HTTP proxy + exercise frame, popup, upload, download, media save.
  const navRes = await mcp.call("browser_navigate", { url: `${targetOrigin}/home` });
  assert.equal(navRes.isError, undefined);
  assert.match(mcp.textOf(navRes), /status 200/);

  const postStatus = JSON.parse(mcp.textOf(await mcp.call("browser_status")));
  assert.equal(postStatus.contextOpen, true);
  assert.deepEqual(postStatus.proxy, preStatus.proxy);

  // Closing and reopening the browser, then restarting the MCP process, retains the assignment and cursor.
  assert.equal((await mcp.call("browser_close")).isError, undefined);
  assert.equal((await mcp.call("browser_navigate", { url: `${targetOrigin}/after-close` })).isError, undefined);
  assert.deepEqual(JSON.parse(mcp.textOf(await mcp.call("browser_status"))).proxy, preStatus.proxy);
  await mcp.call("browser_close");
  await mcp.close();
  const restarted = spawnMcpClient({ PROMETHEUS_CONFIG_DIR: dir }, { captureStderr: true });
  t.after(async () => { await restarted.close().catch(() => {}); });
  await restarted.rpc("initialize", {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "proxy-restart-test", version: "1.0" },
  });
  assert.equal((await restarted.call("browser_navigate", { url: `${targetOrigin}/after-restart` })).isError, undefined);
  assert.deepEqual(JSON.parse(restarted.textOf(await restarted.call("browser_status"))).proxy, preStatus.proxy);
  assert.equal(listSessions(dir).nextProxyId, proxyIds["proxy-b"]);
  assert.ok(proxyA.httpRequests.some((r) => r.url.endsWith("/after-restart")));
  assert.equal(proxyB.httpRequests.length + proxyB.connectRequests.length, 0);
  mcp = restarted;
  assert.equal((await mcp.call("browser_navigate", { url: `${targetOrigin}/home` })).isError, undefined);

  // Frame text extraction goes through proxy.
  const framesRes = JSON.parse(mcp.textOf(await mcp.call("browser_frames")));
  assert.equal(Array.isArray(framesRes) && framesRes.length >= 2, true);

  // Save visible media and download files through proxy.
  const artifactDir = makeConfigDir(t, "prometheus-artifacts-");
  const mediaOut = path.join(artifactDir, "saved-logo.png");
  const assetOut = path.join(artifactDir, "asset.png");
  const dlOut = path.join(artifactDir, "downloaded.bin");
  const saveMediaRes = await mcp.call("browser_save_media", {
    selector: "#logo",
    path: mediaOut,
  });
  assert.equal(saveMediaRes.isError, undefined);
  assert.match(mcp.textOf(saveMediaRes), /saved to/);
  assert.ok(fs.statSync(mediaOut).size > 0);

  const assetDlRes = await mcp.call("browser_download", {
    url: `${targetOrigin}/asset.png?url-download=1`,
    path: assetOut,
    expected_sha256: crypto.createHash("sha256").update(TINY_PNG).digest("hex"),
  });
  assert.equal(assetDlRes.isError, undefined);
  assert.equal(Buffer.compare(fs.readFileSync(assetOut), TINY_PNG), 0);
  assert.ok(proxyA.httpRequests.some((r) => r.url === `${targetOrigin}/asset.png?url-download=1`), "URL download itself must traverse the pinned proxy");

  const dlRes = await mcp.call("browser_download", {
    selector: "#dl",
    path: dlOut,
  });
  assert.equal(dlRes.isError, undefined);
  assert.equal(fs.readFileSync(dlOut, "utf8"), "proxied-download-bytes-ok");

  const uploadSource = path.join(artifactDir, "upload.png");
  fs.writeFileSync(uploadSource, TINY_PNG);
  await mcp.call("browser_upload_image", { selector: "#fileInput", path: uploadSource });
  await mcp.call("browser_click", { selector: "#submitBtn", expect: { kind: "visible", selector: "#uploaded" } });
  assert.equal(uploadedBytes.length >= 1, true);
  assert.equal(uploadedBytes[0].includes(TINY_PNG), true);
  for (const pathname of ["/asset.png", "/download.bin", "/upload"]) {
    assert.ok(proxyA.httpRequests.some((r) => new URL(r.url).pathname === pathname), `${pathname} must traverse the pinned proxy`);
  }

  // Target HTTP 401 + WWW-Authenticate: Basic must NEVER receive proxy credentials!
  const target401Res = await mcp.call("browser_navigate", { url: `${targetOrigin}/require-target-auth` });
  const target401Text = mcp.textOf(target401Res);
  assert.match(target401Text, /access denied/i);
  assert.doesNotMatch(target401Text, /407|proxy authentication/i);
  const forbidden = await mcp.call("browser_navigate", { url: `${targetOrigin}/forbidden` });
  assert.match(mcp.textOf(forbidden), /access denied/i);
  assert.deepEqual(JSON.parse(mcp.textOf(await mcp.call("browser_status"))).proxy, preStatus.proxy);
  assert.equal(listSessions(dir).nextProxyId, proxyIds["proxy-b"]);
  assert.equal(proxyB.httpRequests.length + proxyB.connectRequests.length, 0);
  assert.ok(proxyA.httpRequests.length > 0);
  assert.ok(proxyA.httpRequests.every((r) => r.proxyAuth !== null));
  for (const hit of targetReceivedAuth) {
    assert.equal(hit.authorization, null, "proxy credentials must NEVER leak to destination Authorization");
    assert.equal(hit.proxyAuthorization, null, "Proxy-Authorization must NEVER reach destination");
  }

  // Proxy HTTP 407 failure is classified clearly without falling back or leaking secrets/URLs or rotating.
  proxyA.setForce407(true);
  const res407 = await mcp.call("browser_navigate", { url: `${targetOrigin}/after-407` });
  assert.equal(res407.isError, true);
  const err407 = mcp.textOf(res407);
  assert.match(err407, /407|proxy authentication/i);
  assert.doesNotMatch(err407, /proxyAuthUser77|ProxyAuthPassword/);
  assert.equal(err407.includes(proxyAUrl), false);
  assert.equal(showSession(dir, "shopping").generation, 1);
  assert.equal(showSession(dir, "shopping").proxyId, proxyIds["proxy-a"]);
  assert.equal(targetReceivedAuth.some((r) => r.url === "/after-407"), false);
  assert.equal(listSessions(dir).nextProxyId, proxyIds["proxy-b"]);
  assert.equal(proxyB.httpRequests.length + proxyB.connectRequests.length, 0);
  const tab407 = await mcp.call("browser_tab_new", { url: `${targetOrigin}/tab-after-407` });
  assert.equal(tab407.isError, true);
  assert.match(mcp.textOf(tab407), /407|proxy authentication/i);
  assert.doesNotMatch(mcp.textOf(tab407), /access denied|proxyAuthUser77|ProxyAuthPassword/i);
  assert.equal(targetReceivedAuth.some((r) => r.url === "/tab-after-407"), false);
  assert.equal(showSession(dir, "shopping").generation, 1);
  assert.equal(showSession(dir, "shopping").proxyId, proxyIds["proxy-a"]);
  assert.equal(proxyB.httpRequests.length + proxyB.connectRequests.length, 0);
  proxyA.setForce407(false);

  // Return to home page cleanly before shutting down upstream proxy to test interrupted action non-replay + proxy-down.
  assert.equal((await mcp.call("browser_navigate", { url: `${targetOrigin}/home` })).isError, undefined);
  await proxyA.close();
  proxyDownArmed = true;
  const interruptedClick = await mcp.call("browser_click", {
    selector: "#postBtn",
    expect: { kind: "response", path: "/submit-once" },
    timeout: 1,
  });
  const clickText = mcp.textOf(interruptedClick);
  assert.equal(
    interruptedClick.isError === true || /proxy_connection|proxy failure|unknown|unresolved/i.test(clickText),
    true
  );
  assert.equal(nonIdempotentPostCount, 0, "interrupted POST must not succeed directly or replay automatically");
  const downNav = await mcp.call("browser_navigate", { url: `${targetOrigin}/when-proxy-down` });
  assert.equal(downNav.isError, true);
  assert.match(mcp.textOf(downNav), /proxy connection failed/i);
  assert.equal(directHitsWhenProxyDown, 0, "proxy failure MUST NOT fall back to a direct connection");
  assert.equal(showSession(dir, "shopping").proxyId, proxyIds["proxy-a"]);
  assert.equal(listSessions(dir).nextProxyId, proxyIds["proxy-b"]);
  assert.equal(proxyB.httpRequests.length + proxyB.connectRequests.length, 0);
  assert.doesNotMatch(mcp.errors(), /proxyAuthUser77|ProxyAuthPassword/);
});

test(`${poolSource}: HTTPS CONNECT tunnel routes through authenticated proxy without leaking proxy credentials on target 401, and classifies CONNECT 407`, async (t) => {
  const dir = makeConfigDir(t);
  const certInfo = generateSelfSignedCert(t, dir);
  const proxyCreds = { username: "connectUser88", password: "ConnectPassword#88" };
  const credRel = "prometheus-proxy-secrets/connect.json";
  writeSecretFile(dir, credRel, proxyCreds);

  const proxy = createAuthProxyFixture(t, proxyCreds);
  const proxyUrl = await proxy.start();

  const tlsReceivedAuth = [];
  let directHitsWhen407 = 0;
  let arm407 = false;
  const httpsServer = https.createServer({ key: certInfo.key, cert: certInfo.cert }, (req, res) => {
    if (arm407) directHitsWhen407 += 1;
    tlsReceivedAuth.push({
      url: req.url,
      authorization: req.headers["authorization"] || null,
      proxyAuthorization: req.headers["proxy-authorization"] || null,
    });
    if (req.url === "/tls-401") {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="TLSOrigin"' });
      res.end("TLS Unauthorized");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><body><h1 id='tls-ok'>TLS Tunnel OK</h1></body></html>");
  });
  await new Promise((resolve) => httpsServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((r) => httpsServer.close(() => r())));
  const httpsOrigin = `https://127.0.0.1:${httpsServer.address().port}`;

  const cfg = {
    channel: testChannel,
    executionMode: testMode,
    proxy: {
      session: "tls-sess",
      strategy: "round-robin",
      pool: [{ id: "proxy-tls", server: proxyUrl, credentialsFile: credRel }],
    },
  };
  configurePoolSource(dir, cfg, poolSource);
  await createSession(dir, cfg);

  // Test-only SPKI pin allows strict Chromium TLS verification of our ephemeral self-signed localhost fixture.
  const spkiChromium = Object.create(chromium);
  spkiChromium.launch = (opts) => {
    assert.equal(opts.headless, testMode === "headless", "qualified task mode must reach the real launch");
    return chromium.launch({
      ...opts,
      args: [...(opts.args || []), `--ignore-certificate-errors-spki-list=${certInfo.spkiPin}`],
    });
  };

  const { browser, context, proxyRelay, getCaptchaProxy } = await createTaskContext(spkiChromium, cfg, undefined, { configDir: dir });
  assert.deepEqual(getCaptchaProxy(), { server: proxyUrl, credentials: proxyCreds });
  const copy = getCaptchaProxy(); copy.credentials.password = "changed";
  assert.deepEqual(getCaptchaProxy(), { server: proxyUrl, credentials: proxyCreds }, "solver receives a copy of the pinned upstream credentials, not the loopback relay");
  t.after(async () => { await browser.close().catch(() => {}); });
  t.diagnostic(JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    playwright: JSON.parse(fs.readFileSync(path.join(repoRoot, "node_modules/playwright/package.json"), "utf8")).version,
    channel: testChannel,
    mode: testMode,
    browser: browser.version(),
  }));

  const page = await context.newPage();
  const okResp = await page.goto(`${httpsOrigin}/ok`);
  assert.equal(okResp.status(), 200);
  assert.equal(await page.textContent("#tls-ok"), "TLS Tunnel OK");

  let auth401Resp = null;
  try {
    auth401Resp = await page.goto(`${httpsOrigin}/tls-401`);
  } catch (error) {
    assert.match(String(error), /ERR_INVALID_AUTH_CREDENTIALS/);
  }
  if (auth401Resp) {
    assert.equal(auth401Resp.status(), 401);
  }
  assert.ok(proxy.connectRequests.length >= 1);
  assert.ok(proxy.connectRequests.every((c) => c.proxyAuth !== null));
  for (const hit of tlsReceivedAuth) {
    assert.equal(hit.authorization, null, "HTTPS target 401 MUST NOT receive proxy credentials");
    assert.equal(hit.proxyAuthorization, null);
  }

  // Upstream CONNECT 407 on a fresh host (avoiding pooled keep-alive tunnel) fails immediately and classifies cleanly without direct fallback.
  proxyRelay.clearLastFailure();
  proxy.setForce407(true);
  arm407 = true;
  const freshOrigin = `https://localhost:${httpsServer.address().port}`;
  await assert.rejects(() => page.goto(`${freshOrigin}/blocked`, { timeout: 5000 }));
  assert.equal(proxyRelay.getLastFailure()?.kind, "proxy_auth");
  assert.equal(directHitsWhen407, 0);
});

test(`${poolSource}: hydration filters strictly by session generation and login helper binds after save without leaking or rotating`, async (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "px-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const certInfo = generateSelfSignedCert(t, dir);
  const proxyCreds = { username: "loginUser55", password: "LoginPassword#55" };
  const credRel = "prometheus-proxy-secrets/login-proxy.json";
  writeSecretFile(dir, credRel, proxyCreds);

  const proxyA = createAuthProxyFixture(t, proxyCreds);
  const proxyAUrl = await proxyA.start();

  const httpsServer = https.createServer({ key: certInfo.key, cert: certInfo.cert }, (req, res) => {
    if (req.url === "/login") {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Set-Cookie": "session_tok=secret-cookie-value; Path=/; HttpOnly; Secure",
      });
      res.end("<html><body><script>localStorage.setItem('k', 'v');</script><div id='logged'>Signed In</div></body></html>");
      return;
    }
    const hasCookie = (req.headers.cookie || "").includes("session_tok=secret-cookie-value");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      hasCookie
        ? "<html><body><div id='acct-badge'>Authenticated</div></body></html>"
        : "<html><body><div id='guest'>Guest</div></body></html>"
    );
  });
  await new Promise((resolve) => httpsServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((r) => httpsServer.close(() => r())));
  const httpsOrigin = `https://127.0.0.1:${httpsServer.address().port}`;

  const cfg = {
    channel: testChannel,
    executionMode: testMode,
    proxy: {
      session: "acct-session",
      strategy: "round-robin",
      pool: [
        { id: "proxy-a", server: proxyAUrl, credentialsFile: credRel },
        { id: "proxy-b", server: "http://127.0.0.1:18302" },
      ],
    },
  };
  const proxyIds = configurePoolSource(dir, cfg, poolSource);
  writeBrowserSettings(dir, cfg);
  await createSession(dir, cfg);

  // Unassociated state on SAME origin must NOT be hydrated!
  saveState({
    configDir: dir,
    name: "unbound-same-origin",
    origins: [httpsOrigin],
    storageState: {
      cookies: [{ name: "session_tok", value: "secret-cookie-value", domain: "127.0.0.1", path: "/", secure: true }],
      origins: [],
    },
    verification: { selector: "#acct-badge" },
  });

  // Exercise the production MCP hydration filter against the unbound same-origin state.
  const assertGuest = async () => {
    const mcp = spawnMcpClient({ PROMETHEUS_CONFIG_DIR: dir, TEST_PROXY_SPKI: certInfo.spkiPin, NODE_OPTIONS: `--import=${path.join(repoRoot, "tests/integration/browser_proxy_spki_preload.mjs")}` }, { captureStderr: true });
    try {
      assert.equal((await mcp.call("browser_navigate", { url: `${httpsOrigin}/account` })).isError, undefined);
      const snapshot = mcp.textOf(await mcp.call("browser_snapshot"));
      assert.match(snapshot, /Guest/);
      assert.doesNotMatch(snapshot, /Authenticated/);
    } finally { await mcp.close(); }
  };
  await assertGuest();

  const issued = await issueLoginHandoff(dir, cfg);
  assert.equal(issued.generation, 1);

  const workerHarness = path.join(dir, "login-worker-test.mjs");
  const playwrightUrl = pathToFileURL(path.join(repoRoot, "node_modules/playwright/index.mjs")).href;
  fs.writeFileSync(
    workerHarness,
    `import { chromium } from ${JSON.stringify(playwrightUrl)};
     import { serveLogin } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "scripts/opencode-browser-login.mjs")).href)};
     const spkiChromium = Object.create(chromium);
     spkiChromium.launchPersistentContext = (userDataDir, opts) => chromium.launchPersistentContext(userDataDir, {
       ...opts,
       headless: ${JSON.stringify(testMode === "headless")},
       args: [...(opts.args || []), ${JSON.stringify(`--ignore-certificate-errors-spki-list=${certInfo.spkiPin}`)}],
     });
     process.once('message', (opts) => { void serveLogin(opts, { chromium: spkiChromium }); });`,
    { mode: 0o700 }
  );

  const started = await login.startLogin(
    {
      configDir: dir,
      name: "a1",
      url: `${httpsOrigin}/login`,
      origins: [httpsOrigin],
      captureSessionStorage: false,
      browser: cfg,
      session: "acct-session",
      handoffId: issued.handoffId,
    },
    { fork: (_f, args, opts) => fork(workerHarness, args, opts) }
  );
  assert.equal(started.status, "awaiting-user");

  // Confirm proxy saw the login navigation through proxy-a without consuming cursor (proxyId still proxy-a, nextProxyId still proxy-b).
  assert.equal(showSession(dir, "acct-session").proxyId, proxyIds["proxy-a"]);
  assert.equal(showSession(dir, "acct-session").generation, issued.generation);
  assert.equal(listSessions(dir).nextProxyId, proxyIds["proxy-b"]);
  assert.ok(proxyA.connectRequests.length > 0, "login navigation must traverse the pinned proxy");

  // Rotation is refused while login window is awaiting user.
  await assert.rejects(() => rotateSession(dir, cfg), /login helper is active/);

  // Complete capture -> saves state and binds a1 to generation 1 ONLY.
  const completed = await login.loginCommand(dir, "a1", "complete");
  assert.equal(completed.status, "saved");
  assert.deepEqual(showSession(dir, "acct-session").authRecords, ["a1"]);

  // Replace proxy credentials on disk WITHOUT rotation; next task browser authenticates using updated creds on gen 1.
  const updatedUser = poolSource === "text" ? proxyCreds.username : "updatedUser66";
  if (poolSource === "text") {
    const file = path.join(dir, "proxies.txt");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(proxyCreds.password, "UpdatedPassword#66"));
  } else {
    writeSecretFile(dir, credRel, { username: updatedUser, password: "UpdatedPassword#66" });
  }
  proxyA.setCredentials(updatedUser, "UpdatedPassword#66");
  const spkiTaskChromium = Object.create(chromium);
  spkiTaskChromium.launch = (opts) =>
    chromium.launch({
      ...opts,
      args: [...(opts.args || []), `--ignore-certificate-errors-spki-list=${certInfo.spkiPin}`],
    });
  const reopened = await createTaskContext(spkiTaskChromium, cfg, undefined, { configDir: dir });
  try {
    assert.equal(reopened.proxySession.generation, 1);
    assert.equal(reopened.proxySession.proxyId, proxyIds["proxy-a"]);
    const allowed = getSessionAuthRecords(dir, "acct-session").authRecords;
    assert.deepEqual(allowed, ["a1"]);
    const loaded = loadStateForOrigin({ configDir: dir, name: allowed[0], origin: httpsOrigin });
    assert.ok(loaded);
    await hydrateBrowserState(reopened.context, loaded);
    const page = await reopened.context.newPage();
    await page.goto(`${httpsOrigin}/account`);
    assert.equal(await page.textContent("#acct-badge"), "Authenticated");
  } finally {
    await reopened.browser.close();
  }

  // Verify rotation drops association cleanly while preserving saved state on disk.
  const rot = await rotateSession(dir, cfg);
  assert.equal(rot.generation, 2);
  assert.deepEqual(rot.authRecords, []);
  assert.deepEqual(getSessionAuthRecords(dir, "acct-session").authRecords, []);
  assert.ok(statMetadata(dir, "a1"));
  assert.ok(statMetadata(dir, "unbound-same-origin"));
});
}

test("staged install and probe ignore proxy secrets/allocation and block unsafe cutover", async (t) => {
  const dir = makeConfigDir(t);
  const root = path.join(dir, "config");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const credRel = "prometheus-proxy-secrets/stage-cred.json";
  const pool = [{ id: "proxy-stage", server: "http://127.0.0.1:18444", credentialsFile: credRel }];
  // Deliberately DO NOT create credRel yet — installer probe must succeed WITHOUT reading proxy credentials or allocating sessions!
  writeBrowserSettings(root, {
    channel: testChannel,
    executionMode: "headless",
    proxy: { session: "stage-sess", strategy: "round-robin", pool },
  });

  const capturedProbes = [];
  await profile("install", {
    root,
    quiescent: true,
    prepare() {},
    verify(stage, cfg) {
      // Call verifyRuntime-like check by running browser-profile without custom verify mock? Actually verify(stage, cfg) receives raw cfg,
      // so let's also run a real staged probe via empty node_modules/package check or test browser-profile real verify!
      capturedProbes.push({ stage, cfg });
    },
  });
  assert.equal(fs.existsSync(path.join(root, PROXY_SESSIONS_DIR, "registry.json")), false, "installer must not allocate or touch session registry");

  // Now create session, hold task owner, and verify browser-profile quiescence refuses install/rollback/remove.
  writeSecretFile(root, credRel, { username: "stageUser", password: "StagePassword#9" });
  const cfg = JSON.parse(fs.readFileSync(path.join(root, "prometheus-browser.json"), "utf8"));
  await createSession(root, cfg);
  const lease = await acquireTaskSession(root, cfg);
  t.after(() => lease.release());

  assert.throws(
    () => profile("remove", { root, quiescent: true, prepare() {}, verify() {} }),
    /Active proxy session owners/
  );
  lease.release();

  // Verify insecure 0755 prometheus-proxy-secrets directory is rejected by installer.
  fs.chmodSync(path.join(root, "prometheus-proxy-secrets"), 0o755);
  assert.throws(
    () => profile("install", { root, quiescent: true, prepare() {}, verify() {} }),
    () => true
  );
  fs.chmodSync(path.join(root, "prometheus-proxy-secrets"), 0o700);

  // Verify real subprocess verifyRuntime (without mocked verify) runs cleanly without credentialsFile or allocating session!
  const cleanRoot = makeConfigDir(t);
  writeBrowserSettings(cleanRoot, {
    channel: testChannel,
    executionMode: "headless",
    proxy: { session: "real-probe-sess", strategy: "round-robin" },
  });
  await profile("install", {
    root: cleanRoot,
    quiescent: true,
  });
  assert.equal(fs.existsSync(path.join(cleanRoot, PROXY_SESSIONS_DIR, "registry.json")), false);
  const installedMcp = path.join(cleanRoot, "prometheus-browser/opencode-playwright-mcp.mjs");
  assert.equal(fs.existsSync(path.join(cleanRoot, "prometheus-browser/opencode-browser-sessions.mjs")), true);
  assert.equal(fs.existsSync(path.join(cleanRoot, "prometheus-browser/browser-sessions.mjs")), true);
  assert.equal(fs.existsSync(path.join(cleanRoot, "prometheus-browser/opencode-browser-proxy-list.mjs")), true);
  assert.equal(fs.existsSync(path.join(cleanRoot, "prometheus-browser/proxies.txt.example")), true);

  // Verify installed MCP server lists no leaked proxy secrets/URLs on browser_status.
  fs.writeFileSync(path.join(cleanRoot, "proxies.txt"), "127.0.0.1:18444:stageUser:StagePassword#9\n", { mode: 0o600 });
  await createSession(cleanRoot, {
    channel: testChannel,
    executionMode: "headless",
    proxy: { session: "real-probe-sess", strategy: "round-robin" },
  });
  const mcp = spawnMcpClient({ PROMETHEUS_CONFIG_DIR: cleanRoot }, { server: installedMcp, captureStderr: true });
  t.after(async () => { await mcp.close().catch(() => {}); });
  await mcp.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "staged", version: "1.0" } });
  const stagedStatus = mcp.textOf(await mcp.call("browser_status"));
  assert.match(stagedStatus, /"session":"real-probe-sess"/);
  assert.doesNotMatch(stagedStatus, /18444|stage-cred|endpointFingerprint/);
});
