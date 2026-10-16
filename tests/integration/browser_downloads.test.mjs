// Download coverage uses a local authenticated fixture and real headless Chromium.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const repo = path.resolve(import.meta.dirname, "../..");
const server = path.join(repo, "scripts", "opencode-playwright-mcp.mjs");
const payload = Buffer.from("CW-FILE\nAuthenticated download\n");
const imagePayload = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function fixtureServer() {
  let retrievals = 0;
  let imageRetrievals = 0;
  let browserDownloads = 0;
  let submissions = 0;
  const pendingResponses = new Set();
  const httpServer = http.createServer((req, res) => {
    if (req.url === "/download") {
      retrievals += 1;
      if (!req.headers.cookie?.includes("fixture-auth=approved")) {
        res.writeHead(403).end("missing authentication");
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(payload);
      return;
    }
    if (req.url === "/empty") {
      res.writeHead(204).end();
      return;
    }
    if (req.url === "/preview.png") {
      imageRetrievals += 1;
      if (!req.headers.cookie?.includes("fixture-auth=approved")) {
        res.writeHead(403).end("missing authentication");
        return;
      }
      if (imageRetrievals === 1) {
        res.writeHead(200, { "content-type": "image/png", "content-length": imagePayload.length });
        res.end(imagePayload);
      } else {
        res.writeHead(410).end("single-use media was already consumed");
      }
      return;
    }
    if (req.url === "/actual-download" || req.url === "/large-download") {
      browserDownloads += 1;
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": "attachment; filename=fixture.bin",
      });
      res.end(req.url === "/large-download" ? Buffer.alloc(payload.length + 1) : payload);
      return;
    }
    if (req.url === "/submit" && req.method === "POST") {
      submissions += 1;
      // Keep the request unresolved so a transport loss happens after the
      // non-idempotent action reaches the fixture but before a result returns.
      pendingResponses.add(res);
      res.on("close", () => pendingResponses.delete(res));
      return;
    }
    res.setHeader("set-cookie", "fixture-auth=approved; Path=/");
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>Download fixture</title>
      <a id="download-link" href="/actual-download">download</a>
      <a id="large-download-link" href="/large-download">large download</a>
      <img id="preview" src="/preview.png" alt="Generated preview">
      <canvas id="canvas" width="2" height="1"></canvas>
      <canvas id="large-canvas" width="11" height="10"></canvas>
      <script>document.getElementById("canvas").getContext("2d").fillRect(0, 0, 2, 1)</script>`);
  });
  return new Promise((resolve) => httpServer.listen(0, "127.0.0.1", () => {
    resolve({
      httpServer,
      base: `http://127.0.0.1:${httpServer.address().port}`,
      retrievals: () => retrievals,
      imageRetrievals: () => imageRetrievals,
      browserDownloads: () => browserDownloads,
      submissions: () => submissions,
      close: () => {
        for (const response of pendingResponses) response.destroy();
        httpServer.closeAllConnections();
        httpServer.close();
      },
    });
  }));
}

function client(env = {}) {
  const child = spawn("node", [server], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...env } });
  const pending = new Map();
  let nextId = 1;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    const request = pending.get(message.id);
    if (request) { pending.delete(message.id); request.resolve(message); }
  });
  child.once("exit", () => {
    for (const request of pending.values()) request.reject(new Error("MCP transport closed"));
    pending.clear();
  });
  function rpc(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`rpc timeout: ${method}`)), 60000);
      pending.set(id, {
        resolve: (message) => { clearTimeout(timer); resolve(message); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  return {
    call: async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result,
    close: () => child.stdin.end(),
    disconnect: () => child.kill("SIGKILL"),
    textOf: (result) => result?.content?.map((entry) => entry.text).join("") ?? "",
  };
}

test("Playwright download events create validated collision-safe local files", async () => {
  const { base, browserDownloads, close } = await fixtureServer();
  const destinationDir = await mkdtemp(path.join(os.tmpdir(), "cw-download-"));
  const destination = path.join(destinationDir, "result.bin");
  const c = client({ PROMETHEUS_BROWSER_MAX_DOWNLOAD_BYTES: String(payload.length) });
  try {
    await c.call("browser_navigate", { url: `${base}/` });
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const result = await c.call("browser_download", {
      selector: "#download-link", path: destination, min_bytes: payload.length,
      expected_content_type: "application/octet-stream", signature_hex: "43572d46494c45", expected_sha256: sha256,
    });
    assert.equal(result.isError, undefined, c.textOf(result));
    assert.deepEqual(await readFile(destination), payload, "validated local bytes were saved");
    assert.equal(browserDownloads(), 1, "the file came from one Playwright download event");

    const collision = await c.call("browser_download", { selector: "#download-link", path: destination });
    assert.equal(collision.isError, true);
    assert.match(c.textOf(collision), /destination already exists/);
    assert.equal(browserDownloads(), 1, "a collision never replaces or starts a second download");

    const invalid = path.join(destinationDir, "invalid.bin");
    const badSignature = await c.call("browser_download", { selector: "#download-link", path: invalid, signature_hex: "0000" });
    assert.equal(badSignature.isError, true);
    await assert.rejects(readFile(invalid), { code: "ENOENT" });

    const oversized = path.join(destinationDir, "oversized.bin");
    const tooLarge = await c.call("browser_download", { selector: "#large-download-link", path: oversized });
    assert.equal(tooLarge.isError, true);
    assert.match(c.textOf(tooLarge), /maximum size/);
    await assert.rejects(readFile(oversized), { code: "ENOENT" });

    const empty = path.join(destinationDir, "empty.bin");
    const emptyResult = await c.call("browser_download", { url: `${base}/empty`, path: empty });
    assert.equal(emptyResult.isError, true);
    assert.match(c.textOf(emptyResult), /empty/);
    await assert.rejects(readFile(empty), { code: "ENOENT" });
  } finally {
    c.close();
    close();
    await rm(destinationDir, { recursive: true, force: true });
  }
});

test("authenticated retrieval uses the active headless context and validates bytes", async () => {
  const { base, retrievals, close } = await fixtureServer();
  const destinationDir = await mkdtemp(path.join(os.tmpdir(), "cw-retrieval-"));
  const destination = path.join(destinationDir, "result.bin");
  const c = client();
  try {
    await c.call("browser_navigate", { url: `${base}/` });
    const result = await c.call("browser_download", {
      url: `${base}/download`, path: destination, min_bytes: payload.length,
      expected_content_type: "application/octet-stream", signature_hex: "43572d46494c45",
      expected_sha256: createHash("sha256").update(payload).digest("hex"),
    });
    assert.equal(result.isError, undefined, c.textOf(result));
    assert.deepEqual(await readFile(destination), payload);
    assert.equal(retrievals(), 1, "retrieval sent the current headless context cookie once");
  } finally {
    c.close();
    close();
    await rm(destinationDir, { recursive: true, force: true });
  }
});

test("visible media is saved without exposing its authenticated source URL", async () => {
  const { base, imageRetrievals, close } = await fixtureServer();
  const destinationDir = await mkdtemp(path.join(os.tmpdir(), "cw-media-"));
  const destination = path.join(destinationDir, "preview.png");
  const c = client({ PROMETHEUS_BROWSER_MAX_MEDIA_PIXELS: "100" });
  try {
    await c.call("browser_navigate", { url: `${base}/` });
    const result = await c.call("browser_save_media", {
      selector: "#preview",
      path: destination,
      expected_content_type: "image/png",
      signature_hex: "89504e470d0a1a0a",
    });
    assert.equal(result.isError, undefined, c.textOf(result));
    assert.equal((await readFile(destination)).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(imageRetrievals(), 1, "saving uses displayed pixels without refetching a single-use source");
    assert.doesNotMatch(c.textOf(result), new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "source URL was not returned");

    const sourceMatch = c.textOf(result).match(/source sha256 ([0-9a-f]{64})/);
    assert.ok(sourceMatch, "result includes a non-secret source fingerprint");
    const stale = await c.call("browser_save_media", {
      selector: "#preview",
      path: path.join(destinationDir, "stale.png"),
      reject_source_sha256: sourceMatch[1],
    });
    assert.equal(stale.isError, true);
    assert.match(c.textOf(stale), /source matches the rejected fingerprint/);

    const canvasDestination = path.join(destinationDir, "canvas.png");
    const canvas = await c.call("browser_save_media", {
      selector: "#canvas",
      path: canvasDestination,
      expected_content_type: "image/png",
      signature_hex: "89504e470d0a1a0a",
    });
    assert.equal(canvas.isError, undefined, c.textOf(canvas));
    assert.equal((await readFile(canvasDestination)).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");

    const oversizedDestination = path.join(destinationDir, "oversized.png");
    const oversized = await c.call("browser_save_media", {
      selector: "#large-canvas",
      path: oversizedDestination,
    });
    assert.equal(oversized.isError, true);
    assert.match(c.textOf(oversized), /pixel limit/);
    await assert.rejects(readFile(oversizedDestination), { code: "ENOENT" });
  } finally {
    c.close();
    close();
    await rm(destinationDir, { recursive: true, force: true });
  }
});

test("a reconnect after an unknown non-idempotent submission never replays it", async () => {
  const { base, submissions, close } = await fixtureServer();
  const interrupted = client();
  try {
    await interrupted.call("browser_navigate", { url: `${base}/` });
    const pendingSubmission = interrupted.call("browser_evaluate", {
      expression: "(() => { fetch('/submit', { method: 'POST' }); return new Promise(() => {}); })()",
    });
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("fixture did not receive submission")), 5000);
      const poll = () => submissions() === 1 ? (clearTimeout(deadline), resolve()) : setTimeout(poll, 10);
      poll();
    });
    interrupted.disconnect();
    await assert.rejects(pendingSubmission, /MCP transport closed/);

    const reconnected = client();
    try {
      await reconnected.call("browser_navigate", { url: `${base}/` });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(submissions(), 1, "restart did not replay the unknown submission");
    } finally {
      reconnected.close();
    }
  } finally {
    close();
  }
});
