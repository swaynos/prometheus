// Fixture-only certificate exception for the local HTTPS server; no global TLS bypass.
import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.PROMETHEUS_TEST_BROWSER_SERVER || import.meta.url)('playwright');
const launch = chromium.launch.bind(chromium);
chromium.launch = options => launch({ ...options, args: [...(options.args || []), `--ignore-certificate-errors-spki-list=${process.env.TEST_PROXY_SPKI}`] });
