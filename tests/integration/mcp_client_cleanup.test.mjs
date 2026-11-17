import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnMcpClient } from "./helpers.mjs";

async function fixture(t, onEnd, { onTerm = "", closeTimeoutMs = 1000 } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcp-cleanup-"));
  const server = path.join(directory, "server.mjs");
  try {
    await writeFile(server, `
import { createInterface } from "node:readline";
process.on("SIGTERM", () => { ${onTerm} });
const reader = createInterface({ input: process.stdin });
reader.on("line", line => {
  const request = JSON.parse(line);
  console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "ready" }));
});
reader.on("close", () => { ${onEnd} });
`);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const client = spawnMcpClient({}, { server, closeTimeoutMs });
  t.after(async () => {
    try {
      if (client.child.exitCode === null && client.child.signalCode === null) await client.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  return client;
}

test("MCP close waits for the service to exit and is idempotent", async t => {
  const client = await fixture(t, "setTimeout(() => process.exit(0), 50);");
  assert.equal((await client.rpc("ready", {})).result, "ready");
  const first = client.close();
  assert.equal(client.close(), first);
  assert.deepEqual(await first, [0, null]);
  assert.notEqual(client.child.exitCode, null);
});

test("MCP close reports a service that needs SIGTERM", async t => {
  const client = await fixture(t, "setInterval(() => {}, 1000);", {
    onTerm: "process.exit(0);", closeTimeoutMs: 100,
  });
  assert.equal((await client.rpc("ready", {})).result, "ready");
  await assert.rejects(client.close(), /did not exit within 100ms and was terminated/);
  assert.equal(client.child.exitCode, 0);
  assert.equal(client.child.signalCode, null);
});

test("MCP close reports a stuck service and terminates it", async t => {
  const client = await fixture(t, "setInterval(() => {}, 1000);", { closeTimeoutMs: 100 });
  assert.equal((await client.rpc("ready", {})).result, "ready");
  await assert.rejects(client.close(), /did not exit within 100ms and was terminated/);
  assert.equal(client.child.signalCode, "SIGKILL");
});
