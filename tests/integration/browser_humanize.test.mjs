import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { humanType } from "../../scripts/opencode-browser-humanize.mjs";

test("human typing caps delays at one deadline and stops further input", async () => {
  const calls = [];
  const locator = { pressSequentially: async (char, options) => calls.push({ char, ...options }) };
  const started = performance.now();
  await assert.rejects(humanType(locator, "x".repeat(1000), {
    timeout: 50, minDelayMs: 1000, maxDelayMs: 1000,
  }), /typing deadline expired.*inspect the field/);
  assert.ok(performance.now() - started < 500, "the delay must be capped by the overall budget");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].timeout > 0 && calls[0].timeout <= 50);
  await sleep(60);
  assert.equal(calls.length, 1, "no background typing continues after expiry");
});

test("human typing passes decreasing remaining budgets to Playwright", async () => {
  const timeouts = [];
  let typed = "";
  const locator = { pressSequentially: async (char, { timeout }) => {
    timeouts.push(timeout);
    typed += char;
    await sleep(10);
  } };
  await humanType(locator, "abc", { timeout: 1000, minDelayMs: 5, maxDelayMs: 5 });
  assert.equal(typed, "abc");
  assert.ok(timeouts[0] <= 1000);
  assert.ok(timeouts[1] < timeouts[0]);
  assert.ok(timeouts[2] < timeouts[1]);
});

test("human typing does not continue after a Playwright input failure", async () => {
  let calls = 0;
  const locator = { pressSequentially: async () => {
    calls++;
    throw new Error("fixture input timeout");
  } };
  await assert.rejects(humanType(locator, "abc", { timeout: 50 }), /fixture input timeout/);
  assert.equal(calls, 1);
});
