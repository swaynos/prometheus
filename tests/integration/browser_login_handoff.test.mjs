import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm, stat, symlink, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as login from "../../scripts/opencode-browser-login.mjs";
import { loadStateForOrigin, statMetadata } from "../../scripts/opencode-browser-state.mjs";

const run = promisify(execFile);
const helper = path.resolve("scripts/opencode-browser-login.mjs");

test("detached login survives commands and saves only on explicit user completion", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cw-handoff-"));
  const worker = path.join(dir, "worker.mjs");
  const starter = path.join(dir, "starter.mjs");
  const cli = async action => JSON.parse((await run(process.execPath, [helper, action, "--config-dir", dir, "--name", "site"])).stdout);
  try {
    // Only the external browser launch boundary changes: real Chromium and the
    // production worker still perform storage capture and IPC across processes.
    await writeFile(worker, `
      import { chromium } from ${JSON.stringify(import.meta.resolve("playwright"))};
      import { serveLogin } from ${JSON.stringify(new URL("../../scripts/opencode-browser-login.mjs", import.meta.url).href)};
      process.once('message', async opts => {
        await serveLogin(opts, { chromium: { launchPersistentContext: async (profile, options) => {
          const context = await chromium.launchPersistentContext(profile, {...options, headless: true});
          await context.route('https://**/*', route => route.fulfill({contentType: 'text/html', body:
            '<script>localStorage.setItem("session", "private-fixture"); document.cookie="sid=private-fixture; Secure";</script><p>No known account selector</p>'}));
          context.storageState = () => { throw new Error('storageState opens unwanted tabs'); };
          process.once('SIGUSR1', () => { void context.close(); });
          context.once('close', () => { void import('node:fs').then(fs => fs.writeFileSync(${JSON.stringify(path.join(dir, "closed"))}, 'closed')); });
          return context;
        }}});
      });
    `);
    const opts = login.validateStartArgs({ "config-dir": dir, name: "site", url: "https://site.example/", origin: ["https://site.example"] });
    await writeFile(starter, `
      import { fork } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      import { startLogin } from ${JSON.stringify(new URL("../../scripts/opencode-browser-login.mjs", import.meta.url).href)};
      const result = await startLogin(${JSON.stringify(opts)}, { fork: (_file, args, options) => {
        const child = fork(${JSON.stringify(worker)}, args, options);
        writeFileSync(${JSON.stringify(path.join(dir, "pid"))}, String(child.pid));
        return child;
      }});
      console.log(JSON.stringify(result));
    `);
    const start = async () => JSON.parse((await run(process.execPath, [starter])).stdout);
    const started = await start(); // The launcher has exited, not merely returned.
    assert.equal(started.status, "awaiting-user");
    assert.equal(statMetadata(dir, "site"), null, "visible UI and cookies never trigger automatic capture");
    assert.equal((await cli("pending")).status, "awaiting-user");
    assert.equal(statMetadata(dir, "site"), null);
    await assert.rejects(login.startLogin(opts), /already open/);
    const completed = await cli("complete");
    assert.equal(completed.status, "saved");
    assert.equal(completed.authentication, "unverified");
    assert.doesNotMatch(JSON.stringify(completed), /private-fixture|sid|session/);
    const state = loadStateForOrigin({ configDir: dir, name: "site", origin: "https://site.example" });
    assert.deepEqual(state.verification, { method: "user-confirmed" });
    assert.equal(state.storageState.cookies[0].value, "private-fixture");
    assert.equal(loadStateForOrigin({ configDir: dir, name: "site", origin: "https://foreign.example" }), null);
    assert.equal((await stat(path.join(dir, "prometheus-sessions/site.json"))).mode & 0o777, 0o600);
    assert.equal((await cli("pending")).status, "not-running");
    assert.equal(await readFile(path.join(dir, "closed"), "utf8"), "closed");
    await assert.rejects(cli("complete"), /no pending login/);
    await start();
    const before = statMetadata(dir, "site").capturedAt;
    assert.equal((await cli("cancel")).status, "cancelled");
    assert.equal(statMetadata(dir, "site").capturedAt, before, "cancel leaves saved state intact");
    await start();
    process.kill(Number(await readFile(path.join(dir, "pid"), "utf8")), "SIGUSR1");
    // Wait for process exit after a simulated user window close, not for login.
    for (let i = 0; i < 50 && (await cli("pending")).status !== "not-running"; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await cli("pending")).status, "not-running");
    assert.equal(statMetadata(dir, "site").capturedAt, before);
    await assert.rejects(cli("complete"), /no pending login/);
  } finally {
    await cli("cancel").catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("login handoff rejects symlinked control paths", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cw-handoff-path-"));
  try {
    const outside = path.join(dir, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(dir, "prometheus-logins"));
    await assert.rejects(login.loginCommand(dir, "site", "pending"), /unsafe login directory/);
    await rm(path.join(dir, "prometheus-logins"));
    await mkdir(path.join(dir, "prometheus-logins"));
    await symlink(path.join(dir, "missing"), path.join(dir, "prometheus-logins/site.sock"));
    await assert.rejects(login.loginCommand(dir, "site", "pending"), /unsafe login socket/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
