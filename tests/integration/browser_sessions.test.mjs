import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runBrowserSessionsCli } from "../../scripts/browser-sessions.mjs";
import {
  acquireTaskSession,
  bindAuthRecord,
  createSession,
  diagnoseSessions,
  issueLoginHandoff,
  joinLoginHelper,
  listSessions,
  PROXY_SESSIONS_DIR,
  reconcileSession,
  rotateSession,
  withRegistryLock,
} from "../../scripts/opencode-browser-sessions.mjs";
import { createTaskContext } from "../../scripts/opencode-browser-runtime.mjs";
import { saveState } from "../../scripts/opencode-browser-state.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "prometheus-sessions-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = {
    channel: "default",
    executionMode: "headless",
    proxy: {
      session: "work",
      strategy: "round-robin",
      pool: [
        { id: "a", server: "http://private-proxy.invalid:18001", credentialsFile: "secrets/distinctive-secret.json" },
        { id: "b", server: "http://other-private-proxy.invalid:18002" },
      ],
    },
  };
  fs.mkdirSync(path.join(dir, "secrets"), { mode: 0o700 });
  fs.writeFileSync(path.join(dir, cfg.proxy.pool[0].credentialsFile), JSON.stringify({
    username: "DistinctiveProxyUser", password: "DistinctiveProxyPassword!",
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "prometheus-browser.json"), JSON.stringify(cfg), { mode: 0o600 });
  return { dir, cfg, registryPath: path.join(dir, PROXY_SESSIONS_DIR, "registry.json") };
}

// Ignore access times: reads may update them, but no bytes, names, identities,
// permissions, modification times, or change times may change.
function snapshot(dir) {
  return fs.readdirSync(dir).sort().map((name) => {
    const file = path.join(dir, name);
    const st = fs.lstatSync(file, { bigint: true });
    return [name, st.mode, st.ino, st.mtimeNs, st.ctimeNs,
      st.isDirectory() ? snapshot(file) : st.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file)];
  });
}

function assertPrivate(report) {
  assert.doesNotMatch(JSON.stringify(report), /private-proxy|18001|18002|DistinctiveProxy|distinctive-secret|endpointFingerprint|startSignature|token|pid|createdAt|rotatedAt/);
}

function seedAuth(dir) {
  saveState({
    configDir: dir,
    name: "account",
    origins: ["https://example.com"],
    storageState: { cookies: [], origins: [] },
  });
}

test("session doctor reports an uncreated registry without creating files and returns a failing CLI status", async (t) => {
  const { dir, cfg } = fixture(t);
  const before = snapshot(dir);
  const report = diagnoseSessions(dir, cfg);
  assert.equal(report.ok, false);
  assert.equal(report.registry, "missing");
  assert.ok(report.issues.some((issue) => issue.code === "selected-session-missing"));
  const cli = await runBrowserSessionsCli(["doctor"], { PROMETHEUS_CONFIG_DIR: dir });
  assert.equal(cli.status, 1);
  assert.deepEqual(JSON.parse(cli.stdout), report);
  assert.deepEqual(snapshot(dir), before);
  assertPrivate(cli);
  const processResult = spawnSync(process.execPath, [fileURLToPath(new URL("../../scripts/browser-sessions.mjs", import.meta.url)), "doctor", "--config-dir", dir], {
    encoding: "utf8", timeout: 10000,
  });
  assert.equal(processResult.status, 1);
  assert.deepEqual(JSON.parse(processResult.stdout), report);
  assert.equal(processResult.stderr, "");
  assertPrivate(processResult.stdout);
  assert.deepEqual(snapshot(dir), before);
  await assert.rejects(() => runBrowserSessionsCli(["doctor", "work"], { PROMETHEUS_CONFIG_DIR: dir }), /takes only/);
});

test("session doctor checks credentials, assignments, owners and locks without mutating any files", async (t) => {
  const { dir, cfg } = fixture(t);
  await createSession(dir, cfg);
  const task = await acquireTaskSession(dir, cfg);
  t.after(() => task.release());
  const handoff = await issueLoginHandoff(dir, cfg);
  const helper = await joinLoginHelper(dir, cfg, { session: "work", handoffId: handoff.handoffId });
  t.after(() => helper.release());
  const before = snapshot(dir);
  const report = diagnoseSessions(dir, cfg);
  assert.equal(report.ok, true);
  assert.equal(report.scope, "local-only");
  assert.equal(report.nextProxyId, "b");
  assert.deepEqual(report.proxies, [{ proxyId: "a", credentials: "valid" }, { proxyId: "b", credentials: "not-required" }]);
  assert.deepEqual(report.sessions[0].owners, { task: "alive", helpers: { alive: 1, dead: 0, ambiguous: 0 } });
  assert.equal(report.sessions[0].inactive, false);
  assert.deepEqual(snapshot(dir), before);
  assertPrivate(report);

  task.release();
  assert.equal(diagnoseSessions(dir, cfg).sessions[0].inactive, false, "helper alone prevents inactivity");
  helper.release();
  assert.equal(diagnoseSessions(dir, cfg).sessions[0].inactive, true);
  await withRegistryLock(dir, () => {
    const lockedBefore = snapshot(dir);
    const locked = diagnoseSessions(dir, cfg);
    assert.equal(locked.locks.registry, "alive");
    assert.ok(locked.issues.some((issue) => issue.code === "lock-alive"));
    assert.deepEqual(snapshot(dir), lockedBefore);
  });
  const cli = await runBrowserSessionsCli(["doctor", "--config-dir", dir], {});
  assert.equal(cli.status, 0);
});

test("session doctor reports removed proxies, endpoint drift, invalid secrets and corruption without leaking details", async (t) => {
  const { dir, cfg, registryPath } = fixture(t);
  await createSession(dir, cfg);
  const drifted = structuredClone(cfg);
  drifted.proxy.pool = [{ ...cfg.proxy.pool[0], server: "http://changed-private-proxy.invalid:18003" }];
  fs.chmodSync(path.join(dir, cfg.proxy.pool[0].credentialsFile), 0o644);
  const before = snapshot(dir);
  const report = diagnoseSessions(dir, drifted);
  assert.equal(report.ok, false);
  assert.deepEqual(report.issues.map((issue) => issue.code).sort(), ["credentials-invalid", "cursor-proxy-missing", "endpoint-changed"]);
  assertPrivate(report);
  assert.deepEqual(snapshot(dir), before);

  const removed = structuredClone(cfg);
  removed.proxy.pool = [cfg.proxy.pool[1]];
  assert.equal(diagnoseSessions(dir, removed).sessions[0].assignment, "proxy-missing");
  fs.writeFileSync(registryPath, "{DistinctiveProxyPassword! corrupt registry");
  const corruptBefore = snapshot(dir);
  const cli = await runBrowserSessionsCli(["doctor"], { PROMETHEUS_CONFIG_DIR: dir });
  assert.equal(cli.status, 1);
  assert.equal(JSON.parse(cli.stdout).registry, "invalid");
  assertPrivate(cli);
  assert.deepEqual(snapshot(dir), corruptBefore);
});

test("session doctor never prunes dead or ambiguous ownership and lock records", async (t) => {
  const { dir, cfg } = fixture(t);
  await createSession(dir, cfg);
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { acquireTaskSession, withRegistryLock } from ${JSON.stringify(new URL("../../scripts/opencode-browser-sessions.mjs", import.meta.url).href)};
    await acquireTaskSession(${JSON.stringify(dir)}, ${JSON.stringify(cfg)});
    await withRegistryLock(${JSON.stringify(dir)}, () => process.exit(0));
  `], { timeout: 10000 });
  const before = snapshot(dir);
  const dead = diagnoseSessions(dir, cfg);
  assert.equal(dead.sessions[0].owners.task, "dead");
  assert.equal(dead.locks.registry, "dead");
  assert.ok(dead.issues.some((issue) => issue.code === "ownership-dead"));
  assert.ok(dead.issues.some((issue) => issue.code === "lock-dead"));
  assert.deepEqual(snapshot(dir), before);

  const ownerPath = path.join(dir, PROXY_SESSIONS_DIR, "owners", "work", "task.json");
  const lockPath = path.join(dir, PROXY_SESSIONS_DIR, "registry.lock");
  fs.writeFileSync(ownerPath, "{DistinctiveProxyPassword! corrupt owner");
  fs.writeFileSync(lockPath, "{DistinctiveProxyPassword! corrupt lock", { mode: 0o600 });
  const ambiguousBefore = snapshot(dir);
  const ambiguous = diagnoseSessions(dir, cfg);
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.sessions[0].owners.task, "ambiguous");
  assert.equal(ambiguous.sessions[0].inactive, false);
  assert.equal(ambiguous.locks.registry, "ambiguous");
  assertPrivate(ambiguous);
  assert.deepEqual(snapshot(dir), ambiguousBefore);
});

test("session doctor rejects unsafe credential files and owner directories without following links or repairing them", async (t) => {
  const { dir, cfg } = fixture(t);
  await createSession(dir, cfg);
  const secret = path.join(dir, cfg.proxy.pool[0].credentialsFile);
  for (const kind of ["malformed", "missing", "symlink", "hardlink", "open-parent"]) {
    const target = path.join(dir, `target-${kind}.json`);
    const altered = structuredClone(cfg);
    altered.proxy.pool[0].credentialsFile = `secrets/${kind}.json`;
    const file = path.join(dir, altered.proxy.pool[0].credentialsFile);
    if (kind === "malformed") fs.writeFileSync(file, "DistinctiveProxyPassword!", { mode: 0o600 });
    if (kind === "symlink") fs.symlinkSync(secret, file);
    if (kind === "hardlink") {
      fs.copyFileSync(secret, target);
      fs.linkSync(target, file);
    }
    if (kind === "open-parent") {
      fs.copyFileSync(secret, file);
      fs.chmodSync(path.dirname(file), 0o755);
    }
    const before = snapshot(dir);
    const report = diagnoseSessions(dir, altered);
    assert.equal(report.proxies[0].credentials, "invalid", kind);
    assertPrivate(report);
    assert.deepEqual(snapshot(dir), before);
    fs.chmodSync(path.dirname(secret), 0o700);
  }
  const owners = path.join(dir, PROXY_SESSIONS_DIR, "owners");
  fs.rmdirSync(owners);
  fs.symlinkSync(path.join(dir, "secrets"), owners);
  const before = snapshot(dir);
  assert.equal(diagnoseSessions(dir, cfg).sessions[0].owners.task, "ambiguous");
  assert.deepEqual(snapshot(dir), before);
});

test("rotation uses the global cursor even when it selects the same proxy; singleton rotation still starts a generation", async (t) => {
  const { dir, cfg } = fixture(t);
  seedAuth(dir);
  await createSession(dir, cfg);
  await createSession(dir, cfg, { session: "other" });
  await bindAuthRecord(dir, "work", "account");
  assert.equal(listSessions(dir).nextProxyId, "a");
  const rotated = await rotateSession(dir, cfg);
  assert.equal(rotated.proxyId, "a");
  assert.equal(rotated.generation, 2);
  assert.deepEqual(rotated.authRecords, []);
  assert.equal(listSessions(dir).nextProxyId, "b");

  const single = fixture(t);
  single.cfg.proxy.pool = [single.cfg.proxy.pool[0]];
  seedAuth(single.dir);
  await createSession(single.dir, single.cfg);
  await bindAuthRecord(single.dir, "work", "account");
  const retained = await rotateSession(single.dir, single.cfg, { retainAssociations: true });
  assert.equal(retained.proxyId, "a");
  assert.equal(retained.generation, 2);
  assert.deepEqual(retained.authRecords, ["account"]);
  assert.ok(retained.warnings.length > 0);
  const cleared = await rotateSession(single.dir, single.cfg);
  assert.equal(cleared.generation, 3);
  assert.deepEqual(cleared.authRecords, []);
  assert.equal(listSessions(single.dir).nextProxyId, "a");
});

test("explicit reconciliation preserves the cursor and clears auth on endpoint changes unless retained", async (t) => {
  const { dir, cfg } = fixture(t);
  seedAuth(dir);
  await createSession(dir, cfg);
  await bindAuthRecord(dir, "work", "account");
  const registryBefore = fs.readFileSync(path.join(dir, PROXY_SESSIONS_DIR, "registry.json"));
  const unchanged = await reconcileSession(dir, cfg, { retainAssociations: true });
  assert.equal(unchanged.generation, 1);
  assert.deepEqual(unchanged.authRecords, ["account"]);
  assert.equal(unchanged.warnings, undefined);
  assert.deepEqual(fs.readFileSync(path.join(dir, PROXY_SESSIONS_DIR, "registry.json")), registryBefore);
  const authBefore = fs.readFileSync(path.join(dir, "prometheus-sessions", "account.json"));
  const drifted = structuredClone(cfg);
  drifted.proxy.pool[0].server = "http://changed-private-proxy.invalid:18003";
  const task = await acquireTaskSession(dir, cfg);
  try {
    await assert.rejects(() => reconcileSession(dir, drifted), /active browser task owner/);
    assert.deepEqual(fs.readFileSync(path.join(dir, PROXY_SESSIONS_DIR, "registry.json")), registryBefore);
  } finally {
    task.release();
  }
  const changed = await reconcileSession(dir, drifted);
  assert.equal(changed.generation, 2);
  assert.deepEqual(changed.authRecords, []);
  assert.equal(listSessions(dir).nextProxyId, "b");
  await bindAuthRecord(dir, "work", "account");
  const retained = await reconcileSession(dir, cfg, { retainAssociations: true });
  assert.equal(retained.generation, 3);
  assert.deepEqual(retained.authRecords, ["account"]);
  assert.ok(retained.warnings.length > 0);
  const selected = await reconcileSession(dir, cfg, { proxyId: "b" });
  assert.equal(selected.proxyId, "b");
  assert.equal(selected.generation, 4);
  assert.deepEqual(selected.authRecords, []);
  assert.equal(listSessions(dir).nextProxyId, "b");
  assert.deepEqual(fs.readFileSync(path.join(dir, "prometheus-sessions", "account.json")), authBefore);
});

test("failed launch releases ownership but preserves the allocation and cursor without leaking proxy details", async (t) => {
  const { dir, cfg, registryPath } = fixture(t);
  await createSession(dir, cfg);
  const before = fs.readFileSync(registryPath);
  const failingBrowser = { launch() { throw new Error("DistinctiveProxyUser DistinctiveProxyPassword! http://private-proxy.invalid:18001"); } };
  await assert.rejects(() => createTaskContext(failingBrowser, cfg, undefined, { configDir: dir }), (error) => {
    assertPrivate(error.message);
    return true;
  });
  assert.deepEqual(fs.readFileSync(registryPath), before);
  assert.equal(diagnoseSessions(dir, cfg).sessions[0].inactive, true);
  const lease = await acquireTaskSession(dir, cfg);
  lease.release();
});
