// scripts/opencode-browser-humanize.mjs
//
// Human interaction simulation for Prometheus Playwright browser:
// - Jittered keystroke intervals (default 50–150ms)
// - Smooth curved mouse trajectory (cubic Bézier with random control points)
// - Realistic pre/post navigation delays (default 2–4s)
// - Configurable globally via PROMETHEUS_BROWSER_HUMANIZE or per tool invocation.

import { setTimeout as sleep } from "node:timers/promises";
import { randomInt } from "node:crypto";

export const HUMAN_DEFAULTS = {
  typingMinMs: 50,
  typingMaxMs: 150,
  navMinMs: 2000,
  navMaxMs: 4000,
  clickPauseMinMs: 50,
  clickPauseMaxMs: 120,
  mouseSteps: 20,
};

export function isHumanizeActive(toolArgValue, env = process.env) {
  if (typeof toolArgValue === "boolean") return toolArgValue;
  const raw = (env.PROMETHEUS_BROWSER_HUMANIZE || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export async function randomDelay(minMs, maxMs, maxCapMs = Infinity) {
  const boundedMin = Math.max(0, Math.floor(minMs));
  const boundedMax = Math.max(boundedMin, Math.floor(maxMs));
  const chosen = randomInt(boundedMin, boundedMax + 1);
  const actual = Math.min(chosen, maxCapMs);
  if (actual > 0) {
    await sleep(actual);
  }
  return actual;
}

export async function humanType(locator, text, options = {}) {
  const min = Number.isFinite(options.minDelayMs) ? options.minDelayMs : HUMAN_DEFAULTS.typingMinMs;
  const max = Number.isFinite(options.maxDelayMs) ? options.maxDelayMs : HUMAN_DEFAULTS.typingMaxMs;
  const timeout = options.timeout ?? 24000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("typing timeout must be positive and finite");
  const deadline = performance.now() + timeout;
  const remaining = () => {
    const budget = deadline - performance.now();
    if (budget <= 0) throw new Error("typing deadline expired; input may be partial; inspect the field before retrying");
    return budget;
  };

  for (const char of text) {
    await locator.pressSequentially(char, { timeout: remaining() });
    const delayBudget = remaining();
    const delay = await randomDelay(min, max, delayBudget);
    if (delay >= delayBudget) throw new Error("typing deadline expired; input may be partial; inspect the field before retrying");
    remaining();
  }
}

export async function curvedMouseMove(page, targetX, targetY, options = {}) {
  const steps = Number.isFinite(options.steps) && options.steps > 0 ? options.steps : HUMAN_DEFAULTS.mouseSteps;

  const start = await page.evaluate(() => {
    return {
      x: typeof window.__prometheusLastMouseX === "number" ? window.__prometheusLastMouseX : 0,
      y: typeof window.__prometheusLastMouseY === "number" ? window.__prometheusLastMouseY : 0,
    };
  }).catch(() => ({ x: 0, y: 0 }));

  const dx = targetX - start.x;
  const dy = targetY - start.y;

  // Generate randomized control points along the trajectory
  const cp1 = {
    x: start.x + dx * 0.25 + (Math.random() - 0.5) * Math.min(100, Math.abs(dx) + 20),
    y: start.y + dy * 0.25 + (Math.random() - 0.5) * Math.min(100, Math.abs(dy) + 20),
  };
  const cp2 = {
    x: start.x + dx * 0.75 + (Math.random() - 0.5) * Math.min(60, Math.abs(dx) + 10),
    y: start.y + dy * 0.75 + (Math.random() - 0.5) * Math.min(60, Math.abs(dy) + 10),
  };

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const inv = 1 - t;
    const x = Math.round(inv ** 3 * start.x + 3 * inv ** 2 * t * cp1.x + 3 * inv * t ** 2 * cp2.x + t ** 3 * targetX);
    const y = Math.round(inv ** 3 * start.y + 3 * inv ** 2 * t * cp1.y + 3 * inv * t ** 2 * cp2.y + t ** 3 * targetY);
    await page.mouse.move(x, y);
    const stepDelay = randomInt(4, 12);
    await sleep(stepDelay);
  }

  await page.evaluate(({ x, y }) => {
    window.__prometheusLastMouseX = x;
    window.__prometheusLastMouseY = y;
  }, { x: targetX, y: targetY }).catch(() => {});
}

export async function humanClick(locator, page, options = {}) {
  const timeout = options.timeout;
  const box = await locator.boundingBox({ timeout });
  if (box && box.width > 0 && box.height > 0) {
    // Pick target within central 60% of element
    const insetX = box.width * 0.2;
    const insetY = box.height * 0.2;
    const targetX = Math.round(box.x + insetX + Math.random() * (box.width - 2 * insetX));
    const targetY = Math.round(box.y + insetY + Math.random() * (box.height - 2 * insetY));

    await curvedMouseMove(page, targetX, targetY, options);
    await randomDelay(HUMAN_DEFAULTS.clickPauseMinMs, HUMAN_DEFAULTS.clickPauseMaxMs);
  }
  await locator.click({ timeout });
}

export async function applyNavigationDelay(maxAllowedBudgetMs = Infinity, options = {}) {
  const min = Number.isFinite(options.navMinMs) ? options.navMinMs : HUMAN_DEFAULTS.navMinMs;
  const max = Number.isFinite(options.navMaxMs) ? options.navMaxMs : HUMAN_DEFAULTS.navMaxMs;
  return randomDelay(min, max, maxAllowedBudgetMs);
}
