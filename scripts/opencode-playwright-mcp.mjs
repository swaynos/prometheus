#!/usr/bin/env node
// Managed Playwright MCP stdio server exposing browser_* tools over JSON-RPC.
// Restores approved origin login state privately; never exposes state values.

import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, writeFile, open, realpath } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { loadStateForOrigin, listStates } from "./opencode-browser-state.mjs";
import { browserConfigFromEnv, browserLaunchOptions, browserRuntimeInfo, createTaskContext, hydrateBrowserState } from "./opencode-browser-runtime.mjs";
import { enterTaskDisplay } from "./opencode-browser-service.mjs";
import { humanClick, humanType, applyNavigationDelay } from "./opencode-browser-humanize.mjs";

const TASK_CONFIG = browserConfigFromEnv();
await enterTaskDisplay(TASK_CONFIG);

const CONFIG_DIR = process.env.PROMETHEUS_CONFIG_DIR || "";
const DEFAULT_TIMEOUT = Number(process.env.PROMETHEUS_BROWSER_TIMEOUT_MS || 30000);
const configuredTransportTimeout = Number(process.env.PROMETHEUS_BROWSER_TRANSPORT_TIMEOUT_MS || 30000);
const TRANSPORT_TIMEOUT_MS = Number.isFinite(configuredTransportTimeout) && configuredTransportTimeout > 0 ? configuredTransportTimeout : 30000;
const TRANSPORT_SAFE_WAIT_MS = Math.max(1, Math.floor(TRANSPORT_TIMEOUT_MS * 0.8));
const configuredMaxWait = Number(process.env.PROMETHEUS_BROWSER_MAX_WAIT_MS || Math.min(DEFAULT_TIMEOUT, TRANSPORT_SAFE_WAIT_MS));
const requestedMaxWait = Number.isFinite(configuredMaxWait) && configuredMaxWait > 0 ? configuredMaxWait : Math.min(DEFAULT_TIMEOUT, TRANSPORT_SAFE_WAIT_MS);
const MAX_WAIT_MS = Math.min(requestedMaxWait, DEFAULT_TIMEOUT, TRANSPORT_SAFE_WAIT_MS);
const MAX_DOWNLOAD_BYTES = Number(process.env.PROMETHEUS_BROWSER_MAX_DOWNLOAD_BYTES || 50 * 1024 * 1024);
const configuredMaxUpload = Number(process.env.PROMETHEUS_BROWSER_MAX_UPLOAD_BYTES || 20 * 1024 * 1024);
const MAX_UPLOAD_BYTES = Number.isSafeInteger(configuredMaxUpload) && configuredMaxUpload > 0 ? configuredMaxUpload : 20 * 1024 * 1024;
const configuredMaxMediaPixels = Number(process.env.PROMETHEUS_BROWSER_MAX_MEDIA_PIXELS || 16 * 1024 * 1024);
const MAX_MEDIA_PIXELS = Number.isFinite(configuredMaxMediaPixels) && configuredMaxMediaPixels > 0 ? Math.floor(configuredMaxMediaPixels) : 16 * 1024 * 1024;
const STATE_NAMES = (process.env.PROMETHEUS_BROWSER_STATES || "").split(",").map((s) => s.trim()).filter(Boolean);

const SERVER_INFO = { name: "prometheus-browser", version: "1.1.0" };
const PROTOCOL_VERSION = "2024-11-05";
const SESSION_CONFIG = { humanize: Boolean(TASK_CONFIG.humanize) };
const resolveHumanize = (toolArg) => typeof toolArg === "boolean" ? toolArg : Boolean(SESSION_CONFIG.humanize);

const WAIT_UNTIL_ENUM = ["commit", "domcontentloaded", "load", "networkidle"];
const toolDef = (name, description, properties = {}, required) => ({
  name, description, inputSchema: { type: "object", properties, ...(required ? { required } : {}) },
});

const TOOLS = [
  toolDef("browser_navigate", "Navigate to a URL. Optionally select a load event and wait for a visible readiness selector without fixed sleeps.", { url: { type: "string" }, wait_until: { type: "string", enum: WAIT_UNTIL_ENUM }, ready_selector: { type: "string" }, timeout: { type: "number", description: "Total navigation/readiness budget in seconds, bounded by the transport budget." }, humanize: { type: "boolean", description: "Simulate human behavior (2-4s settle delay post-navigation)." } }, ["url"]),
  toolDef("browser_status", "Return non-secret browser runtime and page health metadata."),
  toolDef("browser_navigate_back", "Go back in history."),
  toolDef("browser_forward", "Go forward in history."),
  toolDef("browser_reload", "Reload the current page after allowing in-flight network requests to settle.", { wait_until: { type: "string", enum: WAIT_UNTIL_ENUM }, timeout: { type: "number", description: "Total reload budget in seconds, bounded by the transport budget." } }),
  toolDef("browser_snapshot", "Readable text of the current page or frame.", { max_chars: { type: "number" }, frame: { type: "string" } }),
  toolDef("browser_markdown", "Current page rendered as terse Markdown-ish text.", { max_chars: { type: "number" } }),
  toolDef("browser_interactive_elements", "List clickable/typeable elements with document-scoped refs.", { limit: { type: "number" }, frame: { type: "string" } }),
  toolDef("browser_frames", "List frames in the active page with opaque IDs."),
  toolDef("browser_links", "List anchor links as {text, href}.", { limit: { type: "number" } }),
  toolDef("browser_click", "Click once, optionally observing a fresh expected outcome.", { ref: { type: "string" }, selector: { type: "string" }, frame: { type: "string" }, humanize: { type: "boolean" }, expect: { type: "object" }, timeout: { type: "number" } }),
  toolDef("browser_fill", "Set the value of an input by ref or selector.", { ref: { type: "string" }, selector: { type: "string" }, value: { type: "string" } }, ["value"]),
  toolDef("browser_type", "Type text into an input (appends). Optional fixed delay_ms supports interfaces that need spaced keyboard events; default 0.", { ref: { type: "string" }, selector: { type: "string" }, text: { type: "string" }, delay_ms: { type: "number", minimum: 0, maximum: 1000 }, humanize: { type: "boolean", description: "Simulate human typing jitter (50-150ms per character)." } }, ["text"]),
  toolDef("browser_fill_form", "Fill multiple fields, optionally submit.", { fields: { type: "array" }, submit_ref: { type: "string" }, submit_selector: { type: "string" } }, ["fields"]),
  toolDef("browser_select_option", "Select an option in a <select>.", { selector: { type: "string" }, value: { type: "string" } }, ["selector", "value"]),
  toolDef("browser_press_key", "Dispatch a keyboard key.", { key: { type: "string" }, selector: { type: "string" } }, ["key"]),
  toolDef("browser_get_attribute", "Read an attribute of an element.", { ref: { type: "string" }, selector: { type: "string" }, attribute: { type: "string" } }, ["attribute"]),
  toolDef("browser_count", "Count elements matching a selector.", { selector: { type: "string" } }, ["selector"]),
  toolDef("browser_search", "Find substring matches in visible page text.", { query: { type: "string" }, limit: { type: "number" } }, ["query"]),
  toolDef("browser_extract", "Extract fields or bounded repeated records.", { schema: { type: "object" }, root: { type: "string" }, fields: { type: "object" }, limit: { type: "number" }, frame: { type: "string" } }),
  toolDef("browser_evaluate", "Evaluate a JavaScript expression in the page.", { expression: { type: "string" } }, ["expression"]),
  toolDef("browser_console_messages", "Return console messages logged by the page."),
  toolDef("browser_scroll", "Scroll once, optionally waiting for a change.", { direction: { type: "string" }, amount: { type: "number" }, selector: { type: "string" }, frame: { type: "string" }, expect: { type: "object" }, timeout: { type: "number" } }),
  toolDef("browser_wait_for", "Wait for a selector to appear.", { selector: { type: "string" }, timeout: { type: "number" } }, ["selector"]),
  toolDef("browser_wait_for_text", "Wait for text to appear in the page.", { text: { type: "string" }, timeout: { type: "number" } }, ["text"]),
  toolDef("browser_wait_for_change", "Wait for a bounded declarative change from the current state.", { expect: { type: "object" }, frame: { type: "string" }, timeout: { type: "number" } }, ["expect"]),
  toolDef("browser_screenshot", "Capture the viewport as a PNG saved to path.", { path: { type: "string" }, full_page: { type: "boolean" } }, ["path"]),
  toolDef("browser_upload_image", "Attach a user-requested local PNG, JPEG, WebP, or GIF through a visible file input or upload button. Returns verified attachment metadata, not server acceptance. Inspect the page before submitting or retrying.", { ref: { type: "string" }, selector: { type: "string" }, path: { type: "string" } }, ["path"]),
  toolDef("browser_download", "Capture a download through a visible ref or selector, or retrieve a URL through the authenticated task page; save only after validation.", { url: { type: "string" }, ref: { type: "string" }, selector: { type: "string" }, path: { type: "string" }, min_bytes: { type: "number" }, expected_sha256: { type: "string" }, expected_content_type: { type: "string" }, signature_hex: { type: "string" } }, ["path"]),
  toolDef("browser_save_media", "Save a visible image or canvas through the authenticated browser context without exposing its source URL.", { ref: { type: "string" }, selector: { type: "string" }, path: { type: "string" }, reject_source_sha256: { type: "string" }, min_bytes: { type: "number" }, expected_sha256: { type: "string" }, expected_content_type: { type: "string" }, signature_hex: { type: "string" } }, ["path"]),
  toolDef("browser_tab_new", "Open a new tab, optionally navigating to a URL.", { url: { type: "string" } }),
  toolDef("browser_tab_list", "List open tabs."),
  toolDef("browser_tab_switch", "Switch the active tab by index.", { index: { type: "number" } }, ["index"]),
  toolDef("browser_tab_close", "Close a tab by index (default active).", { index: { type: "number" } }),
  toolDef("browser_configure", "Adjust runtime settings for the browser session without restarting the server.", { humanize: { type: "boolean", description: "Enable or disable simulated human behavior (typing delays, curved mouse movement, navigation delays) for all subsequent actions in this session." } }),
  toolDef("browser_close", "Close the browser and reset state."),
];
const EXPECT_SCHEMA = {
  type: "object",
  description: "Observe a fresh change. A response confirms only the response, not task success.",
  properties: {
    kind: { type: "string", enum: ["visible", "hidden", "text", "count_increase", "new", "url", "popup", "response"] },
    selector: { type: "string" }, text: { type: "string" },
    url: { type: "string", description: "Exact expected URL for url events." },
    path: { type: "string", description: "Exact same-origin response path without query." },
    status: { type: "integer", minimum: 100, maximum: 599 },
  }, required: ["kind"],
};
for (const tool of TOOLS) {
  if (["browser_click", "browser_fill_form", "browser_scroll", "browser_wait_for_change"].includes(tool.name)) tool.inputSchema.properties.expect = EXPECT_SCHEMA;
  if (tool.name === "browser_fill_form") tool.inputSchema.properties.timeout = { type: "number", description: "Submission observation budget in seconds." };
  if (["browser_fill", "browser_fill_form", "browser_type", "browser_select_option", "browser_press_key", "browser_get_attribute", "browser_count", "browser_wait_for", "browser_wait_for_text", "browser_upload_image", "browser_download", "browser_save_media"].includes(tool.name)) {
    tool.inputSchema.properties.frame = { type: "string", description: "Opaque frame ID from browser_frames." };
  }
}
const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

let chromium = null;
let browser = null;
let context = null;
let resolvedRuntime = null;
let pages = [];
let activeIndex = 0;
const consoleMessages = [];
const hydratedOrigins = new Map();
const verifiedOrigins = new Set();
const frameIds = new Map();
const references = new Map();
let refCounter = 0;
let activeRequest = null;

function frameId(frame) {
  if (!frameIds.has(frame)) frameIds.set(frame, `f${frameIds.size + 1}-${randomUUID().slice(0, 8)}`);
  return frameIds.get(frame);
}

function targetFrame(page, args = {}) {
  if (!args.frame) return page.mainFrame();
  const frame = page.frames().find(candidate => frameId(candidate) === args.frame);
  if (!frame || frame.isDetached()) throw new Error("frame is stale or not in the active page");
  return frame;
}

function invalidateFrame(frame) {
  for (const [ref, entry] of references) if (entry.frame === frame) { references.delete(ref); void entry.handle.dispose().catch(() => {}); }
}

function registerPage(page) {
  if (pages.includes(page)) return;
  pages.push(page);
  page.on("framenavigated", invalidateFrame);
  page.on("framedetached", frame => { invalidateFrame(frame); frameIds.delete(frame); });
  page.on("close", () => { for (const frame of page.frames()) { invalidateFrame(frame); frameIds.delete(frame); } });
  page.on("console", (msg) => {
    if (consoleMessages.length < 500) consoleMessages.push(`[${msg.type()}] ${msg.text()}`);
  });
}

async function ensureContext() {
  if (context) return context;
  if (!chromium) ({ chromium } = await import("playwright"));
  ({ browser, context, runtime: resolvedRuntime } = await createTaskContext(chromium, TASK_CONFIG));
  context.setDefaultTimeout(DEFAULT_TIMEOUT);
  pages = [];
  context.on("page", registerPage);
  const existing = typeof context.pages === "function" ? context.pages() : [];
  if (existing.length) for (const p of existing) registerPage(p);
  else registerPage(await context.newPage());
  activeIndex = 0;
  return context;
}

function activePage() {
  const page = pages[activeIndex];
  if (!page || page.isClosed()) throw new Error("no active page is open; call browser_navigate first");
  return page;
}

async function ensureActivePage() {
  await ensureContext();
  pages = pages.filter((page) => !page.isClosed());
  if (!pages.length) registerPage(await context.newPage());
  if (activeIndex >= pages.length) activeIndex = pages.length - 1;
  return pages[activeIndex];
}

async function closeBrowser() {
  const toClose = browser;
  browser = null;
  context = null;
  pages = [];
  activeIndex = 0;
  hydratedOrigins.clear();
  verifiedOrigins.clear();
  references.clear();
  frameIds.clear();
  consoleMessages.length = 0;
  if (toClose) { try { await toClose.close(); } catch {} }
}

function candidateStateNames() {
  if (!CONFIG_DIR) return [];
  if (STATE_NAMES.length) return STATE_NAMES;
  try { return listStates(CONFIG_DIR).map((m) => m.name); } catch { return []; }
}

async function maybeHydrate(url) {
  if (!CONFIG_DIR) return;
  let origin;
  try { origin = new URL(url).origin; } catch { return; }
  if (hydratedOrigins.has(origin)) return { origin, ...hydratedOrigins.get(origin) };
  let stateWithoutVerification = false;
  for (const name of candidateStateNames()) {
    let loaded;
    try { loaded = loadStateForOrigin({ configDir: CONFIG_DIR, name, origin }); } catch { continue; }
    if (!loaded) continue;
    if (!loaded.verification?.selector && loaded.verification?.method !== "user-confirmed") {
      stateWithoutVerification = true;
      continue;
    }
    await hydrateBrowserState(context, loaded);
    hydratedOrigins.set(origin, loaded.verification);
    return { origin, ...loaded.verification };
  }
  if (stateWithoutVerification) {
    throw new Error("saved login state has no account verification selector; complete a new login capture");
  }
  return null;
}

async function verifyHydratedAccount(page, hydration) {
  if (!hydration || verifiedOrigins.has(hydration.origin) || hydration.method === "user-confirmed") return;
  let visible = false;
  try { visible = await page.locator(hydration.selector).first().isVisible(); } catch {}
  if (!visible) {
    throw new Error("saved login state has no visible account evidence in the task browser; complete a new login capture");
  }
  verifiedOrigins.add(hydration.origin);
}

const REF_TAG = "data-cw-ref";
const INTERACTIVE_SELECTOR =
  "a[href], button, input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=button], [role=link], [role=textbox], [onclick], [tabindex]";
const isElementDisabled = (el) =>
  el.matches(":disabled") ||
  el.getAttribute("aria-disabled") === "true" ||
  el.hasAttribute("data-visually-disabled") ||
  Boolean(el.closest("[inert]"));

async function tagInteractive(page, limit, args = {}) {
  const frame = targetFrame(page, args);
  for (let current = frame; current.parentFrame(); current = current.parentFrame()) {
    const host = await current.frameElement();
    try { if (!(await host.isVisible())) return []; }
    finally { await host.dispose(); }
  }
  invalidateFrame(frame);
  const start = refCounter;
  refCounter += 501;
  const items = await frame.evaluate(
    ({ sel, attr, cap, start }) => {
      const isVisible = (el) => {
        if (el.matches('input[type="hidden"]')) return false;
        if (typeof el.checkVisibility === "function" && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const isDisabled = (el) =>
        el.matches(":disabled") || el.getAttribute("aria-disabled") === "true" ||
        el.hasAttribute("data-visually-disabled") || Boolean(el.closest("[inert]"));
      const nodes = Array.from(document.querySelectorAll(sel)).filter(isVisible).slice(0, cap);
      return nodes.map((el, i) => {
        const ref = `e${start + i + 1}`;
        el.setAttribute(attr, ref);
        const label = (el.innerText || (el.matches('input[type="button"],input[type="submit"]') ? el.value : "") || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().slice(0, 80);
        return { ref, tag: el.tagName.toLowerCase(), type: el.getAttribute("type") || undefined, text: label, disabled: isDisabled(el) };
      });
    },
    { sel: INTERACTIVE_SELECTOR, attr: REF_TAG, cap: Math.max(0, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 200, 500)), start },
  );
  for (const item of items) {
    const handle = await frame.locator(`[${REF_TAG}="${item.ref}"]`).elementHandle();
    if (handle) references.set(item.ref, { page, frame, handle });
  }
  return items;
}

function locatorFor(page, args) {
  if (args.ref) {
    const entry = references.get(args.ref);
    if (!entry || entry.page !== page || entry.frame.isDetached() || (args.frame && frameId(entry.frame) !== args.frame)) throw new Error("reference is stale or belongs to another page or frame");
    return entry.frame.locator(`[${REF_TAG}="${args.ref}"]`);
  }
  if (args.selector) return targetFrame(page, args).locator(args.selector);
  throw new Error("a ref or selector is required");
}

async function verifiedLocator(page, args) {
  const locator = locatorFor(page, args).first();
  if (args.ref) {
    const entry = references.get(args.ref);
    if (!entry || await locator.count() !== 1 || !(await locator.evaluate((el, original) => el === original && el.isConnected, entry.handle))) throw new Error("reference target changed; inspect the page again");
  }
  return locator;
}

async function assertActionable(locator, action, timeout = DEFAULT_TIMEOUT) {
  await locator.waitFor({ state: "visible", timeout });
  const ref = await locator.getAttribute(REF_TAG);
  const entry = ref ? references.get(ref) : null;
  if (entry && !(await locator.evaluate((el, original) => el === original, entry.handle))) throw new Error("reference target changed; inspect the page again");
  if (await locator.evaluate(isElementDisabled)) throw new Error(`${action} target is disabled`);
}

async function clickForEvent(page, locator, event, timeout) {
  let timer, received, closed;
  const pending = new Promise((resolve, reject) => {
    received = resolve;
    closed = () => reject(new Error(`${event} interrupted; inspect the page before retrying`));
    page.once(event, received);
    page.once("close", closed);
    timer = setTimeout(() => reject(new Error(`${event} timed out; inspect the page before retrying`)), timeout);
  });
  try { return (await Promise.all([pending, locator.click({ timeout })]))[0]; }
  finally { clearTimeout(timer); page.off(event, received); page.off("close", closed); }
}

async function readUploadImage(file) {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error("upload path must be absolute");
  const resolved = await realpath(file);
  if (CONFIG_DIR) {
    const root = await realpath(CONFIG_DIR);
    const relative = path.relative(root, resolved);
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
      throw new Error("uploads from the private browser configuration directory are not allowed");
    }
  }
  if (!(await lstat(file)).isFile()) throw new Error("upload must be a regular file, not a directory or symlink");
  const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_UPLOAD_BYTES) throw new Error("upload must be a nonempty regular image within the upload byte limit");
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stat.size) throw new Error("upload file changed while reading; select it again");
    const bytes = buffer.subarray(0, size);
    let mimeType;
    if (size >= 24 && bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") mimeType = "image/png";
    else if (size >= 4 && bytes.subarray(0, 3).toString("hex") === "ffd8ff") mimeType = "image/jpeg";
    else if (size >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") mimeType = "image/webp";
    else if (size >= 10 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) mimeType = "image/gif";
    else throw new Error("upload must have a PNG, JPEG, WebP, or GIF signature");
    return { name: path.basename(file), mimeType, buffer: bytes };
  } finally { await handle.close(); }
}

async function fillAndVerify(locator, value) {
  await assertActionable(locator, "fill");
  await locator.fill(value, { timeout: DEFAULT_TIMEOUT });
  const observed = await locator.evaluate((el) => "value" in el ? String(el.value) : el.isContentEditable ? el.innerText : el.textContent || "");
  if (observed !== value) throw new Error("fill verification failed: visible control value did not match");
}

function boundedWaitMs(seconds) {
  if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) throw new Error("timeout must be a positive number of seconds");
  return Math.min(Number.isFinite(seconds) ? seconds * 1000 : DEFAULT_TIMEOUT, MAX_WAIT_MS);
}

function validateExpectation(expect) {
  if (!expect || typeof expect !== "object" || Array.isArray(expect)) throw new Error("expect must be an object");
  const kinds = ["visible", "hidden", "text", "count_increase", "new", "url", "popup", "response"];
  if (!kinds.includes(expect.kind)) throw new Error("invalid expectation kind");
  if (["visible", "hidden", "text", "count_increase", "new"].includes(expect.kind) && (typeof expect.selector !== "string" || !expect.selector.trim())) throw new Error("expect.selector is required");
  if (expect.kind === "text" && typeof expect.text !== "string") throw new Error("expect.text is required");
  if (expect.kind === "url" && (typeof expect.url !== "string" || !expect.url)) throw new Error("expect.url is required");
  if (expect.kind === "response" && (typeof expect.path !== "string" || !expect.path.startsWith("/") || expect.path.includes("?") || expect.path.includes("#"))) throw new Error("response path must be an exact path without query or fragment");
  if (expect.status !== undefined && (!Number.isInteger(expect.status) || expect.status < 100 || expect.status > 599)) throw new Error("invalid expected status");
}

async function observationState(frame, expect) {
  if (["url", "popup", "response"].includes(expect.kind)) return null;
  const locator = frame.locator(expect.selector);
  const count = await locator.count();
  const visible = count > 0 && await locator.first().isVisible();
  const value = expect.kind === "text" && count ? (await locator.first().textContent() || "").slice(0, 4096) : null;
  return { count, visible, value };
}

function changed(expect, before, after) {
  if (expect.kind === "new" || expect.kind === "count_increase") return after.count > before.count;
  if (expect.kind === "visible") return !before.visible && after.visible;
  if (expect.kind === "hidden") return before.visible && !after.visible;
  if (expect.kind === "text") return after.visible && after.value?.includes(expect.text) && before.value !== after.value;
  return false;
}

async function observeChange(page, frame, expect, timeout, signal, action) {
  validateExpectation(expect);
  const started = Date.now();
  const before = await observationState(frame, expect);
  const initialUrl = page.url();
  let event = null;
  let denial = null;
  let navigationStatus = null;
  const errors = [];
  const onPopup = () => { event = { kind: "popup" }; };
  const onResponse = response => {
    try {
      const url = new URL(response.url());
      if (url.origin === new URL(initialUrl).origin && response.status() >= 400 && errors.length < 10) errors.push({ kind: "http_error", status: response.status() });
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
        navigationStatus = response.status();
        if (response.status() === 401 || response.status() === 403) denial = { kind: "navigation", status: response.status() };
      }
      if (url.origin === new URL(initialUrl).origin && url.pathname === expect.path) {
        event = { kind: "response", status: response.status() };
      }
    } catch { /* Non-HTTP URLs are not evidence. */ }
  };
  if (expect.kind === "popup") page.on("popup", onPopup);
  if (action || expect.kind === "response") page.on("response", onResponse);
  let dispatched = false;
  try {
    if (signal?.aborted) return { status: "not_attempted", reason: "cancelled" };
    if (action) {
      try { await action(Math.max(1, timeout - (Date.now() - started))); dispatched = true; }
      catch { return { status: "unknown", reason: "action_interrupted", diagnostic: "inspect the page before retrying" }; }
    }
    while (Date.now() - started < timeout && !signal?.aborted) {
      if (page.isClosed() || frame.isDetached()) return { status: action ? "unknown" : "unresolved", reason: "target_closed" };
      if (denial) return { status: "access_denied", evidence: denial };
      if (navigationStatus !== null) {
        const classification = await navigationClassification(page, navigationStatus, Math.max(1, timeout - (Date.now() - started)));
        if (/challenge detected|access denied/i.test(classification)) return { status: "access_denied", evidence: { kind: "navigation", status: navigationStatus } };
        navigationStatus = null;
      }
      if (expect.kind === "url" && page.url() !== initialUrl && page.url() === expect.url) return { status: "confirmed", evidence: { kind: "url" } };
      if (event) {
        if (event.status === 401 || event.status === 403) return { status: "access_denied", evidence: event };
        if (expect.kind !== "response" || expect.status === undefined || event.status === expect.status) return { status: "confirmed", evidence: event };
      }
      if (before) {
        try { if (changed(expect, before, await observationState(frame, expect))) return { status: "confirmed", evidence: { kind: expect.kind } }; }
        catch (error) { if (!/execution context|navigation|context was destroyed/i.test(String(error))) throw error; }
      }
      await new Promise(resolve => {
        const timer = setTimeout(done, Math.min(50, Math.max(1, timeout - (Date.now() - started))));
        function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }
        signal?.addEventListener("abort", done, { once: true });
      });
    }
    return { status: action && dispatched ? "unknown" : "unresolved", reason: signal?.aborted ? "cancelled" : "timeout", ...(event ? { evidence: event } : {}), ...(errors.length ? { diagnostics: errors } : {}), ...(action ? { diagnostic: "inspect the page before retrying" } : {}) };
  } catch {
    return { status: action ? "unknown" : "unresolved", reason: "observation_interrupted", ...(action ? { diagnostic: "inspect the page before retrying" } : {}) };
  } finally {
    page.off("popup", onPopup);
    page.off("response", onResponse);
  }
}

async function navigationClassification(page, status, timeout = DEFAULT_TIMEOUT) {
  const denied = status === 401 || status === 403;
  try {
    const title = await page.title();
    const challengeTitle = /^(?:just a moment[.!\s…]*|checking your browser.*|attention required.*cloudflare.*|verify (?:that )?you are human[.!\s]*)$/i.test(title.trim());
    if (!denied && !challengeTitle) return status && status >= 400 ? ", HTTP error" : "";
    const body = await page.locator("body").innerText({ timeout: Math.max(1, Math.min(timeout, 1000)) });
    const challengeBody = /checking your browser|verify (?:that )?you are human|performing security verification|enable javascript and cookies to continue/i.test(body);
    if (denied ? /cloudflare|just a moment|checking your browser|verify you are human/i.test(`${title}\n${body}`) : challengeTitle && challengeBody) {
      return ", Cloudflare challenge detected; do not retry automatically";
    }
  } catch {}
  return denied ? ", access denied" : status && status >= 400 ? ", HTTP error" : "";
}

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });

function withDownloadTimeout(promise) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("browser download timed out")), DEFAULT_TIMEOUT); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function readDownloadStream(download) {
  let stream, timer, timedOut = false;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { timedOut = true; stream?.destroy(); reject(new Error("browser download timed out")); }, DEFAULT_TIMEOUT);
  });
  const read = (async () => {
    stream = await download.createReadStream();
    if (!stream) throw new Error("browser download has no stream");
    const chunks = [];
    let total = 0;
    for await (const chunk of stream) {
      total += chunk.length;
      if (total > MAX_DOWNLOAD_BYTES) { stream.destroy(); throw new Error("download exceeds maximum size"); }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  })();
  try { return await Promise.race([read, timeout]); }
  finally { clearTimeout(timer); if (timedOut) read.catch(() => {}); }
}

async function assertDestinationAvailable(destination) {
  try { await lstat(destination); throw new Error(`destination already exists: ${destination}`); }
  catch (err) { if (err?.code !== "ENOENT") throw err; }
}

async function validateAndWrite({ args, destination, bytes, contentType }) {
  contentType = String(contentType || "");
  if (!bytes.length) throw new Error("download is empty");
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error("download exceeds maximum size");
  if (typeof args.expected_content_type === "string" && !contentType.toLowerCase().includes(args.expected_content_type.toLowerCase())) {
    throw new Error(`download content type mismatch: ${contentType || "(missing)"}`);
  }
  if (Number.isFinite(args.min_bytes) && bytes.length < args.min_bytes) throw new Error(`download is smaller than ${args.min_bytes} bytes`);
  if (typeof args.signature_hex === "string") {
    const expected = args.signature_hex.replace(/\s+/g, "").toLowerCase();
    if (!/^[0-9a-f]*$/.test(expected) || !bytes.subarray(0, expected.length / 2).toString("hex").startsWith(expected)) {
      throw new Error("download signature mismatch");
    }
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (typeof args.expected_sha256 === "string" && sha256 !== args.expected_sha256.toLowerCase()) throw new Error("download SHA-256 mismatch");
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { flag: "wx" });
  return { sha256, bytes: bytes.length };
}

const HANDLERS = {
  async browser_status() {
    const page = pages[activeIndex];
    const pageOpen = Boolean(page && !page.isClosed());
    let origin = null;
    if (pageOpen) { try { origin = new URL(page.url()).origin; } catch {} }
    return text({
      runtime: SERVER_INFO.name,
      version: SERVER_INFO.version,
      ...(context && resolvedRuntime ? resolvedRuntime : browserRuntimeInfo(TASK_CONFIG)),
      mode: TASK_CONFIG.executionMode || "headless",
      virtualDisplay: TASK_CONFIG.executionMode === "virtual-display" ? process.env.DISPLAY : null,
      launchOptions: browserLaunchOptions(TASK_CONFIG),
      browserVersion: browser?.version() ?? null,
      contextOpen: Boolean(context),
      pageOpen,
      humanize: SESSION_CONFIG.humanize,
      url: pageOpen ? page.url() : null,
      hydratedAuthentication: Boolean(origin && verifiedOrigins.has(origin)),
      authenticationVerification: origin && hydratedOrigins.has(origin)
        ? (verifiedOrigins.has(origin) ? "verified" : "pending") : "none",
    });
  },
  async browser_navigate(args) {
    if (typeof args.url !== "string") throw new Error("url is required");
    const waitUntil = args.wait_until === undefined ? "load" : args.wait_until;
    if (!WAIT_UNTIL_ENUM.includes(waitUntil)) throw new Error("invalid wait_until");
    if (args.ready_selector !== undefined && (typeof args.ready_selector !== "string" || !args.ready_selector.trim())) throw new Error("ready_selector must be nonempty text");
    const budget = args.timeout !== undefined || args.ready_selector !== undefined ? boundedWaitMs(args.timeout) : DEFAULT_TIMEOUT;
    await ensureContext();
    const hydration = await maybeHydrate(args.url);
    const page = await ensureActivePage();
    const started = Date.now();
    const remaining = () => Math.max(1, budget - (Date.now() - started));
    const resp = await page.goto(args.url, { waitUntil, timeout: budget });
    const status = resp ? resp.status() : null;
    let classification = await navigationClassification(page, status, remaining());
    if (!classification && args.ready_selector !== undefined) {
      try { await page.locator(args.ready_selector).first().waitFor({ state: "visible", timeout: remaining() }); }
      catch (error) {
        classification = await navigationClassification(page, status, remaining());
        if (!classification) {
          if (error?.name !== "TimeoutError") throw error;
          throw new Error(`navigation readiness wait expired after ${budget}ms; the page remains open`);
        }
      }
    }
    if (!classification) await verifyHydratedAccount(page, hydration);
    if (resolveHumanize(args.humanize)) await applyNavigationDelay(remaining());
    return text(`navigated to ${page.url()} (status ${status ?? "n/a"}${classification})${hydration?.method === "user-confirmed" ? "; user-confirmed state loaded: verify account or requested task access in this context before claiming login success" : ""}`);
  },
  async browser_navigate_back() {
    await activePage().goBack();
    return text(`back to ${activePage().url()}`);
  },
  async browser_forward() {
    await activePage().goForward();
    return text(`forward to ${activePage().url()}`);
  },
  async browser_reload(args = {}) {
    const waitUntil = args.wait_until === undefined ? "load" : args.wait_until;
    if (!WAIT_UNTIL_ENUM.includes(waitUntil)) throw new Error("invalid wait_until");
    const budget = args.timeout !== undefined ? boundedWaitMs(args.timeout) : DEFAULT_TIMEOUT;
    const page = activePage();
    const started = Date.now();
    const remaining = () => Math.max(1, budget - (Date.now() - started));
    await page.waitForLoadState("networkidle", { timeout: Math.min(2000, remaining()) }).catch(() => {});
    const resp = await page.reload({ waitUntil, timeout: remaining() });
    const status = resp ? resp.status() : null;
    const classification = await navigationClassification(page, status, remaining());
    return text(`reloaded ${page.url()} (status ${status ?? "n/a"}${classification})`);
  },
  async browser_snapshot(args) {
    const page = activePage();
    const cap = Number.isFinite(args.max_chars) ? args.max_chars : 4000;
    const frame = targetFrame(page, args);
    const body = await frame.evaluate(() => document.body ? document.body.innerText : "");
    return text(`# ${await frame.title()}\nURL: ${frame.url()}\n\n${body.slice(0, cap)}`);
  },
  async browser_markdown(args) {
    const page = activePage();
    const cap = Number.isFinite(args.max_chars) ? args.max_chars : 4000;
    const md = await page.evaluate(() => {
      const parts = [];
      for (const el of document.querySelectorAll("h1,h2,h3,p,li,a")) {
        const t = (el.innerText || "").trim();
        if (!t) continue;
        const tag = el.tagName.toLowerCase();
        parts.push(tag === "h1" ? `# ${t}` : tag === "h2" ? `## ${t}` : tag === "h3" ? `### ${t}` : tag === "li" ? `- ${t}` : tag === "a" ? `[${t}](${el.getAttribute("href") || ""})` : t);
      }
      return parts.join("\n");
    });
    return text(md.slice(0, cap));
  },
  async browser_interactive_elements(args) {
    const list = await tagInteractive(activePage(), args.limit, args);
    return text(list.map((e) => `${e.ref} <${e.tag}${e.type ? ` type=${e.type}` : ""}> ${e.text}${e.disabled ? " [disabled]" : ""}`).join("\n") || "(none)");
  },
  async browser_frames() {
    const page = activePage();
    return text(page.frames().slice(0, 100).map(frame => {
      let origin = null;
      try { origin = new URL(frame.url()).origin; } catch {}
      return { id: frameId(frame), parent: frame.parentFrame() ? frameId(frame.parentFrame()) : null, name: frame.name().slice(0, 100), origin, main: frame === page.mainFrame() };
    }));
  },
  async browser_links(args) {
    const page = activePage();
    const limit = Number.isFinite(args.limit) ? args.limit : 100;
    const links = await page.evaluate((cap) => Array.from(document.querySelectorAll("a[href]")).slice(0, cap).map((a) => ({ text: (a.innerText || "").trim().slice(0, 120), href: a.href })), limit);
    return text(links.map((l) => `${l.text} -> ${l.href}`).join("\n") || "(no links)");
  },
  async browser_click(args) {
    const page = activePage();
    const locator = await verifiedLocator(page, args);
    if (args.expect) {
      validateExpectation(args.expect);
      const timeout = boundedWaitMs(args.timeout);
      const started = Date.now();
      await assertActionable(locator, "click", timeout);
      const entry = args.ref ? references.get(args.ref) : null;
      if (entry && !(await locator.evaluate((el, original) => el === original, entry.handle))) throw new Error("reference target changed; inspect the page again");
      const frame = entry?.frame ?? targetFrame(page, args);
      const result = await observeChange(page, frame, args.expect, Math.max(1, timeout - (Date.now() - started)), activeRequest?.signal, async remaining => {
        if (resolveHumanize(args.humanize)) await humanClick(locator, page, { timeout: remaining });
        else await locator.click({ timeout: remaining });
      });
      return text({ actionId: randomUUID(), dispatch: result.status === "not_attempted" ? "not_attempted" : result.reason === "action_interrupted" ? "unknown" : "completed", ...result, elapsedMs: Date.now() - started });
    }
    await assertActionable(locator, "click");
    const entry = args.ref ? references.get(args.ref) : null;
    if (entry && !(await locator.evaluate((el, original) => el === original, entry.handle))) throw new Error("reference target changed; inspect the page again");
    if (resolveHumanize(args.humanize)) await humanClick(locator, page, { timeout: DEFAULT_TIMEOUT });
    else await locator.click({ timeout: DEFAULT_TIMEOUT });
    return text(`clicked at ${page.url()}`);
  },
  async browser_fill(args) {
    if (typeof args.value !== "string") throw new Error("value is required");
    const page = activePage();
    await fillAndVerify(await verifiedLocator(page, args), args.value);
    return text(`filled and verified at ${page.url()}`);
  },
  async browser_type(args) {
    if (typeof args.text !== "string") throw new Error("text is required");
    const delay = args.delay_ms === undefined ? 0 : args.delay_ms;
    if (!Number.isFinite(delay) || delay < 0 || delay > 1000) throw new Error("delay_ms must be from 0 to 1000 milliseconds");
    const page = activePage();
    const locator = await verifiedLocator(page, args);
    if (resolveHumanize(args.humanize) && args.delay_ms === undefined) {
      const deadline = performance.now() + MAX_WAIT_MS;
      await assertActionable(locator, "type", MAX_WAIT_MS);
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error("typing deadline expired; inspect the field before retrying");
      await humanType(locator, args.text, { timeout: remaining });
    } else {
      await assertActionable(locator, "type");
      await locator.pressSequentially(args.text, { delay, timeout: DEFAULT_TIMEOUT });
    }
    return text(`typed at ${page.url()}`);
  },
  async browser_fill_form(args) {
    if (!Array.isArray(args.fields)) throw new Error("fields array is required");
    if (args.expect) {
      validateExpectation(args.expect);
      if (!args.submit_ref && !args.submit_selector) throw new Error("expect requires a submit control");
    }
    const page = activePage();
    for (const field of args.fields) {
      const loc = await verifiedLocator(page, { ...field, frame: field.frame ?? args.frame });
      const type = field.type || "text";
      if (type === "check" || type === "uncheck" || type === "select") {
        await assertActionable(loc, "fill");
        if (type === "check") await loc.check({ timeout: DEFAULT_TIMEOUT });
        else if (type === "uncheck") await loc.uncheck({ timeout: DEFAULT_TIMEOUT });
        else await loc.selectOption(field.value, { timeout: DEFAULT_TIMEOUT });
      } else await fillAndVerify(loc, String(field.value ?? ""));
    }
    if (args.submit_ref || args.submit_selector) {
      const submit = await verifiedLocator(page, { ref: args.submit_ref, selector: args.submit_selector, frame: args.frame });
      await assertActionable(submit, "submit");
      if (args.expect) {
        const frame = args.submit_ref ? references.get(args.submit_ref).frame : targetFrame(page, args);
        const started = Date.now();
        const result = await observeChange(page, frame, args.expect, boundedWaitMs(args.timeout), activeRequest?.signal, remaining => submit.click({ timeout: remaining }));
        return text({ actionId: randomUUID(), dispatch: result.status === "not_attempted" ? "not_attempted" : result.reason === "action_interrupted" ? "unknown" : "completed", ...result, elapsedMs: Date.now() - started, fieldsFilled: args.fields.length });
      }
      await submit.click({ timeout: DEFAULT_TIMEOUT });
    }
    return text(`filled ${args.fields.length} field(s)${args.submit_ref || args.submit_selector ? " and clicked submit control" : ""} at ${page.url()}`);
  },
  async browser_select_option(args) {
    const page = activePage();
    const locator = await verifiedLocator(page, args);
    await assertActionable(locator, "select");
    await locator.selectOption(args.value, { timeout: DEFAULT_TIMEOUT });
    return text(`selected at ${page.url()}`);
  },
  async browser_press_key(args) {
    const page = activePage();
    if (args.selector) await targetFrame(page, args).locator(args.selector).first().press(args.key, { timeout: DEFAULT_TIMEOUT });
    else await page.keyboard.press(args.key);
    return text(`pressed ${args.key}`);
  },
  async browser_get_attribute(args) {
    const value = await (await verifiedLocator(activePage(), args)).getAttribute(args.attribute, { timeout: DEFAULT_TIMEOUT });
    return text(value ?? "");
  },
  async browser_count(args) {
    return text(String(await targetFrame(activePage(), args).locator(args.selector).count()));
  },
  async browser_search(args) {
    const page = activePage();
    const limit = Number.isFinite(args.limit) ? args.limit : 10;
    const matches = await page.evaluate(({ query, cap }) => {
      const body = document.body ? document.body.innerText : "";
      const out = [];
      let from = 0;
      while (out.length < cap) {
        const idx = body.indexOf(query, from);
        if (idx === -1) break;
        out.push(body.slice(Math.max(0, idx - 40), idx + query.length + 40));
        from = idx + query.length;
      }
      return out;
    }, { query: args.query, cap: limit });
    return text(matches.length ? matches.map((m, i) => `${i + 1}. ...${m}...`).join("\n") : "(no matches)");
  },
  async browser_extract(args) {
    if (args.root !== undefined || args.fields !== undefined) {
      if (typeof args.root !== "string" || !args.root.trim() || !args.fields || typeof args.fields !== "object" || Array.isArray(args.fields)) throw new Error("root and fields are required");
      const entries = Object.entries(args.fields);
      if (!entries.length || entries.length > 30 || entries.some(([key, spec]) => !key || key.length > 100 || !spec || typeof spec !== "object" || typeof spec.selector !== "string" || !spec.selector || (spec.attribute !== undefined && (typeof spec.attribute !== "string" || !/^(href|src|title|alt|aria-[\w-]+|data-[\w-]+)$/.test(spec.attribute))))) throw new Error("invalid extraction fields");
      const limit = args.limit === undefined ? 30 : args.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("record limit must be 1 to 100");
      const result = await targetFrame(activePage(), args).evaluate(({ root, fields, limit }) => {
        const roots = Array.from(document.querySelectorAll(root));
        const records = roots.slice(0, limit).map(node => {
          const record = Object.create(null);
          for (const [key, spec] of Object.entries(fields)) {
            const el = node.querySelector(spec.selector);
            if (!el || el.matches('input,textarea,select,[contenteditable]') || !el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true })) { record[key] = null; continue; }
            const value = spec.attribute ? (spec.attribute === "href" && el instanceof HTMLAnchorElement ? el.href : el.getAttribute(spec.attribute)) : el.innerText;
            record[key] = value == null ? null : value.trim().slice(0, 1000);
          }
          return record;
        });
        return { records, truncated: roots.length > limit };
      }, { root: args.root, fields: args.fields, limit });
      while (JSON.stringify(result).length > 100000 && result.records.length) { result.records.pop(); result.truncated = true; }
      return text(result);
    }
    if (!args.schema || typeof args.schema !== "object") throw new Error("schema object is required");
    const result = await targetFrame(activePage(), args).evaluate((schema) => {
      const out = {};
      for (const [field, spec] of Object.entries(schema)) {
        const list = field.endsWith("[]");
        const key = list ? field.slice(0, -2) : field;
        const [sel, attr] = String(spec).split("@");
        const read = (el) => (attr ? el.getAttribute(attr) : el.innerText || "").trim();
        if (list) out[key] = Array.from(document.querySelectorAll(sel)).map(read);
        else { const el = document.querySelector(sel); out[key] = el ? read(el) : null; }
      }
      return out;
    }, args.schema);
    return text(result);
  },
  async browser_evaluate(args) {
    if (typeof args.expression !== "string") throw new Error("expression is required");
    if (hydratedOrigins.size) throw new Error("browser_evaluate is unavailable while saved authentication state is loaded");
    let value;
    try { value = await activePage().evaluate(args.expression); }
    catch (err) { value = `evaluate error: ${err instanceof Error ? err.message : String(err)}`; }
    return text(value === undefined ? "undefined" : value);
  },
  async browser_console_messages() {
    return text(consoleMessages.join("\n") || "(no console messages)");
  },
  async browser_scroll(args) {
    const dir = args.direction || "down";
    const amount = Number.isFinite(args.amount) ? args.amount : undefined;
    if (!["up", "down", "top", "bottom"].includes(dir)) throw new Error("invalid scroll direction");
    const page = activePage();
    const frame = targetFrame(page, args);
    const scroll = () => frame.evaluate(({ dir, amount, selector }) => {
      const target = selector ? document.querySelector(selector) : window;
      if (!target) throw new Error("scroll target not found");
      const by = amount || (target === window ? window.innerHeight : 400);
      if (dir === "top") (target === window ? window.scrollTo(0, 0) : (target.scrollTop = 0));
      else if (dir === "bottom") (target === window ? window.scrollTo(0, document.body.scrollHeight) : (target.scrollTop = target.scrollHeight));
      else if (target === window) window.scrollBy(dir === "up" ? -by : by, 0) || window.scrollBy(0, dir === "up" ? -by : by);
      else target.scrollTop += dir === "up" ? -by : by;
    }, { dir, amount, selector: args.selector });
    if (args.expect) {
      const started = Date.now();
      const result = await observeChange(page, frame, args.expect, boundedWaitMs(args.timeout), activeRequest?.signal, scroll);
      return text({ actionId: randomUUID(), dispatch: result.status === "not_attempted" ? "not_attempted" : result.reason === "action_interrupted" ? "unknown" : "completed", ...result, elapsedMs: Date.now() - started });
    }
    await scroll();
    return text(`scrolled ${dir}`);
  },
  async browser_wait_for(args) {
    const page = activePage();
    const timeout = boundedWaitMs(args.timeout);
    try { await targetFrame(page, args).locator(args.selector).first().waitFor({ state: "attached", timeout }); }
    catch (error) {
      if (error?.name === "TimeoutError") throw new Error(`bounded wait expired after ${timeout}ms at ${page.url()}`);
      throw error;
    }
    return text(`found ${args.selector} at ${page.url()}`);
  },
  async browser_wait_for_text(args) {
    const page = activePage();
    const timeout = boundedWaitMs(args.timeout);
    try { await targetFrame(page, args).getByText(args.text, { exact: false }).first().waitFor({ state: "visible", timeout }); }
    catch (error) {
      if (error?.name === "TimeoutError") throw new Error(`bounded wait expired after ${timeout}ms at ${page.url()}`);
      throw error;
    }
    return text(`text appeared: ${args.text} at ${page.url()}`);
  },
  async browser_wait_for_change(args) {
    const page = activePage();
    const started = Date.now();
    const result = await observeChange(page, targetFrame(page, args), args.expect, boundedWaitMs(args.timeout), activeRequest?.signal);
    return text({ ...result, elapsedMs: Date.now() - started });
  },
  async browser_screenshot(args) {
    if (typeof args.path !== "string") throw new Error("path is required");
    await activePage().screenshot({ path: args.path, fullPage: Boolean(args.full_page) });
    return text(`screenshot saved to ${path.resolve(args.path)}`);
  },
  async browser_upload_image(args) {
    const deadline = Date.now() + MAX_WAIT_MS;
    const remaining = () => {
      const ms = deadline - Date.now();
      if (ms <= 0) throw new Error("upload timed out; inspect the page before retrying");
      return ms;
    };
    const page = activePage();
    const payload = await readUploadImage(args.path);
    const locator = await verifiedLocator(page, args);
    await assertActionable(locator, "upload", remaining());
    const direct = await locator.evaluate(el => el instanceof HTMLInputElement && el.type === "file");
    const input = direct ? await locator.elementHandle({ timeout: remaining() }) : (await clickForEvent(page, locator, "filechooser", remaining())).element();
    try {
      const allowed = await input.evaluate(el => el instanceof HTMLInputElement && el.type === "file" &&
        !el.matches(":disabled") && el.getAttribute("aria-disabled") !== "true" &&
        !el.hasAttribute("data-visually-disabled") && !el.closest("[inert]"));
      if (!allowed) throw new Error("upload chooser target is disabled or not a file input");
      await input.setInputFiles(payload, { timeout: remaining() });
      const selected = await input.evaluate(el => Array.from(el.files || [], file => ({ name: file.name, size: file.size, type: file.type })));
      if (selected.length !== 1 || selected[0].name !== payload.name || selected[0].size !== payload.buffer.length || selected[0].type !== payload.mimeType) {
        throw new Error("attachment selection could not be verified; inspect the page before retrying");
      }
      return text({ status: "attached", name: payload.name, bytes: payload.buffer.length, contentType: payload.mimeType, sha256: createHash("sha256").update(payload.buffer).digest("hex") });
    } finally { await input?.dispose(); }
  },
  async browser_download(args) {
    if (typeof args.path !== "string" || (typeof args.url !== "string" && typeof args.selector !== "string" && typeof args.ref !== "string")) {
      throw new Error("path and either url, ref, or selector are required");
    }
    const destination = path.resolve(args.path);
    await assertDestinationAvailable(destination);
    const page = activePage();
    let bytes, contentType = "";
    if (typeof args.selector === "string" || typeof args.ref === "string") {
      const locator = await verifiedLocator(page, args);
      await assertActionable(locator, "download", MAX_WAIT_MS);
      const responses = [];
      const recordResponse = (response) => responses.push(response);
      page.on("response", recordResponse);
      try {
        const download = await clickForEvent(page, locator, "download", MAX_WAIT_MS);
        const failure = await withDownloadTimeout(download.failure());
        if (failure) throw new Error(`browser download failed: ${failure}`);
        const response = responses.find((candidate) => candidate.url() === download.url());
        contentType = response?.headers()["content-type"]?.toLowerCase() || "";
        bytes = await readDownloadStream(download);
      } finally { page.off("response", recordResponse); }
    } else {
      const fetched = await page.evaluate(async ({ url, timeoutMs, maxBytes }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const response = await fetch(url, { credentials: "include", signal: controller.signal });
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > maxBytes) throw new Error("download exceeds maximum size");
        const reader = response.body?.getReader();
        if (!reader) throw new Error("download response has no body");
        const chunks = [];
        let total = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) throw new Error("download exceeds maximum size");
            chunks.push(value);
          }
        } finally { clearTimeout(timer); }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return { status: response.status, contentType: response.headers.get("content-type") || "", data: btoa(binary) };
      }, { url: args.url, timeoutMs: DEFAULT_TIMEOUT, maxBytes: MAX_DOWNLOAD_BYTES });
      if (fetched.status < 200 || fetched.status >= 300) throw new Error(`download request failed with status ${fetched.status}`);
      bytes = Buffer.from(fetched.data, "base64");
      contentType = fetched.contentType.toLowerCase();
    }
    const saved = await validateAndWrite({ args, destination, bytes, contentType });
    return text(`download saved to ${destination} (${saved.bytes} bytes, sha256 ${saved.sha256})`);
  },
  async browser_save_media(args) {
    if (typeof args.path !== "string") throw new Error("path is required");
    const destination = path.resolve(args.path);
    await assertDestinationAvailable(destination);
    const page = activePage();
    const locator = await verifiedLocator(page, args);
    await locator.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    const media = await locator.evaluate(async (element, maxPixels) => {
      const assertPixelLimit = (width, height) => {
        if (height > 0 && width > Math.floor(maxPixels / height)) throw new Error(`media exceeds pixel limit of ${maxPixels}`);
      };
      if (element instanceof HTMLImageElement) {
        if (!element.complete || !element.naturalWidth) await element.decode();
        if (!element.naturalWidth || !element.naturalHeight) throw new Error("image has no decoded pixels");
        assertPixelLimit(element.naturalWidth, element.naturalHeight);
        const canvas = document.createElement("canvas");
        canvas.width = element.naturalWidth;
        canvas.height = element.naturalHeight;
        try {
          canvas.getContext("2d").drawImage(element, 0, 0);
          return { kind: "pixels", data: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
        } catch {
          const rect = element.getBoundingClientRect();
          return { kind: "screenshot", width: Math.round(rect.width), height: Math.round(rect.height) };
        }
      }
      if (element instanceof HTMLCanvasElement) {
        if (!element.width || !element.height) throw new Error("canvas has no pixels");
        assertPixelLimit(element.width, element.height);
        try {
          return { kind: "pixels", data: element.toDataURL("image/png"), width: element.width, height: element.height };
        } catch {
          const rect = element.getBoundingClientRect();
          return { kind: "screenshot", width: Math.round(rect.width), height: Math.round(rect.height) };
        }
      }
      throw new Error("media target must be an image or canvas");
    }, MAX_MEDIA_PIXELS);

    let bytes;
    if (media.kind === "pixels") {
      const match = /^data:([^;,]+);base64,(.*)$/.exec(media.data);
      if (!match) throw new Error("media did not produce base64 image data");
      bytes = Buffer.from(match[2], "base64");
    } else bytes = await locator.screenshot({ type: "png", timeout: DEFAULT_TIMEOUT });

    const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
    if (typeof args.reject_source_sha256 === "string" && sourceSha256 === args.reject_source_sha256.toLowerCase()) {
      throw new Error("media source matches the rejected fingerprint");
    }
    const saved = await validateAndWrite({ args, destination, bytes, contentType: "image/png" });
    return text(`media saved to ${destination} (${media.width}x${media.height}, ${saved.bytes} bytes, sha256 ${saved.sha256}, source sha256 ${sourceSha256})`);
  },
  async browser_tab_new(args) {
    await ensureContext();
    const page = await context.newPage();
    registerPage(page);
    activeIndex = pages.indexOf(page);
    if (typeof args.url === "string") {
      const hydration = await maybeHydrate(args.url);
      await page.goto(args.url, { waitUntil: "load" });
      await verifyHydratedAccount(page, hydration);
    }
    return text(`opened tab ${activeIndex}`);
  },
  async browser_tab_list() {
    const rows = await Promise.all(pages.map(async (p, i) => `${i}${i === activeIndex ? "*" : " "} ${p.url()} ${await p.title()}`));
    return text(rows.join("\n") || "(no tabs)");
  },
  async browser_tab_switch(args) {
    if (!pages[args.index]) throw new Error(`no tab at index ${args.index}`);
    activeIndex = args.index;
    return text(`active tab ${activeIndex}`);
  },
  async browser_tab_close(args) {
    const index = Number.isFinite(args.index) ? args.index : activeIndex;
    const page = pages[index];
    if (!page) throw new Error(`no tab at index ${index}`);
    await page.close();
    pages.splice(index, 1);
    if (activeIndex >= pages.length) activeIndex = Math.max(0, pages.length - 1);
    return text(`closed tab ${index}`);
  },
  async browser_configure(args) {
    if (args.humanize !== undefined) {
      if (typeof args.humanize !== "boolean") throw new Error("humanize must be boolean");
      SESSION_CONFIG.humanize = args.humanize;
    }
    return text({ configured: true, humanize: SESSION_CONFIG.humanize });
  },
  async browser_close() {
    await closeBrowser();
    return text("browser closed");
  },
};

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => { if (id !== undefined && id !== null) send({ jsonrpc: "2.0", id, result }); };
const replyError = (id, message) => {
  if (id !== undefined && id !== null) send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: message }], isError: true } });
};

async function handle(message) {
  const { id, method, params } = message || {};
  if (method === "initialize") return reply(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "ping") return reply(id, {});
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    if (!TOOL_NAMES.has(name)) return replyError(id, `unknown tool: ${name}`);
    const controller = new AbortController();
    activeRequest = { id, controller, signal: controller.signal };
    try { reply(id, await HANDLERS[name](args)); }
    catch (err) { replyError(id, `${name} failed: ${err instanceof Error ? err.message : String(err)}`); }
    finally { if (activeRequest?.id === id) activeRequest = null; }
    return;
  }
  if (id !== undefined && id !== null) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
}

let queue = Promise.resolve();
const reader = createInterface({ input: process.stdin });
reader.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === "notifications/cancelled") {
    if (activeRequest?.id === message.params?.requestId) activeRequest.controller.abort();
    return;
  }
  queue = queue.then(() => handle(message)).catch((err) => {
    process.stderr.write(`prometheus-browser: handler error: ${err instanceof Error ? err.stack : String(err)}\n`);
  });
});
reader.on("close", () => { queue = queue.then(() => closeBrowser()).finally(() => process.exit(0)); });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { void closeBrowser().finally(() => process.exit(signal === "SIGINT" ? 130 : 143)); });
}
