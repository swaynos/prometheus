import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import path from "node:path";

export const repoRoot = path.resolve(import.meta.dirname, "../..");
export const defaultMcpServer = process.env.PROMETHEUS_TEST_BROWSER_SERVER || path.join(repoRoot, "scripts", "opencode-playwright-mcp.mjs");
export const hasXvfb = spawnSync("sh", ["-c", "command -v Xvfb && command -v xvfb-run && command -v xauth"], { stdio: "ignore" }).status === 0;

export function spawnMcpClient(env = {}, { server = defaultMcpServer, timeoutMs = 60000, captureStderr = false } = {}) {
  const child = spawn(process.execPath, [server], {
    stdio: ["pipe", "pipe", captureStderr ? "pipe" : "inherit"],
    env: { ...process.env, PROMETHEUS_CONFIG_DIR: "", ...env },
  });
  const exited = once(child, "exit");
  const pending = new Map();
  let nextId = 1;
  let stderr = "";
  if (captureStderr) child.stderr.on("data", (chunk) => { stderr += chunk; });
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const req = pending.get(message.id);
    if (req) { pending.delete(message.id); req.resolve(message); }
  });
  child.once("exit", () => {
    for (const req of pending.values()) req.reject(new Error(captureStderr ? `service exited: ${stderr}` : "MCP transport closed"));
    pending.clear();
  });
  function rpc(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`rpc timeout: ${method} ${stderr}`)); }, timeoutMs);
      pending.set(id, {
        resolve: (message) => { clearTimeout(timer); resolve(message); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  const textOf = (result) => result?.content?.map((c) => c.text).join("") ?? "";
  return {
    child,
    exited,
    errors: () => stderr,
    rpc,
    call: async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result,
    textOf,
    close: () => { child.stdin.end(); return exited; },
    disconnect: () => child.kill("SIGKILL"),
  };
}
