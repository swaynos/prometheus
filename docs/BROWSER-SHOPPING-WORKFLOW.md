# Product-to-cart workflow: manual checkout

## Purpose

Use this procedure to verify a product, make an approved cart change, and hand the existing browser to the user.
It uses `prometheus-browser` tools rather than an automated retailer integration.

Before work, select the backend, mode, authentication, and recording under the browser reference and applicable policy.
Use a dedicated automation profile.
Before changing a real cart, obtain explicit approval for the exact product, variant, quantity, and intended change.

## Prerequisites for human control

Before launch, obtain the user's explicit selection of managed `executionMode: "headed"`.
Require a dedicated automation profile and a graphical session that the user can access.
Do not change mode after denial.

Managed takeover keeps the same task browser, page, proxy owner, and named generation without transferring state to another context.
A headless task browser does not support human interaction and cannot convert to headed mode.
If takeover is unavailable, stop and report the limit. Do not close and reopen the browser to obtain takeover.

Linux virtual-display does not automatically provide a human-accessible desktop and is not accepted for this takeover.
The headed login helper captures authentication in a **separate context**, which does not contain the live cart.

Do not export storage, cookies, or credentials.
When a proxy is configured or user-requested, never bypass it to direct routing.
A session generation pins one configured endpoint, not a guaranteed exit IP.

## Cart procedure

1. Obtain the exact product URL, variant, quantity, and approved cart change.
   Record the selected backend, mode, and session.
2. Navigate with a bounded timeout.
   Stop on HTTP 401/403, proxy failure, managed challenge, or unverified navigation.
   This includes challenge pages with HTTP 200.
   Check `retryable` and `lastDenial.suggestions` in `browser_status`: retry after changing settings (including `browser_rotate_proxy`) if `retryable: true`; stop and report if `retryable: false`. When a proxy is configured or user-requested, never bypass it to direct routing.
   Paid CAPTCHA support does not authorize bypass of managed challenges.
   See [CAPTCHA coverage and disclosure](BROWSER-2CAPTCHA.md).
3. Inspect `browser_status`, `browser_snapshot`, and `browser_interactive_elements`.
   Where useful, inspect visible DOM records through `browser_extract`.
4. Compare the final origin and product identity with the request and visible product details.
   `https://shop.example/product/fixture-item-001` is a synthetic example, not a real storefront.
   Inspect current content, stock, controls, and redirects.
5. Use JSON-LD only as supporting evidence; it is optional and can be stale or inconsistent.
   Do not rely on hidden JSON-LD alone, infer stock from a missing offer, or assume its structure.
   If identity, availability, variant, price, or offer data conflict or remain unclear, stop and ask.
   Use `browser_evaluate` only for permitted, non-secret product metadata.
   If the context contains saved authentication, the runtime disables this tool.
   Never extract authentication data.
6. Require clear, visible in-stock evidence for the requested variant.
   Require a visible, enabled purchase control.
7. Inspect controls again.
   Select the requested variant through `browser_select_option` or a visible control.
   Set the requested quantity through `browser_fill` or an observed quantity control.
8. Inspect the updated controls to verify the selected variant, quantity, availability, and enabled state.
   Do not substitute variants or quantities.
   If you cannot establish the required state, stop.
   Fixture selectors are examples, not storefront selectors.
9. Where supported, inspect the current cart before adding anything.
   Compare every item, variant, and quantity with the required final cart.
   If the cart is already exact, do not add again.
   If extra items or an unclear baseline prevent verification, stop and ask.
   Do not remove or change items without approval.
10. Immediately before adding the item, record intent.
    Include the product, variant, quantity, baseline, and one authorized click.
11. Click once through `browser_click`.
    Where available, use a bounded expectation for a fresh page change.
    A response or confirmation alone does not prove cart contents.
12. After timeout, cancellation, connection loss, or an unknown result, mark the outcome **unknown**.
    Do not replay the action.
    Inspect the original page first.
    Then inspect the cart through visible controls, if safe.
    Reject duplicate or otherwise incorrect cart contents.
    If the result remains unresolved, stop and request human review.
13. A retry requires a new explicit decision and authorization based on the inspected state.
    Do not assume idempotency or remove duplicates without permission.
14. Navigate to the cart through observed controls.
    Inspect every line and quantity.
    Confirm the exact product, variant, quantity, and absence of unexpected lines.
    If evidence is unavailable or conflicting, report the result as unverified.
15. Pause for the human handoff below.
    Cart approval does not authorize checkout.
    Never automate checkout, payment, or order placement.

One browser click does not guarantee one server request.
After connection loss, Chromium or the transport can repeat a request, including POST.

## Managed task handoff and handback

1. After exact cart verification, obtain the user's actual consent.
2. Call `browser_takeover` with `user_requested: true`.
   The boolean records consent as a declaration, not proof of a person's identity.
   The queued call starts after earlier operations finish.
   If a mutation was interrupted, reconcile its unknown outcome first.
3. On success, tell the user that they control the existing window.
   Ask them to finish manually and remove visible payment data or other secrets before returning control.
   End the turn.
4. During takeover, do not record, poll, or automate.
   The runtime rejects agent tools except metadata-only status, close, and handback.
   Do not close the browser while the user works.
5. Only after explicit user confirmation, call `browser_handback` with `user_confirmed: true`.
   This declaration does not authenticate the user.
   A closed original page, lost context, or changed proxy generation or owner stops handback.
6. Before other actions, call `browser_snapshot` on the original page.
   Inspect only non-secret content.
   If inspection could expose sensitive data, do not resume.

Handoff does not prove checkout or order completion.

## User-selected external CDP browser

This procedure applies only if the user independently selected and supplied a human-accessible external CDP task browser.

1. Establish that the user can access the actual page and that the workflow permits human control.
2. Pause all agent actions. Leave that page open.
3. Wait for explicit return of control. Do not poll.
4. Inspect the page before further action.

External CDP does not support managed proxy configuration.
It is not a fallback or conversion of a managed task.
Do not start or reconfigure it to bypass denial.
Never automate checkout, payment, or order placement.

## Verification

```sh
node --test tests/integration/browser_shopping_workflow.test.mjs tests/integration/browser_takeover.test.mjs
```

The cart test uses synthetic server-backed cart data.
The takeover test substitutes a launch to exercise the control gate with a real headless browser and local proxy lease.
It does not use a human-visible desktop.
**No real storefront cart or checkout has been qualified.**
Neither test qualifies live retailer layout, real stock, a real proxy provider, or a human handoff.
