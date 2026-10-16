// Run the task service inside its own Xvfb display. Human login never uses this.
import { spawn } from "node:child_process";

export async function enterTaskDisplay(config) {
  if (config.executionMode !== "virtual-display" || process.env.PROMETHEUS_VIRTUAL_DISPLAY === "1") return;
  if (process.platform !== "linux") throw new Error("virtual-display execution requires Linux and Xvfb");
  const child = spawn("xvfb-run", ["--auto-servernum", "--server-args=-screen 0 1280x1024x24 -nolisten tcp",
    process.execPath, ...process.argv.slice(1)], {
    detached: true,
    stdio: "inherit",
    env: { ...process.env, PROMETHEUS_VIRTUAL_DISPLAY: "1" },
  });
  let timer;
  const terminate = () => {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already stopped. */ }
    timer ??= setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already stopped. */ }
    }, 5000);
  };
  process.once("SIGTERM", terminate);
  process.once("SIGINT", terminate);
  const code = await new Promise((resolve, reject) => {
    child.once("error", () => reject(new Error("cannot start xvfb-run; install xvfb and xauth")));
    child.once("exit", (status, signal) => resolve(status ?? (signal === "SIGINT" ? 130 : 143)));
  }).finally(() => {
    clearTimeout(timer);
    process.removeListener("SIGTERM", terminate);
    process.removeListener("SIGINT", terminate);
  });
  process.exit(code);
}
