import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";

const repo = path.resolve(import.meta.dirname, "../..");
const load = async file => (await readFile(path.join(repo, file), "utf8"))
  .toLowerCase().replace(/\s+/g, " ");

test("rule selects user, project, then managed workflow without forcing its procedures", async () => {
  const text = await load("rules/resource-selection.md");
  let previous = -1;
  for (const step of ["explicit user direction", "project-local browser instructions", "managed `prometheus-browser` defaults"]) {
    const current = text.indexOf(step);
    assert.ok(current > previous, `missing or out-of-order precedence: ${step}`);
    previous = current;
  }
  assert.match(text, /may share a headed task window/);
  assert.match(text, /read `\.\.\/docs\/resource-selection\.md`/);
  assert.match(text, /apply its managed mode and login procedures only when using the default managed workflow/);
  assert.doesNotMatch(text, /opencode-browser-login\.mjs|tools for every browser action/);
});

test("browser tool procedures apply in user/project-selected workflows", async () => {
  const rule = await load("rules/resource-selection.md");
  assert.match(rule, /when using `prometheus-browser`, read `\.\.\/docs\/resource-selection\.md` relative to this rule before browser actions/);
  assert.match(rule, /follow its relevant tool procedures even in user\/project-selected workflows/);
  const reference = await load("docs/RESOURCE-SELECTION.md");
  assert.match(reference, /relevant tool procedures.*before using `prometheus-browser`, including in user\/project-selected workflows/);
  assert.match(reference, /apply the managed mode and login procedures only when.*default managed workflow/);
  assert.doesNotMatch(reference, /read this reference only when/);
});

test("compact rule retains shared safeguards", async () => {
  const text = await load("rules/resource-selection.md");
  for (const clause of [
    "mode 0600", "never expose credentials", "pause agent actions during human control",
    "recording requires explicit intent", "verify the saved artifact",
    "visible, enabled controls", "verify entered values and attachment acceptance",
    "validate downloads/generated files locally", "existing image is not a new generation result",
    "mark the outcome unknown", "never automatically replay unknown actions",
    "bounded waits", "report http 401/403 and challenges as access denial",
  ]) assert.ok(text.includes(clause), `missing safeguard: ${clause}`);
});

test("managed reference retains login, state, transfer, and failure procedures", async () => {
  const text = await load("docs/RESOURCE-SELECTION.md");
  for (const clause of [
    "headless", "virtual-display", "headed human-login", "do not complete the task in the login window",
    "opencode-browser-login.mjs", "after the user's reply", "do not poll",
    "mode-0600", "existing approved-origin tabs", "state values never enter model context",
    "browser_upload_image", "browser_download", "browser_save_media",
    "a page preview is not a delivered file", "an existing image is not success",
    "never repeat an unknown action automatically",
  ]) assert.ok(text.includes(clause), `missing managed procedure: ${clause}`);
});

test("rule is bounded and does not restore retired workflows", async () => {
  const text = await load("rules/resource-selection.md");
  assert.ok(text.split(/\s+/).length <= 400, "always-loaded rule exceeded its context budget");
  assert.doesNotMatch(text, /prometheus_browser_fallback|playwright-image-generation/);
});
