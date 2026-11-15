// Test process only: intercept the fixed provider origin, never a product option.
import http from 'node:http';
import https from 'node:https';
import { chromium } from 'playwright';
const port = Number(process.env.CAPTCHA_FIXTURE_PORT);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('fixture port required');
const request = http.request;
https.request = (url, options, callback) => {
  const target = new URL(url);
  if (target.origin !== 'https://api.2captcha.com' || !['/createTask', '/getTaskResult'].includes(target.pathname)) throw new Error('fixture blocks network');
  return request(`http://127.0.0.1:${port}${target.pathname}`, options, callback);
};
const launch = chromium.launch.bind(chromium);
chromium.launch = async (...args) => {
  const browser = await launch(...args), newContext = browser.newContext.bind(browser);
  browser.newContext = options => newContext({ ...options, ignoreHTTPSErrors: true });
  return browser;
};
