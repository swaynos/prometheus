// Test-only hook: close the real managed context when the fixture requests it.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const { chromium } = createRequire(process.env.PROMETHEUS_TEST_BROWSER_SERVER || import.meta.url)('playwright');
const launch = chromium.launch.bind(chromium);
chromium.launch = async options => {
  const browser = await launch(process.env.RECOVERY_TEST_HEADLESS ? { ...options, headless: true } : options);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    if (process.env.RECOVERY_CLOSE_SIGNAL) context.once('close', () => writeFileSync(process.env.RECOVERY_CLOSE_SIGNAL, 'closed'));
    await context.exposeBinding('__closeFixtureContext', () => { void context.close(); });
    return context;
  };
  return browser;
};
