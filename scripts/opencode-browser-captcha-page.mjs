// This function is serialized into the page: no imports or closure dependencies.
// Only operator-configured callbacks on trusted origins may supply custom tasks.
export function captureCaptchaCandidate({ challenge, turnstileOnly = false } = {}) {
  const isManaged = () => {
    const title = document.title.trim(), body = document.body?.innerText || '';
    const managed = /^(?:just a moment[.!\s…]*|checking your browser.*|attention required.*cloudflare.*|verify (?:that )?you are human[.!\s]*|access denied.*|forbidden)$/i.test(title) &&
      /checking your browser|verify (?:that )?you are human|performing security verification|enable javascript and cookies to continue|access denied|forbidden/i.test(body);
    return Boolean(managed || /\/sorry(?:\/|$)/.test(location.pathname) ||
      /our systems have detected unusual traffic from your computer network/i.test(body) ||
      document.querySelector('iframe[src*="/cdn-cgi/challenge-platform/"],form[action*="/cdn-cgi/challenge-platform/"]'));
  };
  if (isManaged()) return { status: 'unsupported', reason: 'access_denial_or_managed_challenge' };
  const visible = widget => {
    const rect = widget.getBoundingClientRect(), style = getComputedStyle(widget);
    return Boolean(rect.width && rect.height && style.visibility === 'visible' && style.display !== 'none');
  };
  const ownFunction = name => {
    if (!/^[A-Za-z_$][\w$]*$/.test(name || '')) return null;
    const descriptor = Object.getOwnPropertyDescriptor(window, name);
    return descriptor && typeof descriptor.value === 'function' ? descriptor.value : null;
  };
  let selector, type, taskCallback, callback, widget, readTask, name, key;
  if (challenge) {
    selector = challenge.widgetSelector;
    const widgets = [...document.querySelectorAll(selector)];
    if (widgets.length !== 1) return { status: 'unsupported', reason: 'ambiguous_widgets' };
    [widget] = widgets;
    taskCallback = ownFunction(challenge.taskCallback);
    callback = ownFunction(challenge.solutionCallback);
    if (!visible(widget) || !taskCallback || !callback) return { status: 'unsupported', reason: 'unverified_widget' };
    type = challenge.type;
    readTask = () => {
      const task = taskCallback();
      if (!task || Object.getPrototypeOf(task) !== Object.prototype || task.type !== type) return null;
      return task;
    };
  } else {
    selector = turnstileOnly ? '.cf-turnstile' : '.cf-turnstile, .g-recaptcha';
    const widgets = [...document.querySelectorAll(selector)];
    if (!widgets.length) {
      const other = document.querySelector('iframe[src*="recaptcha"], script[src*="recaptcha/"], .frc-captcha, .mtcaptcha, [data-captcha-id]');
      return other ? { status: 'unsupported', reason: 'site_adapter_required' } : { status: 'not_detected' };
    }
    if (widgets.length !== 1) return { status: 'unsupported', reason: 'ambiguous_widgets' };
    [widget] = widgets;
    const turnstile = widget.classList.contains('cf-turnstile');
    if (turnstile && widget.classList.contains('g-recaptcha')) return { status: 'unsupported', reason: 'ambiguous_widgets' };
    const enterprise = !turnstile && Boolean(document.querySelector('script[src*="/recaptcha/enterprise.js"]'));
    type = turnstile ? 'TurnstileTaskProxyless' : enterprise ? 'RecaptchaV2EnterpriseTaskProxyless' : 'RecaptchaV2TaskProxyless';
    name = widget.getAttribute('data-callback');
    key = widget.getAttribute('data-sitekey');
    callback = ownFunction(name);
    if (!visible(widget) || !key || key.length > 2048 || !callback ||
        ['data-action', 'data-cdata', 'data-chl-page-data'].some(a => widget.hasAttribute(a)) ||
        widget.getAttribute('data-size') === 'invisible') return { status: 'unsupported', reason: 'unverified_widget' };
    readTask = () => {
      if (widget.classList.contains('cf-turnstile') !== turnstile ||
          (!turnstile && !widget.classList.contains('g-recaptcha')) ||
          (turnstile && widget.classList.contains('g-recaptcha')) ||
          (!turnstile && Boolean(document.querySelector('script[src*="/recaptcha/enterprise.js"]')) !== enterprise) ||
          widget.getAttribute('data-callback') !== name || ownFunction(name) !== callback ||
          widget.getAttribute('data-sitekey') !== key || widget.getAttribute('data-size') === 'invisible' ||
          ['data-action', 'data-cdata', 'data-chl-page-data'].some(a => widget.hasAttribute(a))) return null;
      const task = { type, websiteURL: location.href, websiteKey: key };
      if (!turnstile && widget.hasAttribute('data-s')) {
        if (enterprise) task.enterprisePayload = { s: widget.getAttribute('data-s') };
        else task.recaptchaDataSValue = widget.getAttribute('data-s');
      }
      if (!turnstile && document.querySelector('script[src*="recaptcha.net/"]')) task.apiDomain = 'recaptcha.net';
      return task;
    };
  }
  const task = readTask();
  if (!task) return { status: 'unsupported', reason: 'unverified_widget' };
  const serialized = JSON.stringify(task), ownerDocument = document;
  const isCurrent = () => document === ownerDocument && !isManaged() && widget.isConnected &&
    widget.ownerDocument === document && visible(widget) && document.querySelectorAll(selector).length === 1 &&
    document.querySelector(selector) === widget &&
    (!challenge || (ownFunction(challenge.taskCallback) === taskCallback && ownFunction(challenge.solutionCallback) === callback)) &&
    JSON.stringify(readTask()) === serialized;
  return { status: 'candidate', type, task, widget, callback, key, name, document, isManaged, isCurrent };
}
