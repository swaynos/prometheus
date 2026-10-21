#!/usr/bin/env node
// opencode-playwright-mcp.mjs
//
// Managed Playwright MCP stdio server. This is the project's single browser
// backend. It exposes the browser_* tool surface over newline-delimited
// JSON-RPC on stdin/stdout and drives one task browser via Playwright.
//
// Design (see docs/RESOURCE-SELECTION.md "Browser policy"):
//   - Task mode is headless or virtual-display. Human login is handled by
//     opencode-browser-login.mjs, which writes approved state that this server
//     loads privately. The visible login window never performs task work.
//   - Saved login state is loaded only for a matching approved origin, straight
//     into the browser context. State values (cookies, storage) never appear in
//     tool output, logs, or anything returned toward model context. The server
//     therefore does not expose cookie/storage export tools at all.
//   - Every wait and browser process has a bounded timeout and a cleanup path.
//
// Environment:
//   PROMETHEUS_CONFIG_DIR         config root holding prometheus-sessions/
//   PROMETHEUS_BROWSER_CHANNEL    default, chromium, or chrome
//   PROMETHEUS_BROWSER_EXECUTION_MODE headless or virtual-display
//   PROMETHEUS_BROWSER_STATES     optional comma list of state record names
//                                    to consider for hydration (default: all)
//   PROMETHEUS_BROWSER_TIMEOUT_MS default per-action timeout (default 30000)
//   PROMETHEUS_BROWSER_MAX_WAIT_MS maximum selector/text wait (default 25000)
//   PROMETHEUS_BROWSER_TRANSPORT_TIMEOUT_MS MCP request budget (default 30000)
//   PROMETHEUS_BROWSER_MAX_MEDIA_PIXELS maximum image/canvas pixels (default 16M)
//   PROMETHEUS_BROWSER_MAX_UPLOAD_BYTES maximum image upload bytes (default 20 MiB)

import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { lstat, mkdir, writeFile, open, realpath } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { loadStateForOrigin, listStates } from "./opencode-browser-state.mjs";
import { browserConfigFromEnv, browserLaunchOptions, browserRuntimeInfo, createTaskContext, hydrateBrowserState } from "./opencode-browser-runtime.mjs";
import { enterTaskDisplay } from "./opencode-browser-service.mjs";

// Re-exec the actual MCP service, not its caller, inside an isolated display.
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
const MAX_MEDIA_PIXELS = Number.isFinite(configuredMaxMediaPixels) && configuredMaxMediaPixels > 0
  ? Math.floor(configuredMaxMediaPixels)
  : 16 * 1024 * 1024;
const STATE_NAMES = (process.env.PROMETHEUS_BROWSER_STATES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const SERVER_INFO = { name: "prometheus-browser", version: "1.1.0" };
const PROTOCOL_VERSION = "2024-11-05";

// --- Tool surface ----------------------------------------------------------
// Each tool has a Playwright-backed handler. Cookie/storage export tools are
// deliberately absent: login state enters only through the private hydration
// path, never through a model-visible tool.

const TOOLS = [
  { name: "browser_navigate", description: "Navigate to a URL. Optionally select a load event and wait for a visible readiness selector without fixed sleeps.", inputSchema: { type: "object", properties: { url: { type: "string" }, wait_until: { type: "string", enum: ["commit", "domcontentloaded", "load", "networkidle"] }, ready_selector: { type: "string" }, timeout: { type: "number", description: "Total navigation/readiness budget in seconds, bounded by the transport budget." } }, required: ["url"] } },
  { name: "browser_status", description: "Return non-secret browser runtime and page health metadata.", inputSchema: { type: "object", properties: {} } },
  { name: "browser_navigate_back", description: "Go back in history.", inputSchema: { type: "object", properties: {} } },
  { name: "browser_forward", description: "Go forward in history.", inputSchema: { type: "object", properties: {} } },
  { name: "browser_reload", description: "Reload the current page.", inputSchema: { type: "object", properties: {} } },
  { name: "browser_snapshot", description: "Readable text of the current page (title, URL, body text).", inputSchema: { type: "object", properties: { max_chars: { type: "number" } } } },
  { name: "browser_markdown", description: "Current page rendered as terse Markdown-ish text.", inputSchema: { type: "object", properties: { max_chars: { type: "number" } } } },
  { name: "browser_interactive_elements", description: "List clickable/typeable elements with stable refs.", inputSchema: { type: "object", properties: { limit: { type: "number" } } } },
  { name: "browser_links", description: "List anchor links as {text, href}.", inputSchema: { type: "object", properties: { limit: { type: "number" } } } },
  { name: "browser_click", description: "Click an element by ref or selector.", inputSchema: { type: "object", properties: { ref: { type: "string" }, selector: { type: "string" } } } },
  { name: "browser_fill", description: "Set the value of an input by ref or selector.", inputSchema: { type: "object", properties: { ref: { type: "string" }, selector: { type: "string" }, value: { type: "string" } }, required: ["value"] } },
  { name: "browser_type", description: "Type text into an input (appends). Optional fixed delay_ms supports interfaces that need spaced keyboard events; default 0.", inputSchema: { type: "object", properties: { ref: { type: "string" }, selector: { type: "string" }, text: { type: "string" }, delay_ms: { type: "number", minimum: 0, maximum: 1000 } }, required: ["text"] } },
  { name: "browser_fill_form", description: "Fill multiple fields, optionally submit.", inputSchema: { type: "object", properties: { fields: { type: "array" }, submit_ref: { type: "string" }, submit_selector: { type: "string" } }, required: ["fields"] } },
  { name: "browser_select_option", description: "Select an option in a <select>.", inputSchema: { type: "object", properties: { selector: { type: "string" }, value: { type: "string" } }, required: ["selector", "value"] } },
  { name: "browser_press_key", description: "Dispatch a keyboard key.", inputSchema: { type: "object", properties: { key: { type: "string" }, selector: { type: "string" } }, required: ["key"] } },
  { name: "browser_get_attribute", description: "Read an attribute of an element.", inputSchema: { type: "object", properties: { ref: { type: "string" }, selector: { type: "string" }, attribute: { type: "string" } }, required: ["attribute"] } },
  { name: "browser_count", description: "Count elements matching a selector.", inputSchema: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"] } },
  { name: "browser_search", description: "Find substring matches in visible page text.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] } },
  { name: "browser_extract", description: "Extract a structured object from the page given {field: selector}.", inputSchema: { type: "object", properties: { schema: { type: "object" } }, required: ["schema"] } },
  { name: "browser_evaluate", description: "Evaluate a JavaScript expression in the page.", inputSchema: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] } },
  { name: "browser_console_messages", description: "Return console messages logged by the page.", inputSchema: { type: "object", properties: {} } },
  { name: "browser_scroll", description: "Scroll the page or an element.", inputSchema: { type: "object", properties: { direction: { type: "string" }, amount: { type: "number" }, selector: { type: "string" } } } },
  { name: "browser_wait_for", description: "Wait for a selector to appear.", inputSchema: { type: "object", properties: { selector: { type: "string" }, timeout: { type: "number" } }, required: ["selector"] } },
  { name: "browser_wait_for_text", description: "Wait for text to appear in the page.", inputSchema: { type: "object", properties: { text: { type: "string" }, timeout: { type: "number" } }, required: ["text"] } },
  { name: "browser_screenshot", description: "Capture the viewport as a PNG saved to path.", inputSchema: { type: "object", properties: { path: { type: "string" }, full_page: { type: "boolean" } }, required: ["path"] } },
  { name: "browser_upload_image", description: "Attach a user-requested local PNG, JPEG, WebP, or GIF through a visible file input or upload button. Returns verified attachment metadata, not server acceptance. Inspect the page before submitting or retrying.", inputSchema: { type: "object", properties: { ref: { type: "string" }, selector: { type: "string" }, path: { type: "string" } }, required: ["path"] } },
  { name: "browser_download", description: "Capture a download through a visible ref or selector, or retrieve a URL through the authenticated task page; save only after validation.", inputSchema: { type: "object", properties: { url: { type: "string" }, ref: { type: "string" }, selector: { type: "string" }, path: { type: "string" }, min_bytes: { type: "number" }, expected_sha256: { type: "string" }, expected_content_type: { type: "string" }, signature_hex: { type: "string" } }, required: ["path"] } },
  { name: "browser_save_media", description: "Save a visible image or canvas through the authenticated browser context without exposing its source URL.", inputSchema: { type: "object", properties: { ref: { type: "string" }, selector: { type: "string" }, path: { type: "string" }, reject_source_sha256: { type: "string" }, min_bytes: { type: "number" }, expected_sha256: { type: "string" }, expected_content_type: { type: "string" }, signature_hex: { type: "string" } }, required: ["path"] } },
  { name: "browser_tab_new", description: "Open a new tab, optionally navigating to a URL.", inputSchema: { type: "object", properties: { url: { type: "string" } } } },
  { name: "browser_tab_list", description: "List open tabs.", inputSchema: { type: "object", properties: {} } },
  { name: "browser_tab_switch", description: "Switch the active tab by index.", inputSchema: { type: "object", properties: { index: { type: "number" } }, required: ["index"] } },
  { name: "browser_tab_close", description: "Close a tab by index (default active).", inputSchema: { type: "object", properties: { index: { type: "number" } } } },
  { name: "browser_close", description: "Close the browser and reset state.", inputSchema: { type: "object", properties: {} } },
];
const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

// --- Browser lifecycle -----------------------------------------------------

let chromium = null;
let browser = null;
let context = null;
let resolvedRuntime = null;
let pages = []; // ordered list of Page
let activeIndex = 0;
const consoleMessages = [];
const hydratedOrigins = new Map();
const verifiedOrigins = new Set();

async function ensureChromium() {
  if (!chromium) ({ chromium } = await import("playwright"));
  return chromium;
}

function registerPage(page) {
  if (pages.includes(page)) return;
  pages.push(page);
  page.on("console", (msg) => {
    if (consoleMessages.length < 500) consoleMessages.push(`[${msg.type()}] ${msg.text()}`);
  });
}

async function ensureContext() {
  if (context) return context;
  await ensureChromium();
  ({ browser, context, runtime: resolvedRuntime } = await createTaskContext(chromium, TASK_CONFIG));
  context.setDefaultTimeout(DEFAULT_TIMEOUT);
  pages = [];
  context.on("page", registerPage);
  const existing = typeof context.pages === "function" ? context.pages() : [];
  if (existing.length) {
    for (const p of existing) registerPage(p);
  } else {
    registerPage(await context.newPage());
  }
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
  consoleMessages.length = 0;
  if (toClose) {
    try {
      await toClose.close();
    } catch {
      /* already gone */
    }
  }
}

// Candidate state record names to consider for hydration.
function candidateStateNames() {
  if (!CONFIG_DIR) return [];
  if (STATE_NAMES.length) return STATE_NAMES;
  try {
    return listStates(CONFIG_DIR).map((m) => m.name);
  } catch {
    return [];
  }
}

// Hydrate approved login state for a target origin, once per origin per process.
// Cookies go straight onto the live context; origin localStorage and any
// explicitly-captured session storage are restored via an init script so they
// are present before the navigation's first script runs. Nothing here is ever
// returned toward the model.
async function maybeHydrate(url) {
  if (!CONFIG_DIR) return;
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return;
  }
  if (hydratedOrigins.has(origin)) return { origin, ...hydratedOrigins.get(origin) };
  let stateWithoutVerification = false;
  for (const name of candidateStateNames()) {
    let loaded;
    try {
      loaded = loadStateForOrigin({ configDir: CONFIG_DIR, name, origin });
    } catch {
      continue;
    }
    if (!loaded) continue;
    const selector = loaded.verification?.selector;
    if (!selector && loaded.verification?.method !== "user-confirmed") {
      stateWithoutVerification = true;
      continue;
    }
    await hydrateBrowserState(context, loaded);
    hydratedOrigins.set(origin, loaded.verification);
    return { origin, ...loaded.verification }; // one matching record per origin
  }
  if (stateWithoutVerification) {
    throw new Error("saved login state has no account verification selector; complete a new login capture");
  }
  return null;
}

async function verifyHydratedAccount(page, hydration) {
  if (!hydration || verifiedOrigins.has(hydration.origin)) return;
  // Capture on the person's reply is not account evidence. Allow inspection
  // and task access in a fresh context; never label the restored state authenticated.
  if (hydration.method === "user-confirmed") return;
  let visible = false;
  try {
    visible = await page.locator(hydration.selector).first().isVisible();
  } catch {
    /* Invalid or obsolete selectors are handled as failed account evidence. */
  }
  if (!visible) {
    throw new Error("saved login state has no visible account evidence in the task browser; complete a new login capture");
  }
  verifiedOrigins.add(hydration.origin);
}

// --- Element resolution ----------------------------------------------------

const REF_TAG = "data-cw-ref";
const INTERACTIVE_SELECTOR =
  "a[href], button, input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=button], [role=link], [role=textbox], [onclick], [tabindex]";

// Assign stable refs (e1, e2, ...) to interactive elements and return a compact
// list. Refs live in a page attribute so a later click/fill can target them.
async function tagInteractive(page, limit) {
  return page.evaluate(
    ({ sel, attr, cap }) => {
      const isVisible = (el) => {
        if (el.matches('input[type="hidden"]')) return false;
        if (typeof el.checkVisibility === "function" && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const isDisabled = (el) =>
        el.matches(":disabled") ||
        el.getAttribute("aria-disabled") === "true" ||
        el.hasAttribute("data-visually-disabled") ||
        Boolean(el.closest("[inert]"));
      const nodes = Array.from(document.querySelectorAll(sel)).filter(isVisible).slice(0, cap);
      const out = [];
      let n = 0;
      for (const el of nodes) {
        n += 1;
        const ref = `e${n}`;
        el.setAttribute(attr, ref);
        const label = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().slice(0, 80);
        out.push({ ref, tag: el.tagName.toLowerCase(), type: el.getAttribute("type") || undefined, text: label, disabled: isDisabled(el) });
      }
      return out;
    },
    { sel: INTERACTIVE_SELECTOR, attr: REF_TAG, cap: Number.isFinite(limit) ? limit : 200 },
  );
}

function locatorFor(page, args) {
  if (args.ref) return page.locator(`[${REF_TAG}="${String(args.ref).replace(/"/g, '\\"')}"]`);
  if (args.selector) return page.locator(args.selector);
  throw new Error("a ref or selector is required");
}

async function assertActionable(locator, action, timeout = DEFAULT_TIMEOUT) {
  await locator.waitFor({ state: "visible", timeout });
  const disabled = await locator.evaluate((el) =>
    el.matches(":disabled") ||
    el.getAttribute("aria-disabled") === "true" ||
    el.hasAttribute("data-visually-disabled") ||
    Boolean(el.closest("[inert]")),
  );
  if (disabled) throw new Error(`${action} target is disabled`);
}

// Both event and click promises are observed, including when a click fails.
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
  const observed = await locator.evaluate((el) => {
    if ("value" in el) return String(el.value);
    if (el.isContentEditable) return el.innerText;
    return el.textContent || "";
  });
  if (observed !== value) throw new Error("fill verification failed: visible control value did not match");
}

function boundedWaitMs(seconds) {
  if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) throw new Error("timeout must be a positive number of seconds");
  const requested = Number.isFinite(seconds) ? seconds * 1000 : DEFAULT_TIMEOUT;
  return Math.min(requested, MAX_WAIT_MS);
}

async function navigationClassification(page, status, timeout = DEFAULT_TIMEOUT) {
  const denied = status === 401 || status === 403;
  try {
    const title = await page.title();
    const challengeTitle = /^(?:just a moment[.!\s…]*|checking your browser.*|attention required.*cloudflare.*|verify (?:that )?you are human[.!\s]*)$/i.test(title.trim());
    // Do not classify an ordinary page merely because it mentions Cloudflare.
    if (!denied && !challengeTitle) return status && status >= 400 ? ", HTTP error" : "";
    const body = await page.locator("body").innerText({ timeout: Math.max(1, Math.min(timeout, 1000)) });
    const challengeBody = /checking your browser|verify (?:that )?you are human|performing security verification|enable javascript and cookies to continue/i.test(body);
    if (denied ? /cloudflare|just a moment|checking your browser|verify you are human/i.test(`${title}\n${body}`) : challengeTitle && challengeBody) {
      return ", Cloudflare challenge detected; do not retry automatically";
    }
  } catch {
    /* Preserve the HTTP classification when the denial page cannot be read. */
  }
  return denied ? ", access denied" : status && status >= 400 ? ", HTTP error" : "";
}

// --- Tool handlers ---------------------------------------------------------

function text(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

function withDownloadTimeout(promise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("browser download timed out")), DEFAULT_TIMEOUT);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function readDownloadStream(download) {
  let stream;
  let timer;
  let timedOut = false;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      stream?.destroy();
      reject(new Error("browser download timed out"));
    }, DEFAULT_TIMEOUT);
  });
  const read = (async () => {
    stream = await download.createReadStream();
    if (!stream) throw new Error("browser download has no stream");
    const chunks = [];
    let total = 0;
    for await (const chunk of stream) {
      total += chunk.length;
      if (total > MAX_DOWNLOAD_BYTES) {
        stream.destroy();
        throw new Error("download exceeds maximum size");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  })();
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
    if (timedOut) read.catch(() => {});
  }
}

async function assertDestinationAvailable(destination) {
  try {
    await lstat(destination);
    throw new Error(`destination already exists: ${destination}`);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
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
      url: pageOpen ? page.url() : null,
      hydratedAuthentication: pageOpen && (() => {
        try {
          return verifiedOrigins.has(new URL(page.url()).origin);
        } catch {
          return false;
        }
      })(),
      authenticationVerification: pageOpen && hydratedOrigins.has(new URL(page.url()).origin)
        ? (verifiedOrigins.has(new URL(page.url()).origin) ? "verified" : "pending") : "none",
    });
  },
  async browser_navigate(args) {
    if (typeof args.url !== "string") throw new Error("url is required");
    const waitUntil = args.wait_until === undefined ? "load" : args.wait_until;
    if (!["commit", "domcontentloaded", "load", "networkidle"].includes(waitUntil)) throw new Error("invalid wait_until");
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
    // A denied page is not evidence that saved credentials need replacement.
    if (!classification) await verifyHydratedAccount(page, hydration);
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
  async browser_reload() {
    await activePage().reload();
    return text(`reloaded ${activePage().url()}`);
  },
  async browser_snapshot(args) {
    const page = activePage();
    const cap = Number.isFinite(args.max_chars) ? args.max_chars : 4000;
    const body = await page.evaluate(() => document.body ? document.body.innerText : "");
    return text(`# ${await page.title()}\nURL: ${page.url()}\n\n${body.slice(0, cap)}`);
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
        if (tag === "h1") parts.push(`# ${t}`);
        else if (tag === "h2") parts.push(`## ${t}`);
        else if (tag === "h3") parts.push(`### ${t}`);
        else if (tag === "li") parts.push(`- ${t}`);
        else if (tag === "a") parts.push(`[${t}](${el.getAttribute("href") || ""})`);
        else parts.push(t);
      }
      return parts.join("\n");
    });
    return text(md.slice(0, cap));
  },
  async browser_interactive_elements(args) {
    const list = await tagInteractive(activePage(), args.limit);
    return text(list.map((e) => `${e.ref} <${e.tag}${e.type ? ` type=${e.type}` : ""}> ${e.text}${e.disabled ? " [disabled]" : ""}`).join("\n") || "(none)");
  },
  async browser_links(args) {
    const page = activePage();
    const limit = Number.isFinite(args.limit) ? args.limit : 100;
    const links = await page.evaluate((cap) => Array.from(document.querySelectorAll("a[href]")).slice(0, cap).map((a) => ({ text: (a.innerText || "").trim().slice(0, 120), href: a.href })), limit);
    return text(links.map((l) => `${l.text} -> ${l.href}`).join("\n") || "(no links)");
  },
  async browser_click(args) {
    const page = activePage();
    const locator = locatorFor(page, args).first();
    await assertActionable(locator, "click");
    await locator.click({ timeout: DEFAULT_TIMEOUT });
    return text(`clicked at ${page.url()}`);
  },
  async browser_fill(args) {
    if (typeof args.value !== "string") throw new Error("value is required");
    const page = activePage();
    await fillAndVerify(locatorFor(page, args).first(), args.value);
    return text(`filled and verified at ${page.url()}`);
  },
  async browser_type(args) {
    if (typeof args.text !== "string") throw new Error("text is required");
    const delay = args.delay_ms === undefined ? 0 : args.delay_ms;
    if (!Number.isFinite(delay) || delay < 0 || delay > 1000) throw new Error("delay_ms must be from 0 to 1000 milliseconds");
    const page = activePage();
    const locator = locatorFor(page, args).first();
    await assertActionable(locator, "type");
    await locator.pressSequentially(args.text, { delay, timeout: DEFAULT_TIMEOUT });
    return text(`typed at ${page.url()}`);
  },
  async browser_fill_form(args) {
    if (!Array.isArray(args.fields)) throw new Error("fields array is required");
    const page = activePage();
    for (const field of args.fields) {
      const loc = locatorFor(page, field).first();
      const type = field.type || "text";
      if (type === "check") {
        await assertActionable(loc, "fill");
        await loc.check({ timeout: DEFAULT_TIMEOUT });
      } else if (type === "uncheck") {
        await assertActionable(loc, "fill");
        await loc.uncheck({ timeout: DEFAULT_TIMEOUT });
      } else if (type === "select") {
        await assertActionable(loc, "fill");
        await loc.selectOption(field.value, { timeout: DEFAULT_TIMEOUT });
      }
      else await fillAndVerify(loc, String(field.value ?? ""));
    }
    if (args.submit_ref || args.submit_selector) {
      const submit = locatorFor(page, { ref: args.submit_ref, selector: args.submit_selector }).first();
      await assertActionable(submit, "submit");
      await submit.click({ timeout: DEFAULT_TIMEOUT });
    }
    return text(`filled ${args.fields.length} field(s)${args.submit_ref || args.submit_selector ? " and clicked submit control" : ""} at ${page.url()}`);
  },
  async browser_select_option(args) {
    const page = activePage();
    const locator = page.locator(args.selector).first();
    await assertActionable(locator, "select");
    await locator.selectOption(args.value, { timeout: DEFAULT_TIMEOUT });
    return text(`selected at ${page.url()}`);
  },
  async browser_press_key(args) {
    const page = activePage();
    if (args.selector) await page.locator(args.selector).first().press(args.key, { timeout: DEFAULT_TIMEOUT });
    else await page.keyboard.press(args.key);
    return text(`pressed ${args.key}`);
  },
  async browser_get_attribute(args) {
    const value = await locatorFor(activePage(), args).first().getAttribute(args.attribute, { timeout: DEFAULT_TIMEOUT });
    return text(value ?? "");
  },
  async browser_count(args) {
    return text(String(await activePage().locator(args.selector).count()));
  },
  async browser_search(args) {
    const page = activePage();
    const limit = Number.isFinite(args.limit) ? args.limit : 10;
    const matches = await page.evaluate(
      ({ query, cap }) => {
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
      },
      { query: args.query, cap: limit },
    );
    return text(matches.length ? matches.map((m, i) => `${i + 1}. ...${m}...`).join("\n") : "(no matches)");
  },
  async browser_extract(args) {
    if (!args.schema || typeof args.schema !== "object") throw new Error("schema object is required");
    const page = activePage();
    const result = await page.evaluate((schema) => {
      const out = {};
      for (const [field, spec] of Object.entries(schema)) {
        const list = field.endsWith("[]");
        const key = list ? field.slice(0, -2) : field;
        const [sel, attr] = String(spec).split("@");
        const read = (el) => (attr ? el.getAttribute(attr) : el.innerText || "").trim();
        if (list) out[key] = Array.from(document.querySelectorAll(sel)).map(read);
        else {
          const el = document.querySelector(sel);
          out[key] = el ? read(el) : null;
        }
      }
      return out;
    }, args.schema);
    return text(result);
  },
  async browser_evaluate(args) {
    if (typeof args.expression !== "string") throw new Error("expression is required");
    if (hydratedOrigins.size) throw new Error("browser_evaluate is unavailable while saved authentication state is loaded");
    let value;
    try {
      value = await activePage().evaluate(args.expression);
    } catch (err) {
      value = `evaluate error: ${err instanceof Error ? err.message : String(err)}`;
    }
    return text(value === undefined ? "undefined" : value);
  },
  async browser_console_messages() {
    return text(consoleMessages.join("\n") || "(no console messages)");
  },
  async browser_scroll(args) {
    const page = activePage();
    const dir = args.direction || "down";
    const amount = Number.isFinite(args.amount) ? args.amount : undefined;
    await page.evaluate(
      ({ dir, amount, selector }) => {
        const target = selector ? document.querySelector(selector) : window;
        const by = amount || (target === window ? window.innerHeight : 400);
        if (dir === "top") (target === window ? window.scrollTo(0, 0) : (target.scrollTop = 0));
        else if (dir === "bottom") (target === window ? window.scrollTo(0, document.body.scrollHeight) : (target.scrollTop = target.scrollHeight));
        else if (target === window) window.scrollBy(dir === "up" ? -by : by, dir === "left" || dir === "right" ? 0 : 0) || window.scrollBy(0, dir === "up" ? -by : by);
        else target.scrollTop += dir === "up" ? -by : by;
      },
      { dir, amount, selector: args.selector },
    );
    return text(`scrolled ${dir}`);
  },
  async browser_wait_for(args) {
    const page = activePage();
    const timeout = boundedWaitMs(args.timeout);
    try {
      await page.locator(args.selector).first().waitFor({ state: "attached", timeout });
    } catch (error) {
      if (error?.name === "TimeoutError") throw new Error(`bounded wait expired after ${timeout}ms at ${page.url()}`);
      throw error;
    }
    return text(`found ${args.selector} at ${page.url()}`);
  },
  async browser_wait_for_text(args) {
    const page = activePage();
    const timeout = boundedWaitMs(args.timeout);
    try {
      await page.getByText(args.text, { exact: false }).first().waitFor({ state: "visible", timeout });
    } catch (error) {
      if (error?.name === "TimeoutError") throw new Error(`bounded wait expired after ${timeout}ms at ${page.url()}`);
      throw error;
    }
    return text(`text appeared: ${args.text} at ${page.url()}`);
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
    const locator = locatorFor(page, args).first();
    await assertActionable(locator, "upload", remaining());
    const direct = await locator.evaluate(el => el instanceof HTMLInputElement && el.type === "file");
    let input;
    if (direct) input = await locator.elementHandle({ timeout: remaining() });
    else input = (await clickForEvent(page, locator, "filechooser", remaining())).element();
    try {
      // A hidden input is allowed only when the visible control opened its chooser.
      const allowed = await input.evaluate(el => el instanceof HTMLInputElement && el.type === "file" &&
        !el.matches(":disabled") && el.getAttribute("aria-disabled") !== "true" &&
        !el.hasAttribute("data-visually-disabled") && !el.closest("[inert]"));
      if (!allowed) throw new Error("upload chooser target is disabled or not a file input");
      await input.setInputFiles(payload, { timeout: remaining() });
      const selected = await input.evaluate(el => Array.from(el.files || [], file => ({ name: file.name, size: file.size, type: file.type })));
      if (selected.length !== 1 || selected[0].name !== payload.name || selected[0].size !== payload.buffer.length || selected[0].type !== payload.mimeType) {
        throw new Error("attachment selection could not be verified; inspect the page before retrying");
      }
      return text({ status: "attached", name: payload.name, bytes: payload.buffer.length, contentType: payload.mimeType,
        sha256: createHash("sha256").update(payload.buffer).digest("hex") });
    } finally { await input?.dispose(); }
  },
  async browser_download(args) {
    if (typeof args.path !== "string" || (typeof args.url !== "string" && typeof args.selector !== "string" && typeof args.ref !== "string")) {
      throw new Error("path and either url, ref, or selector are required");
    }
    const destination = path.resolve(args.path);
    await assertDestinationAvailable(destination);
    const page = activePage();
    let bytes;
    let contentType = "";
    if (typeof args.selector === "string" || typeof args.ref === "string") {
      const locator = locatorFor(page, args).first();
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
      } finally {
        page.off("response", recordResponse);
      }
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
      } finally {
        clearTimeout(timer);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return {
        status: response.status,
        contentType: response.headers.get("content-type") || "",
        data: btoa(binary),
      };
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
    const locator = locatorFor(page, args).first();
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
    const contentType = "image/png";
    if (media.kind === "pixels") {
      const match = /^data:([^;,]+);base64,(.*)$/.exec(media.data);
      if (!match) throw new Error("media did not produce base64 image data");
      bytes = Buffer.from(match[2], "base64");
    } else {
      bytes = await locator.screenshot({ type: "png", timeout: DEFAULT_TIMEOUT });
    }

    const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
    if (typeof args.reject_source_sha256 === "string" && sourceSha256 === args.reject_source_sha256.toLowerCase()) {
      throw new Error("media source matches the rejected fingerprint");
    }
    const saved = await validateAndWrite({ args, destination, bytes, contentType });
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
  async browser_close() {
    await closeBrowser();
    return text("browser closed");
  },
};

// --- JSON-RPC transport ----------------------------------------------------

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
function reply(id, result) {
  if (id === undefined || id === null) return;
  send({ jsonrpc: "2.0", id, result });
}
function replyError(id, message) {
  if (id === undefined || id === null) return;
  send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: message }], isError: true } });
}

async function handle(message) {
  const { id, method, params } = message || {};
  if (method === "initialize") {
    reply(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    return;
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "tools/list") {
    reply(id, { tools: TOOLS });
    return;
  }
  if (method === "ping") {
    reply(id, {});
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    if (!TOOL_NAMES.has(name)) {
      replyError(id, `unknown tool: ${name}`);
      return;
    }
    try {
      const result = await HANDLERS[name](args);
      reply(id, result);
    } catch (err) {
      replyError(id, `${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
  if (id !== undefined && id !== null) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

// Serialize handling so browser operations do not interleave.
let queue = Promise.resolve();
const reader = createInterface({ input: process.stdin });
reader.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  queue = queue.then(() => handle(message)).catch((err) => {
    process.stderr.write(`prometheus-browser: handler error: ${err instanceof Error ? err.stack : String(err)}\n`);
  });
});
reader.on("close", () => {
  queue = queue.then(() => closeBrowser()).finally(() => process.exit(0));
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { void closeBrowser().finally(() => process.exit(signal === "SIGINT" ? 130 : 143)); });
}
