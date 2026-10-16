import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import * as login from "../../scripts/opencode-browser-login.mjs";

test("user-confirmed capture includes approved popups without creating storage helper tabs", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route("https://**/*", (route) => route.fulfill({
      contentType: "text/html", body: '<button id="account" hidden>Account</button>',
    }));
    const page = await context.newPage();
    await page.goto("https://site.example/login");
    const opts = { origins: ["https://site.example"], captureSessionStorage: true };
    await page.goto("https://identity.example/login");
    const popup = await context.newPage();
    await popup.goto("https://site.example/home");
    await popup.evaluate(() => {
      localStorage.setItem("account", "fixture");
      sessionStorage.setItem("tab", "fixture-tab");
      document.querySelector("#account").hidden = false;
    });
    let extraPages = 0;
    context.on("page", () => extraPages++);
    context.storageState = () => { throw new Error("storageState must not run during capture"); };
    const result = await login.captureConfirmedState(context, opts);
    assert.deepEqual(result.sessionStorage, { "https://site.example": { tab: "fixture-tab" } });
    assert.deepEqual(result.storageState.origins, [{ origin: "https://site.example", localStorage: [{ name: "account", value: "fixture" }] }]);
    assert.equal(extraPages, 0);
    assert.equal(context.pages().length, 2);
    assert.equal(page.url(), "https://identity.example/login");
    const restored = await browser.newContext({ storageState: result.storageState });
    await restored.route("https://site.example/**", (route) => route.fulfill({ contentType: "text/html", body: "Fixture" }));
    const restoredPage = await restored.newPage();
    await restoredPage.goto("https://site.example/home");
    assert.equal(await restoredPage.evaluate(() => localStorage.getItem("account")), "fixture");
  } finally { await browser.close(); }
});

test("closed login windows fail promptly", async () => {
  await assert.rejects(login.captureConfirmedState({ pages: () => [] }, {}), /login window closed before capture/);
});

test("capture rejects a foreign-origin window immediately without taking snapshots", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route("https://**/*", (route) => route.fulfill({ contentType: "text/html", body: '<button id="account">Account</button>' }));
    const page = await context.newPage();
    await page.goto("https://identity.example/");
    context.storageState = () => { throw new Error("unexpected snapshot"); };
    let pages = 0;
    context.on("page", () => pages++);
    await assert.rejects(login.captureConfirmedState(context, { origins: ["https://site.example"] }), /return to an approved site/);
    assert.equal(pages, 0);
  } finally { await browser.close(); }
});
