import { devices } from "playwright";
import { createHash, randomInt } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const playwrightVersion = require("playwright/package.json").version;
// Review registry changes alongside the exact dependency pin, never fetch at runtime.
if (playwrightVersion !== "1.63.0") throw new Error("browser profiles require reviewed Playwright 1.63.0 descriptors");
export const PROFILE_CATALOG_VERSION = "1";
const source = {
  url: "https://github.com/microsoft/playwright/blob/v1.63.0/packages/isomorphic/deviceDescriptorsSource.json",
  revision: "v1.63.0",
  license: "Apache-2.0",
};

const legacyProfiles = [
  {
    id: "win-chrome-124-intel",
    os: "Windows",
    platform: "Win32",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    brands: [
      { brand: "Chromium", version: "124" },
      { brand: "Google Chrome", version: "124" },
      { brand: "Not-A.Brand", version: "99" },
    ],
    glVendor: "Intel Inc.",
    glRenderer: "Intel(R) Iris(R) Xe Graphics",
  },
  {
    id: "win-chrome-124-nvidia",
    os: "Windows",
    platform: "Win32",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    brands: [
      { brand: "Chromium", version: "124" },
      { brand: "Google Chrome", version: "124" },
      { brand: "Not-A.Brand", version: "99" },
    ],
    glVendor: "Google Inc. (NVIDIA)",
    glRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    id: "mac-chrome-124-m2",
    os: "macOS",
    platform: "MacIntel",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    brands: [
      { brand: "Chromium", version: "124" },
      { brand: "Google Chrome", version: "124" },
      { brand: "Not-A.Brand", version: "99" },
    ],
    glVendor: "Google Inc. (Apple)",
    glRenderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Version 14.4.1 (Build 23E224))",
  },
  {
    id: "linux-chrome-124-mesa",
    os: "Linux",
    platform: "Linux x86_64",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    brands: [
      { brand: "Chromium", version: "124" },
      { brand: "Google Chrome", version: "124" },
      { brand: "Not-A.Brand", version: "99" },
    ],
    glVendor: "Google Inc. (Mesa)",
    glRenderer: "ANGLE (Mesa, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)",
  },
];

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const slug = name => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
function osFor(ua) {
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows";
  if (/Macintosh/.test(ua)) return "macOS";
  if (/Linux|X11/.test(ua)) return "Linux";
  return "Other";
}
function preset(name, descriptor) {
  const { defaultBrowserType: engine, ...contextOptions } = structuredClone(descriptor);
  const os = osFor(descriptor.userAgent);
  return {
    id: `pw-${slug(name)}`, name, engine,
    channel: /Desktop Edge/.test(name) ? "msedge" : "default",
    os, deviceClass: !descriptor.isMobile ? "desktop"
      : /iPad|Tab |Nexus (7|10)|PlayBook|Kindle/.test(name) ? "tablet" : "phone",
    orientation: name.endsWith(" landscape") ? "landscape" : descriptor.isMobile ? "portrait" : "landscape",
    legacy: /Black[Bb]erry|Note (3|II)|S III|Galaxy S[589](?: |$)|Tab S4|Kindle|LG |Lumia|Nexus|Nokia|Moto G4|iPhone (6|7|8|X(?: |$))|iPhone SE$/.test(name),
    userAgent: descriptor.userAgent,
    browserVersion: /(?:Chrome|Firefox|Version)\/([\d.]+)/.exec(descriptor.userAgent)?.[1] ?? null,
    architecture: null, clientHints: null, gpu: null,
    validation: "upstream-emulation-preset", source: { ...source, descriptor: name }, contextOptions,
  };
}

const presets = Object.entries(devices).map(([name, descriptor]) => preset(name, descriptor));
// Explicit OS/display matrix, not a fabricated OS x GPU fingerprint product.
const desktop = [];
for (const os of ["Windows", "macOS", "Linux"]) {
  for (const [browser, name] of [["chrome", "Desktop Chrome"], ["edge", "Desktop Edge"], ["firefox", "Desktop Firefox"], ["safari", "Desktop Safari"]]) {
    if (browser === "safari" && os !== "macOS") continue;
    for (const [display, width, height, scale] of [["hd", 1366, 768, 1], ["fhd", 1920, 1080, 1], ["hidpi", 1440, 900, 2]]) {
      const p = preset(name, devices[name]);
      const token = os === "Windows" ? "Windows NT 10.0; Win64; x64" : os === "macOS" ? "Macintosh; Intel Mac OS X 10_15_7" : "X11; Linux x86_64";
      const rv = /; rv:[\d.]+/.exec(p.userAgent)?.[0] ?? "";
      p.userAgent = p.userAgent.replace(/\([^)]*\)/, `(${token}${rv})`);
      p.id = `desktop-${slug(os)}-${browser}-${display}`;
      p.name = `${os} ${browser} ${display}`;
      p.os = os;
      p.contextOptions = { ...p.contextOptions, userAgent: p.userAgent, viewport: { width, height }, screen: { width, height }, deviceScaleFactor: scale };
      p.validation = "synthetic-emulation-preset";
      p.source = { ...p.source, derivation: "OS token and CSS display dimensions; not an observed device" };
      desktop.push(p);
    }
  }
}

export const BROWSER_PROFILES = freeze([
  ...presets, ...desktop,
  ...legacyProfiles.map(p => ({ ...p, name: p.id, engine: "chromium", channel: "default", deviceClass: "desktop",
    orientation: "landscape", legacy: true, browserVersion: "124.0.0.0", architecture: null, clientHints: null,
    gpu: { vendor: p.glVendor, renderer: p.glRenderer, validation: "unverified-legacy-observation" },
    validation: "unverified-legacy-preset", source: { revision: "original-catalog", url: null },
    contextOptions: { userAgent: p.userAgent, viewport: { width: 1280, height: 1024 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
  })),
]);
const byID = new Map(BROWSER_PROFILES.map(p => [p.id, p]));
if (byID.size !== BROWSER_PROFILES.length) throw new Error("duplicate browser profile ID");
export const PROFILE_CATALOG_SHA256 = createHash("sha256").update(JSON.stringify(BROWSER_PROFILES)).digest("hex");

export function listBrowserProfiles(filters = {}) {
  const allowed = ["engine", "os", "deviceClass", "orientation", "legacy"];
  if (!filters || typeof filters !== "object" || Array.isArray(filters) ||
      Object.keys(filters).some(key => !allowed.includes(key)) ||
      Object.entries(filters).some(([key, value]) => key === "legacy" ? typeof value !== "boolean"
        : typeof value !== "string" || !BROWSER_PROFILES.some(p => p[key] === value))) throw new Error("invalid browser profile filters");
  return BROWSER_PROFILES.filter(p => Object.entries(filters).every(([key, value]) => p[key] === value));
}

// Default sampling excludes legacy presets. A seed is stable for a given catalog hash.
export function getBrowserProfile(id, { seed, ...filters } = {}) {
  if (id !== undefined && id !== null && id !== "") {
    const match = byID.get(id);
    if (!match) throw new Error(`unknown browser profile: ${id}`);
    return match;
  }
  if (seed !== undefined && (typeof seed !== "string" || !seed.length || seed.length > 1024)) throw new Error("profile seed must be a non-empty string of at most 1024 characters");
  const candidates = listBrowserProfiles({ legacy: false, ...filters }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (!candidates.length) throw new Error("no browser profiles match selection");
  const index = seed === undefined ? randomInt(candidates.length)
    : createHash("sha256").update(seed).digest().readUInt32BE(0) % candidates.length;
  return candidates[index];
}

export function resolveBrowserProfile(selection) {
  if (typeof selection === "string" && selection) return getBrowserProfile(selection);
  if (!selection || typeof selection !== "object" || Array.isArray(selection) || typeof selection.seed !== "string") {
    throw new Error("profile must be an ID or a seeded filter selection");
  }
  return getBrowserProfile(undefined, selection);
}

export function currentHostOs(platform = process.platform) {
  if (platform === "win32") {
    throw new Error("Windows is not supported at this time; macOS and Linux are supported");
  }
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  throw new Error(`unsupported host platform: ${platform}; macOS and Linux are supported`);
}

export function getHostMatchedProfile({ seed, platform = process.platform, ...filters } = {}) {
  const os = currentHostOs(platform);
  return getBrowserProfile(undefined, {
    seed,
    os,
    engine: "chromium",
    deviceClass: "desktop",
    legacy: false,
    ...filters,
  });
}

export function browserProfileInfo(id) {
  const profile = getBrowserProfile(id);
  return { ...structuredClone(profile), catalogVersion: PROFILE_CATALOG_VERSION, catalogSHA256: PROFILE_CATALOG_SHA256,
    limitations: ["Emulation is not a physical device or the named browser release.",
      profile.validation === "unverified-legacy-preset"
        ? "identityProfile enables legacy JavaScript-only GPU/client-hint overrides; network hints and hardware remain native. profile applies only context settings."
        : "GPU, architecture and client hints are native runtime values, not spoofed profile claims."] };
}

// Read-only CLI. Descriptors and provenance are available without opening a browser.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action = "list", ...args] = process.argv.slice(2);
    const value = action === "show" || action === "sample" ? args.shift() : undefined;
    const filters = {};
    while (args.length) {
      const flag = args.shift();
      const key = { "--engine": "engine", "--os": "os", "--device-class": "deviceClass", "--orientation": "orientation", "--legacy": "legacy" }[flag];
      const raw = args.shift();
      if (!key || raw === undefined || key in filters || (key === "legacy" && !["true", "false"].includes(raw))) throw new Error("invalid profile filter arguments");
      filters[key] = key === "legacy" ? raw === "true" : raw;
    }
    let result;
    if (action === "list") result = { catalogVersion: PROFILE_CATALOG_VERSION, catalogSHA256: PROFILE_CATALOG_SHA256,
      profiles: listBrowserProfiles(filters).map(({ id, name, engine, os, deviceClass, legacy, validation }) => ({ id, name, engine, os, deviceClass, legacy, validation })) };
    else if (action === "show" && value && !Object.keys(filters).length) result = browserProfileInfo(value);
    else if (action === "sample" && value) result = browserProfileInfo(getBrowserProfile(undefined, { seed: value, ...filters }).id);
    else throw new Error("usage: browser-profiles.mjs list [filters] | show ID | sample SEED [filters]");
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
