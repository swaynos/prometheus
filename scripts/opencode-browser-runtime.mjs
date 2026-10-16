// Shared browser settings, task contexts, and private state hydration.
import fs from "node:fs";
import path from "node:path";

export function validateBrowserConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config) ||
       Object.keys(config).some((key) => !["channel", "automationCompatibility", "executionMode"].includes(key)) ||
      !["default", "chromium", "chrome"].includes(config.channel)) {
    throw new Error("browser must specify channel: default, chromium, or chrome");
  }
  if (config.automationCompatibility !== undefined && typeof config.automationCompatibility !== "boolean") {
    throw new Error("automationCompatibility must be boolean");
  }
  if (config.executionMode !== undefined && !["headless", "virtual-display"].includes(config.executionMode)) {
    throw new Error("executionMode must be headless or virtual-display");
  }
  return { channel: config.channel, ...(config.automationCompatibility === true ? { automationCompatibility: true } : {}),
    ...(config.executionMode === "virtual-display" ? { executionMode: "virtual-display" } : {}) };
}

export function browserConfigFromEnv(env = process.env) {
  if (env.PROMETHEUS_CONFIG_DIR) {
    const file = path.join(env.PROMETHEUS_CONFIG_DIR, "prometheus-browser.json");
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular file");
      return validateBrowserConfig(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error("invalid browser settings file");
    }
  }
  const compatibility = env.PROMETHEUS_BROWSER_AUTOMATION_COMPATIBILITY;
  if (compatibility !== undefined && !["true", "false"].includes(compatibility)) throw new Error("invalid browser automation compatibility setting");
  return validateBrowserConfig({ channel: env.PROMETHEUS_BROWSER_CHANNEL || "default", automationCompatibility: compatibility === "true",
    executionMode: env.PROMETHEUS_BROWSER_EXECUTION_MODE });
}

export function browserLaunchOptions(config, headless) {
  const { channel, automationCompatibility, executionMode } = validateBrowserConfig(config);
  return { headless: headless ?? executionMode !== "virtual-display", ...(channel === "default" ? {} : { channel }),
    ...(automationCompatibility ? {
      ignoreDefaultArgs: ["--enable-automation"],
      args: ["--disable-blink-features=AutomationControlled"],
    } : {}),
  };
}

export async function createTaskContext(chromium, config) {
  if (config.executionMode === "virtual-display" && (!process.env.DISPLAY || process.env.PROMETHEUS_VIRTUAL_DISPLAY !== "1")) {
    throw new Error("virtual-display mode requires the managed Xvfb service launcher");
  }
  const browser = await chromium.launch(browserLaunchOptions(config));
  try { return { browser, context: await browser.newContext({ viewport: { width: 1280, height: 1024 } }) }; }
  catch (error) { await browser.close().catch(() => {}); throw error; }
}

// Input must come from the origin-scoped state store, never model-provided state.
export async function hydrateBrowserState(context, loaded) {
  const cookies = loaded.storageState?.cookies || [];
  const localStores = loaded.storageState?.origins || [];
  const sessionStores = loaded.sessionStorage || {};
  if (cookies.length) await context.addCookies(cookies);
  if (localStores.length || Object.keys(sessionStores).length) {
    await context.addInitScript(({ localStores, sessionStores }) => {
      const here = location.origin;
      const marker = `__prometheus_hydrated__:${here}`;
      if (window.name.includes(marker)) return;
      for (const entry of localStores) {
        if (entry.origin === here) for (const item of entry.localStorage || []) localStorage.setItem(item.name, item.value);
      }
      for (const [key, value] of Object.entries(sessionStores[here] || {})) sessionStorage.setItem(key, value);
      window.name += marker;
    }, { localStores, sessionStores });
  }
  return Boolean(cookies.length || localStores.length || Object.keys(sessionStores).length);
}
