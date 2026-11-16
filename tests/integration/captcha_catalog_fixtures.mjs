// Synthetic fixtures, independently transcribed from the documented API shapes.
// No live site keys, images, credentials or provider requests.
const websiteURL = 'https://example.test/form';
const keyed = { websiteURL, websiteKey: 'private-sitekey' };
const media = 'aGVsbG8=';
const token = { token: 'private-token' };
const ua = { userAgent: 'fixture-agent' };
const proxy = { proxyType: 'http', proxyAddress: 'proxy.example.test', proxyPort: 8080, proxyLogin: 'fixture-user', proxyPassword: 'private-password' };
const rows = [
  ['RecaptchaV2Task', keyed, { gRecaptchaResponse: 'private-token' }],
  ['RecaptchaV2EnterpriseTask', { ...keyed, enterprisePayload: { s: 'private-data-s' } }, token],
  ['TurnstileTask', { ...keyed, action: 'form', data: 'private-data' }, token],
  ['FunCaptchaTask', { websiteURL, websitePublicKey: 'private-public-key', data: '{"blob":"private-blob"}' }, token],
  ['GeeTestTask', { websiteURL, gt: 'private-gt', challenge: 'private-challenge' }, { challenge: 'private-challenge', validate: 'private-validate', seccode: 'private-seccode' }],
  ['CapyTask', keyed, { captchakey: 'private-key', challengekey: 'private-challenge', answer: 'private-answer', respKey: '' }],
  ['KeyCaptchaTask', { websiteURL, s_s_c_user_id: 10, s_s_c_session_id: 'private-session', s_s_c_web_server_sign: 'private-sign', s_s_c_web_server_sign2: 'private-sign2' }, token],
  ['LeminTask', { websiteURL, captchaId: 'private-id', divId: 'widget' }, { answer: 'private-answer', challenge_id: 'private-challenge' }],
  ['AmazonTask', { ...keyed, iv: 'private-iv', context: 'private-context' }, { captcha_voucher: 'private-voucher', existing_token: 'private-token' }],
  ['AntiCyberSiAraTask', { websiteURL, SlideMasterUrlId: 'private-id', ...ua }, token],
  ['MtCaptchaTask', keyed, token],
  ['CutCaptchaTask', { websiteURL, miseryKey: 'private-misery', apiKey: 'private-api' }, token],
  ['FriendlyCaptchaTask', { ...keyed, version: 'v2' }, token],
  ['AtbCaptchaTask', { websiteURL, appId: 'private-app', apiServer: 'https://example.test/api' }, token],
  ['TencentTask', { websiteURL, appId: 'private-app' }, { appid: 'private-app', ret: 0, ticket: 'private-ticket', randstr: 'private-rand' }],
  ['ProsopoTask', keyed, token],
  ['AltchaTask', { websiteURL, challengeURL: 'https://example.test/challenge' }, token],
  ['YidunTask', keyed, token],
  ['BinanceTask', { ...keyed, validateId: 'private-validate' }, { ...token, ...ua }],
  ['BasiliskTask', keyed, { data: { captcha_response: 'private-response' }, headers: { 'User-Agent': 'fixture-agent' } }],
  ['AlibabaTask', { websiteURL, sceneId: 'private-scene', prefix: 'private-prefix' }, { data: { tokens: '{"sceneId":"private-scene"}' } }],
  ['YandexSmartCaptchaTask', keyed, token],
];
const singles = [
  ['RecaptchaV3TaskProxyless', { ...keyed, minScore: 0.9, pageAction: 'form', isEnterprise: true }, token],
  ['DataDomeSliderTask', { websiteURL, captchaUrl: 'https://example.test/captcha', ...ua, ...proxy }, { cookie: 'datadome=private-cookie; Path=/' }],
  ['CaptchaFoxTask', { ...keyed, ...ua, ...proxy }, token],
  ['VKCaptchaTask', { redirectUri: websiteURL, ...ua, ...proxy }, token],
  ['HuntTask', { websiteURL, apiGetLib: 'https://example.test/api.js', ...proxy }, token],
  ['TspdTask', { websiteURL, tspdCookie: 'private-cookie', htmlPageBase64: media, ...proxy }, { Domains: { 'example.test': { Cookies: { TS: 'private-cookie' } } } }],
  ['ImpervaTask', { websiteURL, incapsulaScriptUrl: '_Incapsula_Resource?x=1', incapsulaCookies: 'private-cookie', ...proxy }, { domains: { 'https://example.test': { cookies: { ___utmvc: 'private-cookie' } } } }],
  ['ImageToTextTask', { body: media, numeric: 0, minLength: 1, maxLength: 10 }, { text: 'private-answer' }],
  ['TextCaptchaTask', { comment: 'What is one plus one?' }, { text: 'two' }],
  ['AudioTask', { body: media, lang: 'en' }, { text: 'private-answer' }],
  ['RotateTask', { body: media, angle: 60 }, { rotate: 180 }],
  ['CoordinatesTask', { body: media }, { coordinates: [{ x: 12, y: 23 }] }],
  ['GridTask', { body: media, rows: 3, columns: 3, comment: 'select cars', imgType: 'recaptcha' }, { click: [1, 4, 9] }],
  ['DrawAroundTask', { body: media, comment: 'draw around the apple' }, { canvas: [[{ x: 1, y: 2 }, { x: 3, y: 4 }]] }],
  ['BoundingBoxTask', { body: media, comment: 'box the apple' }, { bounding_boxes: [{ xMin: 1, xMax: 5, yMin: 2, yMax: 6 }] }],
  ['DragAndDropTask', { background: media, images: [media, media] }, { coordinates: [{ x: 1, y: 2 }, null] }],
  ['TemuImageTask', { image: media, parts: [media] }, { coordinates: [{ x: 1, y: 2 }] }],
  ['VKCaptchaImageTask', { image: media, steps: [1, 2, 3] }, { best_step: 1, solution: [2, 3], answer: 'private-answer', preview: media }],
  ['SmartCaptchaTask', { image: media, imgInstructions: media }, { coordinates: [{ x: 1, y: 2 }] }],
  ['PazlCaptchaTask', { image: media, task: '[1,2,3]' }, '8'],
];

export const captchaFixtures = [
  ...rows.flatMap(([type, input, solution]) => [
    { task: { type: `${type}Proxyless`, ...input }, solution },
    { task: { type, ...input, ...proxy }, solution },
  ]),
  ...singles.map(([type, input, solution]) => ({ task: { type, ...input }, solution })),
  { task: { type: 'GridTaskProxyless', body: media, comment: 'select cars' }, solution: { click: [1] } },
  { task: { type: 'IncapsulaTask', websiteURL, incapsulaScriptUrl: '_Incapsula_Resource?x=1', incapsulaCookies: 'private-cookie', ...proxy }, solution: { domains: { 'https://example.test': { cookies: { ___utmvc: 'private-cookie' } } } } },
];

export const captchaVariants = [
  { name: 'GeeTest v4 proxyless', task: { type: 'GeeTestTaskProxyless', websiteURL, version: 4, initParameters: { captcha_id: 'private-id' } }, solution: { captcha_id: 'private-id', lot_number: 'private-lot', pass_token: 'private-pass', gen_time: '123', captcha_output: 'private-output' } },
  { name: 'GeeTest v4 proxied', task: { type: 'GeeTestTask', websiteURL, version: 4, initParameters: { captcha_id: 'private-id' }, ...proxy }, solution: { captcha_id: 'private-id', lot_number: 'private-lot', pass_token: 'private-pass', gen_time: '123', captcha_output: 'private-output' } },
  { name: 'Amazon jsapi', task: { type: 'AmazonTaskProxyless', websiteURL, jsapiScript: 'https://example.test/jsapi.js' }, solution: { captcha_voucher: 'private-voucher', existing_token: 'private-token' } },
  { name: 'Altcha JSON', task: { type: 'AltchaTaskProxyless', websiteURL, challengeJSON: '{"challenge":"private-challenge"}' }, solution: token },
  { name: 'reCAPTCHA invisible', task: { type: 'RecaptchaV2TaskProxyless', ...keyed, isInvisible: true, recaptchaDataSValue: 'private-data-s' }, solution: token },
  { name: 'reCAPTCHA v3 non-Enterprise', task: { type: 'RecaptchaV3TaskProxyless', ...keyed, minScore: 0.3, pageAction: 'form', isEnterprise: false, apiDomain: 'recaptcha.net' }, solution: { gRecaptchaResponse: 'private-token' } },
  { name: 'Friendly v1', task: { type: 'FriendlyCaptchaTaskProxyless', ...keyed, version: 'v1', moduleScript: 'https://example.test/module.js', nomoduleScript: 'https://example.test/widget.js' }, solution: token },
  { name: 'FunCaptcha grid', task: { type: 'GridTask', body: media, rows: 3, columns: 3, comment: 'select cars', imgType: 'funcaptcha' }, solution: { click: [2, 5] } },
  { name: 'Grid no matching images', task: { type: 'GridTask', body: media, comment: 'select cars', canNoAnswer: 1 }, solution: { click: 'No_matching_images' } },
  { name: 'Bounding box no matching images', task: { type: 'BoundingBoxTask', body: media, comment: 'box cars', canNoAnswer: 1 }, solution: { bounding_boxes: 'No_matching_images' } },
  { name: 'Image data URI', task: { type: 'ImageToTextTask', body: `data:image/gif;base64,${media}` }, solution: { text: 'private-text' } },
  { name: 'Image instruction', task: { type: 'CoordinatesTask', body: media, imgInstructions: media, minClicks: 1, maxClicks: 2 }, solution: { coordinates: [{ x: 0, y: 0 }] } },
];
