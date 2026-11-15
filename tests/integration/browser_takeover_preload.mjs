// Test-only launch substitution: exercise the real context/gate without opening a window.
import { chromium } from 'playwright';
const launch = chromium.launch.bind(chromium);
chromium.launch = options => launch({ ...options, headless: true });
