// Reproduce a goto rejection before the real main-document response arrives.
import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.PROMETHEUS_TEST_BROWSER_SERVER || import.meta.url)('playwright');
const launch = chromium.launch.bind(chromium);
chromium.launch = async options => {
  const browser = await launch(options);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    context.on('page', page => {
      const goto = page.goto.bind(page);
      page.goto = (url, options) => {
        if (!String(url).includes('/interrupt-')) return goto(url, options);
        return new Promise((resolve, reject) => {
          const onRequest = request => {
            if (request.isNavigationRequest() && request.frame() === page.mainFrame() && request.url() === url) {
              page.off('request', onRequest);
              reject(new Error(String(url).endsWith('/interrupt-drop') ? 'net::ERR_INVALID_AUTH_CREDENTIALS' : 'fixture: interrupted by another navigation'));
            }
          };
          page.on('request', onRequest);
          goto(url, options).then(resolve, reject).finally(() => page.off('request', onRequest));
        });
      };
    });
    return context;
  };
  return browser;
};
