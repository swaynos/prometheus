import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { browserConfigFromEnv } from "./opencode-browser-runtime.mjs";
import {
  bindAuthRecord,
  BrowserSessionError,
  createSession,
  diagnoseSessions,
  listSessions,
  reconcileCursor,
  reconcileSession,
  rotateSession,
  sanitizePoolProxyError,
  showSession,
  unbindAuthRecord,
} from "./opencode-browser-sessions.mjs";

function usage() {
  return [
    "Usage: browser-sessions <command> [args] [options]",
    "",
    "Commands:",
    "  create [session] [--session <name>]",
    "  list",
    "  doctor (read-only local checks; no network requests)",
    "  show [session] [--session <name>]",
    "  bind-auth [session] <auth-record> [--session <name>] [--name <auth-record>]",
    "  unbind-auth [session] <auth-record> [--session <name>] [--name <auth-record>]",
    "  rotate [session] [--session <name>] [--retain-associations]",
    "  reconcile-cursor <proxy-id> [--proxy-id <id>]",
    "  reconcile-session [session] [proxy-id] [--session <name>] [--proxy-id <id>] [--retain-associations]",
    "",
    "All commands accept --config-dir <dir> (or PROMETHEUS_CONFIG_DIR).",
    "Configure proxy.session and strategy: round-robin in prometheus-browser.json.",
    "Omit proxy.pool to load <config-dir>/proxies.txt: HOST:PORT:USER:PASS per line.",
    "The list must be a private 0600 file outside Git repositories.",
  ].join("\n");
}

function parseCliArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help") {
    return { help: true };
  }
  const opts = { positional: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--retain-associations") {
      opts.retainAssociations = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      return { help: true };
    }
    if (!arg.startsWith("--")) {
      opts.positional.push(arg);
      continue;
    }
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      throw new BrowserSessionError(`missing value for option ${arg}`);
    }
    if (arg === "--session") {
      opts.session = next;
    } else if (arg === "--name" || arg === "--auth") {
      opts.name = next;
    } else if (arg === "--proxy-id" || arg === "--next" || arg === "--next-proxy-id") {
      opts.proxyId = next;
    } else if (arg === "--config-dir") {
      opts.configDir = next;
    } else {
      throw new BrowserSessionError(`unknown option: ${arg}`);
    }
    i += 1;
  }
  return { command, opts };
}

function loadConfigForSessions(configDir, env) {
  const config = browserConfigFromEnv({
    ...env,
    PROMETHEUS_CONFIG_DIR: configDir,
  });
  if (!config?.proxy) {
    throw new BrowserSessionError("browser.proxy must be configured in prometheus-browser.json");
  }
  return config;
}

export async function runBrowserSessionsCli(argv, env = process.env) {
  const parsed = parseCliArgs(argv);
  if (parsed.help) {
    return { status: 0, stdout: usage() + "\n" };
  }
  const { command, opts } = parsed;
  const configDir = opts.configDir || env.PROMETHEUS_CONFIG_DIR;
  if (!configDir) {
    throw new BrowserSessionError("PROMETHEUS_CONFIG_DIR is required");
  }

  let loadedConfig = null;
  const getConfig = () => {
    if (!loadedConfig) loadedConfig = loadConfigForSessions(configDir, env);
    return loadedConfig;
  };
  const resolveSessionArg = (explicit) => {
    if (explicit) return explicit;
    const cfg = browserConfigFromEnv({ ...env, PROMETHEUS_CONFIG_DIR: configDir });
    if (cfg?.proxy?.session) return cfg.proxy.session;
    throw new BrowserSessionError("session name is required when browser.proxy.session is not configured");
  };
  const resolveAuthArgs = () => {
    if (opts.session && opts.name) return { session: opts.session, name: opts.name };
    if (opts.name) {
      return { session: resolveSessionArg(opts.positional[0]), name: opts.name };
    }
    if (opts.session) {
      if (!opts.positional[0]) throw new BrowserSessionError(`${command} requires an auth record name`);
      return { session: opts.session, name: opts.positional[0] };
    }
    if (opts.positional.length >= 2) {
      return { session: opts.positional[0], name: opts.positional[1] };
    }
    throw new BrowserSessionError(`${command} requires <session> <auth-record> or --name <auth-record>`);
  };

  try {
    let result;
    if (command === "create") {
      result = await createSession(configDir, getConfig(), { session: opts.session ?? opts.positional[0] });
    } else if (command === "list") {
      if (opts.positional.length > 0) throw new BrowserSessionError("list takes no positional arguments");
      result = listSessions(configDir);
    } else if (command === "doctor") {
      if (opts.positional.length > 0 || opts.session || opts.name || opts.proxyId || opts.retainAssociations) {
        throw new BrowserSessionError("doctor takes only --config-dir; it inspects all sessions and the configured pool");
      }
      result = diagnoseSessions(configDir, getConfig());
    } else if (command === "show") {
      result = showSession(configDir, resolveSessionArg(opts.session ?? opts.positional[0]));
    } else if (command === "bind-auth") {
      const target = resolveAuthArgs();
      result = await bindAuthRecord(configDir, target.session, target.name);
    } else if (command === "unbind-auth") {
      const target = resolveAuthArgs();
      result = await unbindAuthRecord(configDir, target.session, target.name);
    } else if (command === "rotate") {
      result = await rotateSession(configDir, getConfig(), {
        session: opts.session ?? opts.positional[0],
        retainAssociations: Boolean(opts.retainAssociations),
      });
    } else if (command === "reconcile-cursor") {
      const proxyId = opts.proxyId ?? opts.positional[0];
      if (!proxyId) throw new BrowserSessionError("reconcile-cursor requires <proxy-id> or --proxy-id <id>");
      result = await reconcileCursor(configDir, getConfig(), { nextProxyId: proxyId });
    } else if (command === "reconcile-session") {
      const session = opts.session ?? opts.positional[0];
      const proxyId = opts.proxyId ?? (opts.session ? opts.positional[0] : opts.positional[1]);
      result = await reconcileSession(configDir, getConfig(), {
        session,
        proxyId,
        retainAssociations: Boolean(opts.retainAssociations),
      });
    } else {
      throw new BrowserSessionError(`unknown command: ${command}`);
    }
    const stderr = Array.isArray(result?.warnings) && result.warnings.length
      ? result.warnings.map((w) => `warning: ${w}`).join("\n") + "\n"
      : "";
    return {
      status: command === "doctor" && !result.ok ? 1 : 0,
      stdout: JSON.stringify(result, null, 2) + "\n",
      ...(stderr ? { stderr } : {}),
    };
  } catch (error) {
    const safeMessage = sanitizePoolProxyError(error, loadedConfig);
    throw new BrowserSessionError(safeMessage || "browser session command failed");
  }
}

async function main() {
  try {
    const out = await runBrowserSessionsCli(process.argv.slice(2));
    if (out.stderr) process.stderr.write(out.stderr);
    if (out.stdout) process.stdout.write(out.stdout);
    process.exit(out.status);
  } catch (error) {
    process.stderr.write((error?.message || "browser session command failed") + "\n");
    process.exit(1);
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  }
})();

if (isMain) {
  await main();
}
