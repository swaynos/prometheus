// Browser-free tests for the headed login helper's CLI: argument validation
// (all failures happen before any browser launch), metadata-only status/remove,
// and symlinked-directory rejection. The actual headed capture is exercised by
// an opt-in live check, not by this deterministic suite.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readdir, rm, writeFile, symlink } from "node:fs/promises";
import { saveState } from "../../scripts/opencode-browser-state.mjs";
import { validateStartArgs } from "../../scripts/opencode-browser-login.mjs";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "../..");
const login = path.join(repo, "scripts", "opencode-browser-login.mjs");

async function fixture(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cuddly-login-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function invoke(args, env = {}) {
  return run("node", [login, ...args], { env: { ...process.env, ...env } });
}
function seed(root, name = "A", origins = ["https://example.com"]) {
  return saveState({
    configDir: root,
    name,
    origins,
    storageState: { cookies: [{ name: "sid", value: "secret-value", domain: "example.com", path: "/", secure: true }], origins: [] },
  });
}

test("start rejects incomplete arguments before opening a browser", async () => fixture(async (root) => {
  const base = ["start", "--config-dir", root, "--name", "A"];
  await assert.rejects(invoke(base), (e) => e.code === 1 && /start requires --url/.test(e.stderr));
  await assert.rejects(
    invoke([...base, "--url", "https://example.com/login"]),
    (e) => e.code === 1 && /requires at least one --origin/.test(e.stderr),
  );
  await assert.rejects(
    invoke([...base, "--url", "http://example.com/login", "--origin", "https://example.com", "--cookie", "sid"]),
    (e) => e.code === 1 && /--url must be https/.test(e.stderr),
  );
  await assert.rejects(
    invoke([...base, "--url", "https://example.com/login", "--origin", "https://example.com/"]),
    (e) => e.code === 1 && /bare origin \(no path\)/.test(e.stderr),
  );
  await assert.rejects(
    invoke([...base, "--url", "https://other.com/login", "--origin", "https://example.com", "--cookie", "sid"]),
    (e) => e.code === 1 && /--url host must be one of the configured --origin hosts/.test(e.stderr),
  );
  await assert.rejects(
    invoke([...base, "--url", "https://example.com/login", "--origin", "https://example.com", "--timeout", "180"]),
    (e) => e.code === 1 && /not used by user-confirmed login/.test(e.stderr),
  );
  await assert.rejects(
    invoke([...base, "--url", "https://example.com/login", "--origin", "https://example.com", "--complete-selector", "#account", "--complete-url", "https://identity.example/complete"]),
    (e) => e.code === 1 && /not used by user-confirmed login/.test(e.stderr),
  );
}));

test("start needs no site-specific completion predicates", () => {
  const options = validateStartArgs({
    _: ["start"],
    "config-dir": "/tmp/config",
    name: "account",
    url: "https://example.com/login",
    origin: ["https://example.com"],
  });
  assert.equal(options.completeSelector, undefined);
  assert.equal(options.timeout, undefined);
});

test("login may start on the public page", () => {
  const options = validateStartArgs({
    "config-dir": "/tmp/config", name: "account", url: "https://example.com/",
    origin: ["https://example.com"],
  });
  assert.equal(options.url, "https://example.com/");
});

test("login rejects a per-command channel override", () => {
  assert.throws(() => validateStartArgs({
    "config-dir": "/tmp/config", name: "account", url: "https://example.com/",
    origin: ["https://example.com"], "browser-channel": "chrome",
  }), /shared browser settings/);
});

test("a headed browser launch failure removes its temporary profile", async () => fixture(async (root) => {
  const tmp = path.join(root, "tmp");
  await mkdir(tmp);
  await assert.rejects(
    invoke(
      ["start", "--config-dir", root, "--name", "A", "--url", "https://example.com/login", "--origin", "https://example.com"],
      { TMPDIR: tmp, PLAYWRIGHT_BROWSERS_PATH: path.join(root, "missing-browsers") },
    ),
    (e) => e.code === 1 && /login window could not open|graphical session|login worker exited before opening a window/.test(e.stderr),
  );
  assert.deepEqual((await readdir(tmp)).filter((name) => name.startsWith("prometheus-login-")), []);
}));

test("a bad action and a missing name or config-dir are rejected", async () => fixture(async (root) => {
  await assert.rejects(invoke(["frobnicate", "--config-dir", root]), (e) => e.code === 1 && /unknown action/.test(e.stderr));
  await assert.rejects(invoke(["status"]), (e) => e.code === 1 && /--config-dir is required/.test(e.stderr));
  await assert.rejects(
    invoke(["start", "--config-dir", root, "--name", "has space", "--url", "https://example.com/login", "--origin", "https://example.com"]),
    (e) => e.code === 1 && /invalid session name/.test(e.stderr),
  );
}));

test("status reports no sessions, then lists a captured one without printing state values", async () => fixture(async (root) => {
  const empty = await invoke(["status", "--config-dir", root]);
  assert.match(empty.stdout, /No captured sessions/);

  seed(root, "A");
  const listed = await invoke(["status", "--config-dir", root]);
  assert.match(listed.stdout, /\[A\] origins=https:\/\/example\.com/);
  assert.doesNotMatch(listed.stdout, /secret-value/);
  assert.doesNotMatch(listed.stdout, /sid/);
}));

test("status of a specific missing name reports it as missing", async () => fixture(async (root) => {
  seed(root, "A");
  const result = await invoke(["status", "--config-dir", root, "--name", "B"]);
  assert.equal(result.stdout.trim(), "[missing] B");
}));

test("remove drops a named session and is a no-op for an unknown name", async () => fixture(async (root) => {
  seed(root, "A");
  const removed = await invoke(["remove", "--config-dir", root, "--name", "A"]);
  assert.match(removed.stdout, /Removed captured session "A"/);
  const again = await invoke(["remove", "--config-dir", root, "--name", "A"]);
  assert.match(again.stdout, /No captured session "A"/);
}));

test("status and remove reject a symlinked sessions directory", async () => fixture(async (root) => {
  const outside = path.join(root, "outside");
  const sessions = path.join(root, "prometheus-sessions");
  await mkdir(outside);
  await writeFile(path.join(outside, "A.json"), "{}\n");
  await symlink(outside, sessions);
  await assert.rejects(invoke(["status", "--config-dir", root]), (e) => e.code === 1 && /sessions directory is a symlink/.test(e.stderr));
  await assert.rejects(invoke(["remove", "--config-dir", root, "--name", "A"]), (e) => e.code === 1 && /sessions directory is a symlink/.test(e.stderr));
}));
