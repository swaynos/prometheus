import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const server = process.env.PROMETHEUS_TEST_BROWSER_SERVER || path.resolve(import.meta.dirname, "../../scripts/opencode-playwright-mcp.mjs");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const sha256 = createHash("sha256").update(png).digest("hex");
const hasXvfb = spawnSync("sh", ["-c", "command -v Xvfb && command -v xvfb-run && command -v xauth"], { stdio: "ignore" }).status === 0;

function client(root, env = {}) {
  const child = spawn(process.execPath, [server], { env: { ...process.env, PROMETHEUS_CONFIG_DIR: root,
    PROMETHEUS_VIRTUAL_DISPLAY: "", PROMETHEUS_BROWSER_MAX_WAIT_MS: "1500", PROMETHEUS_BROWSER_MAX_UPLOAD_BYTES: "1024", ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "exit");
  let id = 0, stderr = "";
  const pending = new Map();
  child.stderr.on("data", chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on("line", line => {
    const response = JSON.parse(line);
    pending.get(response.id)?.resolve(response.result);
  });
  child.once("exit", () => { for (const item of pending.values()) item.reject(new Error(`service exited: ${stderr}`)); });
  function rpc(method, params) {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("RPC timeout")); }, 15000);
      pending.set(requestId, {
        resolve: result => { clearTimeout(timer); pending.delete(requestId); resolve(result); },
        reject: error => { clearTimeout(timer); pending.delete(requestId); reject(error); },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
    });
  }
  return { rpc, call: (name, args = {}) => rpc("tools/call", { name, arguments: args }),
    async close() { child.stdin.end(); assert.equal((await exited)[0], 0, stderr); },
  };
}

async function fixture() {
  const uploads = [], downloads = [];
  const httpServer = http.createServer(async (req, res) => {
    if (req.url === "/upload") {
      if (!req.headers.cookie?.includes("fixture=approved")) { res.writeHead(403).end(); return; }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      uploads.push(Buffer.concat(chunks));
      res.end("Attached fixture.png"); return;
    }
    if (req.url === "/image") {
      if (!req.headers.cookie?.includes("fixture=approved")) { res.writeHead(403).end(); return; }
      downloads.push(req.url);
      res.writeHead(200, { "content-type": "image/png", "content-disposition": "attachment; filename=result.png" });
      res.end(uploads.at(-1) || png); return;
    }
    res.setHeader("set-cookie", "fixture=approved; Path=/");
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>Image transfer fixture</title>
      <input id="hidden" type="file" accept="image/*" hidden>
      <input id="direct" type="file" accept="image/*">
      <input id="reset" type="file" accept="image/*">
      <input id="blocked-input" type="file" hidden aria-disabled="true">
      <button id="attach" onclick="document.querySelector('#hidden').click()">Attach image</button>
      <button id="blocked-chooser" onclick="document.querySelector('#blocked-input').click()">Blocked chooser</button>
      <button id="disabled" aria-disabled="true" onclick="document.querySelector('#hidden').click()">Disabled</button>
      <button id="no-chooser">No chooser</button><div id="result">No attachment</div>
      <a id="download" href="/image">Download image</a>
      <a id="disabled-download" aria-disabled="true" href="/image">Disabled download</a>
      <canvas id="canvas" width="2" height="1"></canvas>
      <script>
      document.querySelector('#canvas').getContext('2d').fillRect(0,0,2,1);
      for(const input of document.querySelectorAll('input')) input.onchange = async () => {
        const file = input.files[0];
        document.querySelector('#result').textContent = 'Uploading fixture';
        if (input.id === 'reset') input.value = '';
        const response = await fetch('/upload', {method:'POST', body:file});
        document.querySelector('#result').textContent = await response.text();
      };
      </script>`);
  });
  httpServer.listen(0, "127.0.0.1"); await once(httpServer, "listening");
  return { uploads, downloads, base: `http://127.0.0.1:${httpServer.address().port}`,
    close() { httpServer.closeAllConnections(); httpServer.close(); } };
}

for (const executionMode of ["headless", "virtual-display"]) {
  test(`${executionMode}: image chooser upload and authenticated image downloads round-trip exact bytes`, { skip: executionMode === "virtual-display" && !hasXvfb, timeout: 60000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cw-image-transfer-"));
    const config = path.join(root, "config"); await mkdir(config);
    await writeFile(path.join(config, "prometheus-browser.json"), JSON.stringify({ channel: process.env.PROMETHEUS_TEST_BROWSER_CHANNEL || "default", executionMode }));
    const source = path.join(root, "fixture.png"); await writeFile(source, png);
    const site = await fixture();
    await mkdir(path.join(config, "prometheus-sessions"), { mode: 0o700 });
    await writeFile(path.join(config, "prometheus-sessions", "fixture.json"), JSON.stringify({
      schemaVersion: 1, name: "fixture", origins: [site.base], capturedAt: new Date().toISOString(),
      storageState: { cookies: [], origins: [{ origin: site.base, localStorage: [{ name: "fixture", value: "approved" }] }] },
      verification: { method: "user-confirmed" },
    }), { mode: 0o600 });
    const c = client(config);
    const text = result => result.content.map(item => item.text).join("");
    try {
      const tools = (await c.rpc("tools/list")).tools;
      assert.ok(tools.some(tool => tool.name === "browser_upload_image"));
      const nav = await c.call("browser_navigate", { url: site.base });
      assert.equal(nav.isError, undefined, text(nav));
      assert.equal(JSON.parse(text(await c.call("browser_status"))).authenticationVerification, "pending");
      assert.equal((await c.call("browser_evaluate", { expression: "document.cookie" })).isError, true);
      const uploadControls = text(await c.call("browser_interactive_elements"));
      const uploadRef = /^(e\d+) <button> Attach image$/m.exec(uploadControls)?.[1]; assert.ok(uploadRef);
      const attached = await c.call("browser_upload_image", { ref: uploadRef, path: source });
      assert.equal(attached.isError, undefined, text(attached));
      assert.deepEqual(JSON.parse(text(attached)), { status: "attached", name: "fixture.png", bytes: png.length, contentType: "image/png", sha256 });
      assert.equal((await c.call("browser_wait_for_text", { text: "Attached fixture.png" })).isError, undefined);
      assert.deepEqual(site.uploads, [png]);

      // Use an observed ref for the download control.
      const controls = text(await c.call("browser_interactive_elements"));
      const ref = /^(e\d+) <a> Download image$/m.exec(controls)?.[1]; assert.ok(ref);
      const output = path.join(root, "result.png");
      const saved = await c.call("browser_download", { ref, path: output, expected_content_type: "image/png", signature_hex: "89504e470d0a1a0a", expected_sha256: sha256 });
      assert.equal(saved.isError, undefined, text(saved));
      assert.deepEqual(await readFile(output), png);
      const count = site.downloads.length;
      assert.equal((await c.call("browser_download", { ref, path: output })).isError, true);
      assert.equal((await c.call("browser_download", { selector: "#disabled-download", path: path.join(root, "disabled.png") })).isError, true);
      assert.equal(site.downloads.length, count);
      const fetched = path.join(root, "fetched.png");
      assert.equal((await c.call("browser_download", { url: `${site.base}/image`, path: fetched, expected_content_type: "image/png", expected_sha256: sha256 })).isError, undefined);
      assert.deepEqual(await readFile(fetched), png);
      const media = path.join(root, "canvas.png");
      assert.equal((await c.call("browser_save_media", { selector: "#canvas", path: media, signature_hex: "89504e470d0a1a0a" })).isError, undefined);
      assert.equal((await readFile(media)).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");

      await c.call("browser_navigate", { url: site.base });
      assert.equal((await c.call("browser_upload_image", { selector: "#direct", path: source })).isError, undefined);
      await c.call("browser_wait_for_text", { text: "Attached fixture.png" });
      assert.equal(site.uploads.length, 2);
      const bad = path.join(root, "bad.png"); await writeFile(bad, "not an image");
      const empty = path.join(root, "empty.png"); await writeFile(empty, "");
      const large = path.join(root, "large.png"); await writeFile(large, Buffer.concat([png, Buffer.alloc(1024)]));
      const link = path.join(root, "link.png"); await symlink(source, link);
      const privateFile = path.join(config, "private.png"); await writeFile(privateFile, png);
      for (const args of [
        { selector: "#hidden", path: source }, { selector: "#disabled", path: source },
        { selector: "#blocked-chooser", path: source },
        { selector: "#attach", path: bad }, { selector: "#attach", path: empty },
        { selector: "#attach", path: large }, { selector: "#attach", path: link },
        { selector: "#attach", path: privateFile }, { selector: "#attach", path: root },
        { selector: "#attach", path: path.join(root, "missing.png") },
        { selector: "#attach", path: "fixture.png" },
        { selector: "#no-chooser", path: source },
      ]) assert.equal((await c.call("browser_upload_image", args)).isError, true, JSON.stringify(args));
      assert.equal(site.uploads.length, 2, "rejected uploads never transmit a file");
      assert.equal((await c.call("browser_upload_image", { selector: "#attach", path: source })).isError, undefined, "chooser timeout leaves the page usable");
      await c.call("browser_wait_for_text", { text: "Attached fixture.png" });
      await c.call("browser_navigate", { url: site.base });
      const reset = await c.call("browser_upload_image", { selector: "#reset", path: source });
      assert.equal(reset.isError, true);
      assert.match(text(reset), /inspect the page before retrying/);
      await c.call("browser_wait_for_text", { text: "Attached fixture.png" });
      assert.equal(site.uploads.length, 4, "a cleared input is unconfirmed, not retried automatically");
    } finally { await c.close(); site.close(); await rm(root, { recursive: true, force: true }); }
  });
}
