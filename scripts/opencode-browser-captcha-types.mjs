// API v2 catalog reviewed against https://2captcha.com/api-docs (2026-11-15).
// Keep provider transport support separate from automatic browser application.
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const text = v => typeof v === 'string' && v.length > 0 && v.length <= 65536 && !v.includes('\0');
const integer = v => Number.isSafeInteger(v) && v >= 0;
const positive = v => integer(v) && v > 0;
const enumOf = (...values) => v => values.includes(v);
const url = v => {
  if (!text(v) || v.length > 4096) return false;
  try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && !u.hash; }
  catch { return false; }
};
const media = v => {
  if (typeof v !== 'string' || !v.length || v.length > 10 * 1024 * 1024) return false;
  if (!/^(?:data:[\w.+/-]+;base64,)?[A-Za-z0-9+/]+={0,2}$/.test(v)) return false;
  const base64 = v.replace(/^data:[\w.+/-]+;base64,/, '');
  return base64.replace(/=+$/, '').length % 4 !== 1 &&
    Buffer.from(base64, 'base64').toString('base64').replace(/=+$/, '') === base64.replace(/=+$/, '');
};
const arrayOf = check => v => Array.isArray(v) && v.length > 0 && v.length <= 10000 && v.every(check);
const record = v => plain(v) && Object.keys(v).length > 0;
const strings = v => record(v) && Object.values(v).every(text);
const domainCookies = (v, key) => record(v) && Object.values(v).every(domain => record(domain) && strings(domain[key]));
const point = v => plain(v) && integer(v.x) && integer(v.y);
const fields = (required, optional = {}) => ({ required, optional });
const catalog = Object.create(null);
// Both spellings occur in the provider's current documentation. Normalize to
// the concrete createTask request examples rather than inventing extra solvers.
export const CAPTCHA_TYPE_ALIASES = Object.freeze({ GridTaskProxyless: 'GridTask', IncapsulaTask: 'ImpervaTask' });
const canonicalType = type => Object.hasOwn(CAPTCHA_TYPE_ALIASES, type) ? CAPTCHA_TYPE_ALIASES[type] : type;
const add = (name, doc, schema, solution, proxy = 'none') => {
  catalog[name] = { doc: `https://2captcha.com/api-docs/${doc}`, ...schema, solution, proxy };
};
const pair = (name, doc, schema, solution = fields({ token: text })) => {
  add(`${name}Proxyless`, doc, schema, solution, 'optional');
  add(name, doc, schema, solution, 'required');
};
const website = { websiteURL: url };
const keyed = { ...website, websiteKey: text };
const ua = { userAgent: text };
const recaptchaOptions = { isInvisible: v => typeof v === 'boolean', ...ua, cookies: text, apiDomain: enumOf('google.com', 'recaptcha.net', 'www.google.com', 'www.recaptcha.net') };
const recaptchaSolution = fields({}, { token: text, gRecaptchaResponse: text });
pair('RecaptchaV2Task', 'recaptcha-v2', fields(keyed, { ...recaptchaOptions, recaptchaDataSValue: text }), recaptchaSolution);
pair('RecaptchaV2EnterpriseTask', 'recaptcha-v2-enterprise', fields(keyed, { ...recaptchaOptions, enterprisePayload: record }), recaptchaSolution);
add('RecaptchaV3TaskProxyless', 'recaptcha-v3', fields({ ...keyed, minScore: enumOf(0.3, 0.7, 0.9) }, { pageAction: text, isEnterprise: v => typeof v === 'boolean', apiDomain: recaptchaOptions.apiDomain }), recaptchaSolution, 'proxyless-only');
pair('TurnstileTask', 'cloudflare-turnstile', fields(keyed, { action: text, data: text, pagedata: text }), fields({ token: text }, ua));
pair('FunCaptchaTask', 'arkoselabs-funcaptcha', fields({ ...website, websitePublicKey: text }, { funcaptchaApiJSSubdomain: text, data: text, ...ua }));
pair('GeeTestTask', 'geetest', fields(website, { gt: text, challenge: text, version: enumOf(3, 4), initParameters: record, geetestApiServerSubdomain: text, riskType: text, ...ua }), fields({}, { challenge: text, validate: text, seccode: text, captcha_id: text, lot_number: text, pass_token: text, gen_time: text, captcha_output: text }));
pair('CapyTask', 'capy-puzzle-captcha', fields(keyed, ua), fields({ captchakey: text, challengekey: text, answer: text }, { respKey: v => typeof v === 'string' }));
pair('KeyCaptchaTask', 'keycaptcha', fields({ ...website, s_s_c_user_id: v => text(v) || positive(v), s_s_c_session_id: text, s_s_c_web_server_sign: text, s_s_c_web_server_sign2: text }));
pair('LeminTask', 'lemin', fields({ ...website, captchaId: text, divId: text }, { leminApiServerSubdomain: text, ...ua }), fields({ answer: text, challenge_id: text }));
pair('AmazonTask', 'amazon-aws-waf-captcha', fields(website, { websiteKey: text, iv: text, context: text, challengeScript: url, captchaScript: url, jsapiScript: url }), fields({ captcha_voucher: text, existing_token: text }));
pair('AntiCyberSiAraTask', 'anti-cyber-siara', fields({ ...website, SlideMasterUrlId: text, ...ua }));
pair('MtCaptchaTask', 'mtcaptcha', fields(keyed));
pair('CutCaptchaTask', 'cutcaptcha', fields({ ...website, miseryKey: text, apiKey: text }));
pair('FriendlyCaptchaTask', 'friendly-captcha', fields(keyed, { version: enumOf('v1', 'v2'), moduleScript: url, nomoduleScript: url }));
pair('AtbCaptchaTask', 'atb-captcha', fields({ ...website, appId: text, apiServer: url }));
pair('TencentTask', 'tencent', fields({ ...website, appId: text }, { captchaScript: url }), fields({ ticket: text, randstr: text }, { appid: text, ret: integer }));
pair('ProsopoTask', 'prosopo-procaptcha', fields(keyed));
pair('AltchaTask', 'altcha', fields(website, { challengeURL: url, challengeJSON: text }));
pair('YidunTask', 'yidun-necaptcha', fields(keyed, { ...ua, yidunGetLib: url, yidunApiServerSubdomain: text, challenge: text, hcg: text, hct: integer }));
pair('BinanceTask', 'binance-captcha', fields({ ...keyed, validateId: text }, ua), fields({ token: text }, ua));
pair('BasiliskTask', 'basilisk-captcha', fields(keyed, ua), fields({ data: v => record(v) && text(v.captcha_response) }, { headers: record }));
pair('AlibabaTask', 'alibaba-captcha', fields({ ...website, sceneId: text, prefix: text }, { userId: text, userUserId: text, verifyType: text, region: text, userCertifyId: text, apiGetLib: url, ...ua }), fields({ data: v => record(v) && text(v.tokens) }));
pair('YandexSmartCaptchaTask', 'yandex-smart-captcha', fields(keyed, { ...ua, cookies: text }));
add('DataDomeSliderTask', 'datadome-slider-captcha', fields({ ...website, captchaUrl: url, ...ua }), fields({ cookie: text }), 'required');
add('CaptchaFoxTask', 'captchafox', fields({ ...keyed, ...ua }, { apiServer: url }), fields({ token: text }), 'required');
add('VKCaptchaTask', 'vk-captcha', fields({ redirectUri: url, ...ua }), fields({ token: text }), 'required');
add('HuntTask', 'hunt-captcha', fields({ ...website, apiGetLib: url }, { ...ua, data: text }), fields({ token: text }), 'required');
add('TspdTask', 'tspd-captcha', fields({ ...website, tspdCookie: text, htmlPageBase64: media }, ua), fields({ Domains: v => domainCookies(v, 'Cookies') }), 'required');
add('ImpervaTask', 'imperva-incapsula', fields({ ...website, incapsulaScriptUrl: text, incapsulaCookies: text }, { ...ua, reese84UrlEndpoint: url }), fields({ domains: v => domainCookies(v, 'cookies') }), 'required');
const instructions = { comment: text, imgInstructions: media };
add('ImageToTextTask', 'normal-captcha', fields({ body: media }, { ...instructions, phrase: v => typeof v === 'boolean', case: v => typeof v === 'boolean', math: v => typeof v === 'boolean', numeric: enumOf(0, 1, 2, 3, 4), minLength: integer, maxLength: integer }), fields({ text }));
add('TextCaptchaTask', 'text', fields({ comment: text }), fields({ text }));
add('AudioTask', 'audio', fields({ body: media, lang: enumOf('en', 'fr', 'de', 'el', 'pt', 'ru') }), fields({ text }));
add('RotateTask', 'rotate', fields({ body: media }, { ...instructions, angle: v => positive(v) && v <= 360 }), fields({ rotate: v => integer(v) && v <= 360 }));
add('CoordinatesTask', 'coordinates', fields({ body: media }, { ...instructions, minClicks: integer, maxClicks: positive }), fields({ coordinates: arrayOf(point) }));
add('GridTask', 'grid', fields({ body: media }, { ...instructions, rows: positive, columns: positive, previousId: text, imgType: enumOf('recaptcha', 'funcaptcha'), minClicks: integer, maxClicks: positive, canNoAnswer: enumOf(0, 1) }), fields({ click: v => arrayOf(positive)(v) || v === 'No_matching_images' }));
add('DrawAroundTask', 'draw-around', fields({ body: media }, instructions), fields({ canvas: arrayOf(arrayOf(point)) }));
add('BoundingBoxTask', 'bounding-box', fields({ body: media }, { ...instructions, canNoAnswer: enumOf(0, 1) }), fields({ bounding_boxes: v => v === 'No_matching_images' || arrayOf(b => plain(b) && [b.xMin, b.xMax, b.yMin, b.yMax].every(integer) && b.xMin <= b.xMax && b.yMin <= b.yMax)(v) }));
add('DragAndDropTask', 'drag-and-drop', fields({ background: media, images: arrayOf(media) }, { comment: text }), fields({ coordinates: arrayOf(v => v === null || point(v)) }));
add('TemuImageTask', 'temu-captcha', fields({ image: media, parts: arrayOf(media) }), fields({ coordinates: arrayOf(point) }));
add('VKCaptchaImageTask', 'vk-captcha', fields({ image: media, steps: arrayOf(integer) }), fields({ best_step: integer, solution: arrayOf(integer), answer: text }, { preview: media }));
add('SmartCaptchaTask', 'yandex-smart-captcha', fields({ image: media, imgInstructions: media }, { comment: text }), fields({ coordinates: arrayOf(point) }));
add('PazlCaptchaTask', 'yandex-smart-captcha', fields({ image: media, task: text }), text);

const proxyFields = { proxyType: enumOf('http', 'socks4', 'socks5'), proxyAddress: v => text(v) && v.length <= 253 && !/[\s/@?#]/.test(v), proxyPort: v => positive(v) && v <= 65535 };
const proxyCredentials = { proxyLogin: text, proxyPassword: text };
const invalid = () => { throw new Error('invalid captcha task'); };
function checkFields(value, required, optional, strict = true) {
  if (!plain(value) || (strict && Object.keys(value).some(k => !Object.hasOwn(required, k) && !Object.hasOwn(optional, k)))) return false;
  return Object.entries(required).every(([k, check]) => Object.hasOwn(value, k) && check(value[k])) &&
    Object.entries(optional).every(([k, check]) => !Object.hasOwn(value, k) || check(value[k]));
}

// Reject accessors, custom prototypes, cycles, non-JSON values and prototype
// pollution keys before cloning. Neither errors nor capabilities contain inputs.
export function snapshotCaptchaValue(value) {
  let nodes = 0, bytes = 0;
  const walk = (v, depth) => {
    if (++nodes > 50000 || depth > 16) invalid();
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return v;
    if (typeof v === 'string' && v.length <= 10 * 1024 * 1024) {
      bytes += Buffer.byteLength(v);
      if (bytes > 16 * 1024 * 1024) invalid();
      return v;
    }
    if (!Array.isArray(v) && !plain(v)) invalid();
    const copy = Array.isArray(v) ? [] : {};
    for (const key of Object.keys(v)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) invalid();
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
      copy[key] = walk(descriptor.value, depth + 1);
    }
    return Object.freeze(copy);
  };
  const copy = walk(value, 0);
  if (Buffer.byteLength(JSON.stringify(copy)) > 16 * 1024 * 1024) invalid();
  return copy;
}

const capabilities = Object.fromEntries(Object.entries(catalog).map(([type, s]) => [type, Object.freeze({
  documentation: s.doc, proxy: s.proxy,
  required: Object.freeze(Object.keys(s.required)), optional: Object.freeze(Object.keys(s.optional)),
})]));
for (const [alias, canonical] of Object.entries(CAPTCHA_TYPE_ALIASES)) capabilities[alias] = Object.freeze({ ...capabilities[canonical], canonicalType: canonical });
export const CAPTCHA_TYPES = Object.freeze(capabilities);

function snapshotTask(input) {
  const task = snapshotCaptchaValue(input);
  return plain(task) && canonicalType(task.type) !== task.type
    ? Object.freeze({ ...task, type: canonicalType(task.type) }) : task;
}

export function validateCaptchaTask(input) {
  let task = snapshotTask(input);
  if (!plain(task) || !Object.hasOwn(catalog, task.type)) invalid();
  // A few provider examples spell these differently from their specification
  // tables. Accept either spelling, but reject ambiguous duplicate aliases.
  for (const [alias, canonical] of [['websiteUrl', 'websiteURL'], ['UserCertifyId', 'userCertifyId']]) {
    if (Object.hasOwn(task, alias)) {
      if (Object.hasOwn(task, canonical)) invalid();
      const copy = { ...task, [canonical]: task[alias] }; delete copy[alias];
      task = Object.freeze(copy);
    }
  }
  const schema = catalog[task.type], proxied = schema.proxy === 'required';
  if (!checkFields(task, { type: enumOf(task.type), ...schema.required, ...(proxied ? proxyFields : {}) }, { ...schema.optional, ...(proxied ? proxyCredentials : {}) })) invalid();
  if (proxied && Object.hasOwn(task, 'proxyLogin') !== Object.hasOwn(task, 'proxyPassword')) invalid();
  const base = task.type.replace(/Proxyless$/, '');
  if (base === 'GeeTestTask') {
    if (task.version === 4 ? !record(task.initParameters) || !text(task.initParameters.captcha_id) || task.gt !== undefined || task.challenge !== undefined : !text(task.gt) || !text(task.challenge) || task.initParameters !== undefined) invalid();
  }
  if (base === 'AmazonTask' && !(task.jsapiScript ? !task.iv && !task.context : text(task.websiteKey) && text(task.iv) && text(task.context))) invalid();
  if (base === 'AltchaTask' && (Object.hasOwn(task, 'challengeURL') === Object.hasOwn(task, 'challengeJSON'))) invalid();
  if (['GridTask', 'DrawAroundTask', 'BoundingBoxTask'].includes(base) && !task.comment && !task.imgInstructions) invalid();
  if (task.imgType && !task.comment) invalid();
  for (const [min, max] of [['minLength', 'maxLength'], ['minClicks', 'maxClicks']]) {
    if (task[min] !== undefined && task[max] > 0 && task[min] > task[max]) invalid();
  }
  if (base === 'GridTask' && task.rows && task.columns && [task.minClicks, task.maxClicks].some(v => v > task.rows * task.columns)) invalid();
  if (task.imgInstructions && Buffer.from(task.imgInstructions.replace(/^data:[\w.+/-]+;base64,/, ''), 'base64').length > 100 * 1024) invalid();
  if (base === 'PazlCaptchaTask') {
    let steps; try { steps = JSON.parse(task.task); } catch { invalid(); }
    if (!arrayOf(integer)(steps)) invalid();
  }
  return task;
}

export function validateCaptchaSolution(task, input) {
  task = { ...task, type: canonicalType(task.type) };
  const solution = snapshotCaptchaValue(input), schema = catalog[task.type];
  if (!schema) invalid();
  if (typeof schema.solution === 'function' ? !schema.solution(solution) : !checkFields(solution, schema.solution.required, schema.solution.optional, false)) invalid();
  if (task.type.startsWith('Recaptcha') && !text(solution.token) && !text(solution.gRecaptchaResponse)) invalid();
  if (task.type.startsWith('GeeTest')) {
    const keys = task.version === 4 ? ['captcha_id', 'lot_number', 'pass_token', 'gen_time', 'captcha_output'] : ['challenge', 'validate', 'seccode'];
    if (!keys.every(k => text(solution[k]))) invalid();
  }
  if (task.type === 'GridTask' && Array.isArray(solution.click) && task.rows && task.columns && solution.click.some(v => v > task.rows * task.columns)) invalid();
  if (task.type === 'DragAndDropTask' && solution.coordinates.length !== task.images.length) invalid();
  if (task.type === 'TemuImageTask' && solution.coordinates.length !== task.parts.length) invalid();
  return solution;
}

// Only the owner passes the pinned upstream endpoint, never the loopback relay.
// No implicit fallback when a task cannot use the browser's proxy.
export function bindCaptchaProxy(input, proxy) {
  const task = snapshotTask(input);
  if (!plain(task) || !Object.hasOwn(catalog, task.type)) invalid();
  if (!proxy) return validateCaptchaTask(task);
  const schema = catalog[task.type];
  if (schema.proxy === 'none') return validateCaptchaTask(task); // image/text recognition has no worker navigation
  if (schema.proxy === 'proxyless-only') throw new Error('captcha task is proxyless only');
  if (Object.keys(task).some(k => k.startsWith('proxy'))) invalid();
  const server = new URL(proxy.server);
  if (server.protocol !== 'http:' || server.username || server.password || server.search || server.hash || server.pathname !== '/') invalid();
  const bound = { ...task, type: task.type.replace(/Proxyless$/, ''), proxyType: 'http', proxyAddress: server.hostname.replace(/^\[|\]$/g, ''), proxyPort: Number(server.port || 80) };
  if (proxy.credentials) Object.assign(bound, { proxyLogin: proxy.credentials.username, proxyPassword: proxy.credentials.password });
  return validateCaptchaTask(bound);
}
