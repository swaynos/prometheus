// Operator decisions exercised over real MCP; not an automated retailer engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawnMcpClient } from './helpers.mjs';

const desired = { identity: 'fixture-item-001', variant: 'blue', quantity: '2' };
const env = {
  PROMETHEUS_CONFIG_DIR: '', PROMETHEUS_BROWSER_EXECUTION_MODE: 'headless',
  PROMETHEUS_BROWSER_CHANNEL: 'default', PROMETHEUS_BROWSER_STATES: '',
  PROMETHEUS_BROWSER_IDENTITY_PROFILE: 'false', PROMETHEUS_BROWSER_PROFILE: '',
  PROMETHEUS_BROWSER_HUMANIZE: 'false', PROMETHEUS_BROWSER_TIMEOUT_MS: '1500',
  PROMETHEUS_BROWSER_MAX_WAIT_MS: '800',
};
async function fixture(options = {}) {
  let adds = 0, checkout = 0;
  let cart = structuredClone(options.baseline ?? []);
  const requests = [];
  const server = http.createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('content-type', 'text/html');
    if (url.pathname === '/deny') return res.writeHead(options.status ?? 403).end('<h1>Denied</h1>');
    if (url.pathname === '/challenge') return res.end('<title>Just a moment...</title><h1>Checking your browser before accessing example.com</h1>');
    if (url.pathname === '/redirect') return res.writeHead(302, { location: '/product/wrong' }).end();
    if (url.pathname === '/checkout') { checkout++; return res.end('<h1>Checkout must never be reached</h1>'); }
    if (url.pathname === '/add') {
      if (req.method !== 'POST') return res.writeHead(405).end('POST required');
      adds++;
      if (!options.reject) cart.push({ identity: options.cartIdentity ?? desired.identity,
        variant: options.cartVariant ?? url.searchParams.get('variant'),
        quantity: options.cartQuantity ?? url.searchParams.get('quantity') });
      if (options.disconnect) return req.socket.destroy();
      return res.writeHead(options.reject ? 500 : 200).end('fixture response');
    }
    if (url.pathname === '/cart') return res.end(`<!doctype html><title>Separate cart</title><h1>Cart</h1>
      <div id="cart">${cart.map(line => `<article class="line"><span class="identity">${line.identity}</span><span class="variant">${line.variant}</span><span class="quantity">${line.quantity}</span></article>`).join('')}</div>
      <a id="product" href="/product/${desired.identity}">Product</a><a id="checkout" href="/checkout">Checkout</a>`);
    const identity = url.pathname.endsWith('/wrong') ? 'wrong' : (options.identity ?? desired.identity);
    const metadata = options.metadata === undefined ? '' : `<script type="application/ld+json">${JSON.stringify(options.metadata)}</script>`;
    return res.end(`<!doctype html><title>Fixture product</title><h1>Fixture product</h1>${metadata}
      <p id="identity">${identity}</p><p id="stock">${options.stock ?? 'In stock'}</p><p id="price">$12.00</p>
      <select id="variant" aria-label="Variant"><option value="red">Red</option><option value="blue">Blue</option></select>
      <input id="quantity" aria-label="Quantity" type="number" value="1" min="1">
      <button id="add" ${options.disabled ? 'disabled' : ''} ${options.hidden ? 'hidden' : ''}>Add to cart</button>
      <p id="notice"></p><a id="cart-link" href="/cart">View cart</a><script>
      document.querySelector('#variant').onchange=()=>{if(${Boolean(options.variantOut)}) document.querySelector('#stock').textContent='Out of stock';};
      document.querySelector('#add').onclick=async()=>{window.fixtureClicks=(window.fixtureClicks||0)+1;const response=await fetch('/add?variant='+document.querySelector('#variant').value+'&quantity='+document.querySelector('#quantity').value,{method:'POST'});
      if(${!options.quiet}) document.querySelector('#notice').textContent=(${Boolean(options.misleading)} || response.ok)?'Added':'Failed';};
      </script>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { base: `http://127.0.0.1:${server.address().port}`, requests,
    adds: () => adds, checkout: () => checkout,
    close() { server.closeAllConnections(); server.close(); } };
}
async function withBrowser(options, run) {
  const site = await fixture(options);
  const c = spawnMcpClient(env);
  const call = async (name, args = {}) => {
    const r = await c.call(name, args); assert.notEqual(r?.isError, true, c.textOf(r)); return c.textOf(r);
  };
  const read = async expression => JSON.parse(await call('browser_evaluate', { expression: `JSON.stringify(${expression})` }));
  try { await run({ site, c, call, read }); assert.equal(site.checkout(), 0); }
  finally { await c.close(); site.close(); }
}
async function cartLines(call) {
  // Use the real extraction API on the dedicated cart document, not product text.
  const result = JSON.parse(await call('browser_extract', { root: '#cart .line', fields: {
    identity: { selector: '.identity' }, variant: { selector: '.variant' }, quantity: { selector: '.quantity' },
  } }));
  assert.equal(result.truncated, false);
  return result.records;
}
async function openCart(call, site) {
  await call('browser_click', { selector: '#cart-link', expect: { kind: 'url', url: `${site.base}/cart` }, timeout: 0.7 });
  assert.equal(JSON.parse(await call('browser_status')).url, `${site.base}/cart`);
  return cartLines(call);
}

test('independent separate cart: optional JSON-LD absent, exact identity/variant/quantity, persistent baseline, no duplicate', async () => {
  await withBrowser({}, async ({ site, call, read }) => {
    const target = `${site.base}/product/${desired.identity}`;
    await call('browser_navigate', { url: target, timeout: 1 });
    assert.equal(await read("document.querySelector('#identity').textContent"), desired.identity);
    assert.deepEqual(await openCart(call, site), []);
    await call('browser_click', { selector: '#product' });
    await call('browser_select_option', { selector: '#variant', value: 'blue' });
    await call('browser_fill', { selector: '#quantity', value: '2' });
    assert.equal(await read("document.querySelector('#variant').value+'|'+document.querySelector('#quantity').value"), 'blue|2');
    assert.equal(await read("document.querySelector('#stock').textContent"), 'In stock');
    // Intent: one approved synthetic add, empty baseline, blue x2, never checkout.
    const action = JSON.parse(await call('browser_click', { selector: '#add', expect: { kind: 'text', selector: '#notice', text: 'Added' }, timeout: 0.7 }));
    assert.equal(action.status, 'confirmed');
    assert.deepEqual(await openCart(call, site), [desired]);
    // Revisit the product and cart: server-backed cart persists across documents.
    await call('browser_click', { selector: '#product' });
    const baseline = await openCart(call, site);
    if (JSON.stringify(baseline) === JSON.stringify([desired])) assert.equal(site.adds(), 1);
    else assert.fail('exact cart not recognized');
  });
});

for (const [name, options] of [
  ['wrong identity', { identity: 'wrong' }], ['unknown stock', { stock: 'Unknown' }],
  ['variant-specific stock', { variantOut: true }], ['disabled add', { disabled: true }],
  ['hidden add', { hidden: true }],
  ['conflicting JSON-LD', { metadata: { '@type': 'Product', sku: 'wrong', offers: { availability: 'https://schema.org/InStock', price: '1' } } }],
]) test(`independent operator fixture stops before mutation: ${name}`, async () => {
  await withBrowser(options, async ({ site, call, read, c }) => {
    await call('browser_navigate', { url: `${site.base}/product/${desired.identity}`, timeout: 1 });
    await call('browser_select_option', { selector: '#variant', value: 'blue' });
    const evidence = await read(`({ identity: document.querySelector('#identity').textContent,
      stock: document.querySelector('#stock').textContent,
      enabled: !document.querySelector('#add').disabled,
      visible: !!document.querySelector('#add').getClientRects().length,
      metadata: document.querySelector('script[type="application/ld+json"]')?.textContent ?? null })`);
    const safe = evidence.identity === desired.identity && evidence.stock === 'In stock' && evidence.enabled && evidence.visible &&
      (!evidence.metadata || JSON.parse(evidence.metadata).sku === desired.identity);
    assert.equal(safe, false);
    if (options.hidden || options.disabled) {
      const blocked = await c.call('browser_click', { selector: '#add', timeout: 0.1, expect: { kind: 'text', selector: '#notice', text: 'Added' } });
      assert.ok(blocked.isError || JSON.parse(c.textOf(blocked)).status !== 'confirmed');
    }
    assert.equal(site.adds(), 0);
  });
});

test('a misleading Added notice after HTTP 500 cannot establish cart success', async () => {
  await withBrowser({ reject: true, misleading: true }, async ({ site, call }) => {
    await call('browser_navigate', { url: `${site.base}/product/${desired.identity}` });
    await call('browser_select_option', { selector: '#variant', value: 'blue' });
    await call('browser_fill', { selector: '#quantity', value: '2' });
    // Intent: one fixture add; the server intentionally rejects it.
    assert.equal(JSON.parse(await call('browser_click', { selector: '#add', expect: { kind: 'text', selector: '#notice', text: 'Added' }, timeout: 0.7 })).status, 'confirmed');
    assert.deepEqual(await openCart(call, site), []);
    assert.notDeepEqual(await cartLines(call), [desired]);
    assert.equal(site.adds(), 1);
  });
});

for (const [name, baseline] of [
  ['already exact', [desired]], ['wrong product', [{ ...desired, identity: 'other' }]],
  ['wrong variant', [{ ...desired, variant: 'red' }]], ['wrong quantity', [{ ...desired, quantity: '1' }]],
  ['extra line', [desired, { ...desired, identity: 'other' }]],
]) test(`independent separate cart baseline: ${name}; no unauthorized mutation`, async () => {
  await withBrowser({ baseline }, async ({ site, call }) => {
    await call('browser_navigate', { url: `${site.base}/product/${desired.identity}`, timeout: 1 });
    const lines = await openCart(call, site);
    assert.deepEqual(lines, baseline);
    assert.equal(JSON.stringify(lines) === JSON.stringify([desired]), name === 'already exact');
    assert.equal(site.adds(), 0);
  });
});

for (const [name, options] of [
  ['wrong cart identity', { cartIdentity: 'wrong' }], ['wrong cart variant', { cartVariant: 'red' }],
  ['wrong cart quantity', { cartQuantity: '1' }],
]) test(`independent separate cart rejects confirmation-only success: ${name}`, async () => {
  await withBrowser(options, async ({ site, call }) => {
    await call('browser_navigate', { url: `${site.base}/product/${desired.identity}`, timeout: 1 });
    await call('browser_select_option', { selector: '#variant', value: 'blue' });
    await call('browser_fill', { selector: '#quantity', value: '2' });
    // Intent: one synthetic blue x2 add; intentionally faulty server cart.
    assert.equal(JSON.parse(await call('browser_click', { selector: '#add', expect: { kind: 'text', selector: '#notice', text: 'Added' }, timeout: 0.7 })).status, 'confirmed');
    assert.notDeepEqual(await openCart(call, site), [desired]);
    assert.equal(site.adds(), 1);
  });
});

for (const disconnect of [false, true]) for (const reject of [false, true]) test(`independent unknown action: ${reject ? 'rejected' : 'accepted'} server mutation, ${disconnect ? 'socket drop' : 'no acknowledgement'}, inspect original then separate cart, no replay`, async () => {
  await withBrowser({ quiet: true, reject, disconnect }, async ({ site, call, read }) => {
    await call('browser_navigate', { url: `${site.base}/product/${desired.identity}`, timeout: 1 });
    await call('browser_select_option', { selector: '#variant', value: 'blue' });
    await call('browser_fill', { selector: '#quantity', value: '2' });
    // Intent: one synthetic blue x2 add, deliberately missing acknowledgement.
    const action = JSON.parse(await call('browser_click', { selector: '#add', expect: { kind: 'text', selector: '#notice', text: 'Added' }, timeout: 0.15 }));
    assert.equal(action.status, 'unknown');
    assert.match(await call('browser_snapshot'), /Fixture product/);
    assert.equal(await read('window.fixtureClicks'), 1, 'one DOM handler execution, not two tool clicks');
    const lines = await openCart(call, site);
    console.log('UNKNOWN_ACTION_EVIDENCE', JSON.stringify({ disconnect, reject, status: action.status, clicks: 1, adds: site.adds(), lines, requests: site.requests }));
    if (disconnect) {
      assert.ok(site.adds() >= 1);
      if (reject) assert.deepEqual(lines, []);
      else assert.equal(lines.length, site.adds());
      if (lines.length !== 1) assert.notDeepEqual(lines, [desired], 'duplicates cannot be accepted as exact');
    } else {
      assert.deepEqual(lines, reject ? [] : [desired]);
      assert.equal(site.adds(), 1);
    }
  });
});

for (const [path, options] of [['/deny', { status: 401 }], ['/deny', { status: 403 }], ['/challenge', {}]])
test(`independent stop on ${path} ${options.status ?? 200}`, async () => {
  await withBrowser(options, async ({ site, c }) => {
    const r = await c.call('browser_navigate', { url: `${site.base}${path}`, timeout: 0.7 });
    assert.match(c.textOf(r), /access.denied|challenge/i);
    assert.equal(site.adds(), 0);
    assert.equal(site.requests.filter(x => x === `GET ${path}`).length, 1);
  });
});

test('independent final URL/identity check catches redirect', async () => {
  await withBrowser({}, async ({ site, call, read }) => {
    await call('browser_navigate', { url: `${site.base}/redirect`, timeout: 1 });
    assert.equal(JSON.parse(await call('browser_status')).url, `${site.base}/product/wrong`);
    assert.equal(await read("document.querySelector('#identity').textContent"), 'wrong');
    assert.equal(site.adds(), 0);
  });
});
