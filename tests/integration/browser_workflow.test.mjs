import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";

const repo = path.resolve(import.meta.dirname, "../..");
const load = async file => (await readFile(path.join(repo, file), "utf8"))
  .toLowerCase().replace(/\s+/g, " ");

test("the rule selects user, project, then managed workflow without forcing managed procedures", async () => {
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
  assert.match(reference, /before using `prometheus-browser`, read the relevant tool procedures here\. this requirement also applies in user\/project-selected workflows/);
  assert.match(reference, /apply managed mode and login procedures only when the policy selects the default managed workflow/);
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
    "bounded waits", "check `retryable` and `lastdenial.suggestions`",
  ]) assert.ok(text.includes(clause), `missing safeguard: ${clause}`);
});

test("managed reference retains login, state, transfer, and failure procedures", async () => {
  const text = await load("docs/RESOURCE-SELECTION.md");
  for (const clause of [
    "headless", "virtual-display", "separate headed login window, not the task browser", "do not complete the task in the login window",
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

test("denial reference agrees with the rule that non-retryable denial means stop", async () => {
  const rule = await load("rules/resource-selection.md");
  const reference = await load("docs/RESOURCE-SELECTION.md");
  assert.match(rule, /stop and report if `retryable: false`/);
  const row = reference.split("| `retryable: false`")[1]?.split("|")[1];
  assert.ok(row, "missing non-retryable denial procedure");
  assert.match(row, /stop and report\. do not change settings or retry automatically/);
  assert.doesNotMatch(row, /or apply|untried setting/);
  assert.match(reference, /inferred dom health is advisory/);
  assert.match(reference, /snapshots are omitted by default/);
});

test("rewritten procedures retain paid authorization, unknown outcomes, and human-control limits", async () => {
  const captcha = await load("docs/BROWSER-2CAPTCHA.md");
  for (const clause of [
    "every solve also requires explicit paid authorization and limits",
    "navigation never starts a solve",
    "an actual charge can exceed the estimate and configured caps",
    "an unknown actual charge blocks every new reservation",
    "never discard unknown commitments to make capacity available",
    "do not guess zero",
    "stop on managed/full-page access denial",
    "it does not fall back",
    "navigation invalidates the solve",
    "these tests do not qualify live paid solves",
  ]) assert.ok(captcha.includes(clause), `missing CAPTCHA restriction: ${clause}`);
  const shopping = await load("docs/BROWSER-SHOPPING-WORKFLOW.md");
  for (const clause of [
    "never automate checkout, payment, or order placement",
    "cart approval does not authorize checkout",
    "do not replay the action",
    "a retry requires a new explicit decision and authorization",
    "during takeover, do not record, poll, or automate",
    "only after explicit user confirmation",
    "before other actions, call `browser_snapshot` on the original page",
    "no real storefront cart or checkout has been qualified",
  ]) assert.ok(shopping.includes(clause), `missing shopping restriction: ${clause}`);
});
