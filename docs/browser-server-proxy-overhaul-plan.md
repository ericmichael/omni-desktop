# Browser/Server Built-In Browser Proxy Overhaul Plan

## Problem

Browser/server mode uses an iframe plus the launcher server's `/proxy` routes to emulate the built-in browser. This differs from Electron mode, where Omni uses Electron's real `<webview>` guest browser. The iframe/proxy approach is still the right near-term architecture for browser/server mode, but the current implementation mixes user-facing browser state with internal proxy transport state and does not yet define a strong security or compatibility contract.

The visible failure is that a browser tab can end up with `/proxy/...` as its URL after flows such as clicking a PR badge in the code deck. When that happens, users see an implementation URL instead of the real destination, retries and history become confusing, and the iframe can fail to load. More broadly, common link, form, redirect, cookie, WebSocket, and runtime fetch flows can break because the proxy only rewrites a narrow set of static HTML attributes.

The overhaul should keep the current iframe/proxy model, but make it explicit, scoped, secure, and testable. The proxy should support a safe useful subset of browsing in browser/server mode, especially first-party/local/sandbox surfaces and common external documentation/PR workflows. It should not promise perfect parity with Electron's real browser engine.

## Goals

- Keep canonical user-facing URLs out of `/proxy` transport details.
- Make proxy registration reliable, scoped, and safe.
- Support common same-upstream browser operations through the proxy.
- Prevent proxied pages from becoming an open-proxy, SSRF, or same-origin attack surface.
- Add tests that define the proxy's supported behavior and security boundaries.
- Preserve Electron mode behavior.

## Non-Goals

- Do not replace Electron `<webview>` behavior.
- Do not turn the iframe proxy into a fully transparent general-purpose browser.
- Do not support every arbitrary public website feature such as WebAuthn/passkeys, DRM, extension APIs, camera/mic permissions, or anti-bot-protected flows.
- Do not broaden runtime shims until security isolation and session scoping tests exist.

## Current Context

### Electron Mode

Relevant files:

- `src/renderer/common/Webview.tsx`
- `src/main/app-control-manager.ts`
- `src/main/browser-manager.ts`

Electron mode renders `<webview>` and receives browser-native navigation, title, favicon, console, context menu, load, and failure events. It does not need `/proxy` for arbitrary external web pages.

### Browser/Server Mode

Relevant files:

- `src/renderer/common/Webview.tsx`
- `src/renderer/services/proxy-resolver.ts`
- `src/server/proxy-rewriter.ts`
- `src/renderer/features/Browser/BrowserView.tsx`
- `src/renderer/features/Tickets/preview-bridge.ts`

Browser/server mode renders an iframe. External iframe URLs are resolved through `/proxy/<name>/...` so the launcher server can strip `X-Frame-Options` and CSP `frame-ancestors`, rewrite same-upstream URLs, and inject lightweight scripts for navigation, title, console, and WebSocket handling.

### Existing Tests

Relevant files:

- `src/server/proxy-rewriter.test.ts`
- `tests/e2e/specs/*`

Phase 0 contract doc:

- `docs/proxy-security-contract.md`

Current proxy tests cover pure string rewriting for static HTML attributes, CSP meta stripping, and status URL rewriting. There is no dedicated e2e spec proving browser/server proxy behavior for real interactions such as link clicks, forms, redirects, cookies, streaming responses, runtime fetches, or PR badge navigation.

## Capability Contract

### Supported

The proxy should reliably support:

- Localhost and sandbox app surfaces exposed through browser/server mode.
- Code-server, noVNC, dashboards, notebooks, and internal app panes that are expected to run behind `/proxy`.
- GitHub PR and documentation browsing enough for common read/review workflows.
- Static same-upstream assets.
- Same-upstream links, forms, redirects, cookies, fetch/XHR, EventSource, WebSocket, and Workers where allowed by the security model.
- Clear fallback UI when a page cannot be proxied safely.

### Best Effort

The proxy may work but should not guarantee full support for:

- Complex public SPAs.
- OAuth redirect flows.
- File downloads and uploads.
- Cross-origin embedded widgets.
- Aggressive CSP/COOP/COEP pages.
- Sites that detect or reject embedding/proxying.

### Unsupported Or Fallback

The proxy should explicitly fail or offer fallback for:

- WebAuthn/passkeys.
- DRM/protected media.
- Browser extension APIs.
- Camera/microphone permissions inside proxied arbitrary pages.
- Service worker registration by proxied arbitrary pages.
- Anti-bot or high-security flows that require a real browser context.

## Security Model

Security must be defined before expanding compatibility shims. The proxy currently collapses many upstreams under the launcher origin at `/proxy/...`, and the iframe currently allows scripts and same-origin behavior in `src/renderer/common/Webview.tsx`. That makes isolation the highest-risk part of the overhaul.

### Required Security Decisions

- Proxy registrations are scoped to the authenticated user/session and browser tab or tabset.
- Proxy names are server-minted opaque capabilities, not renderer-controlled names.
- A proxied page cannot call launcher APIs such as `/api/*`, `/ws`, `/proxy/_register`, or unrelated `/proxy` names.
- A proxied page cannot access parent DOM, launcher storage, IPC bridges, or app state.
- A proxied page cannot register a service worker under the launcher origin.
- Cookie and storage behavior is isolated by proxy session/profile, or explicitly documented as unsupported for server-mode profiles.
- Sensitive query strings and tokens are redacted from proxy logs and UI diagnostics.
- Console capture for arbitrary proxied pages is disabled by default or clearly scoped to trusted/local app surfaces.

### SSRF And Open Proxy Controls

`/proxy/_register` must not become an authenticated SSRF/open-proxy primitive.

Rules:

- Accept only `http:` and `https:` upstreams for HTTP proxying.
- Reject empty, malformed, overlong, or renderer-chosen proxy names.
- Deny link-local, metadata, and private network ranges by default for arbitrary external browsing.
- Allow loopback/private upstreams only for trusted local/sandbox surfaces and existing configured trusted-network flows.
- Keep `OMNI_TRUSTED_CIDRS` support, but treat it as an operator-level allowance, not a substitute for session scoping.
- Add CSRF protection or same-session capability checks to registration and proxy access.

## Proposed Implementation

### Phase 0: Contract, Isolation, And Current-State Tests

Before broadening proxy behavior, codify the contract and prove current security boundaries.

Implementation work:

- Add a proxy capability/security section to developer docs or this plan's implementation ticket.
- Add current-state tests for `/proxy/_register` trust gating.
- Add hostile-page e2e tests that attempt to access launcher APIs, parent DOM, storage, service workers, and unrelated proxy names.
- Decide whether browser/server profile isolation is supported. If not, label it explicitly in UI/docs.

Phase 0 current-state coverage is intentionally narrow and executable without full browser/server app bootstrapping. See `docs/proxy-security-contract.md` for the supported/best-effort/unsupported contract, security invariants, and known gaps captured by `src/server/proxy-rewriter.test.ts`.

Acceptance criteria:

- The team can state exactly which page classes the proxy supports.
- Security tests exist before compatibility shims are expanded.
- Unsupported features fail clearly instead of silently breaking.

### Phase 1: Canonical URL State And Registration Reliability

Separate browser state from iframe transport state.

Relevant files:

- `src/renderer/services/proxy-resolver.ts`
- `src/renderer/common/Webview.tsx`
- `src/renderer/features/Browser/BrowserView.tsx`
- `src/renderer/features/Tickets/preview-bridge.ts`
- `src/main/browser-manager.ts`

Implementation work:

- Change `resolveProxiedSrc` to return a typed result instead of a raw string.
- Check `/proxy/_register` with `res.ok`; never cache failed registrations.
- Keep browser tab state, omnibox, history, app-control registration, and error displays canonical.
- Use `/proxy/...` only for iframe `src`.
- Remove PR/preview-specific pre-proxying from `preview-bridge.ts` so PR badge opens follow the same URL path as any other browser navigation.
- Normalize legacy persisted `/proxy/...` tab/history entries where possible using known registration state; otherwise show the safest canonical fallback or clear broken entries.

Recommended interface:

```ts
type ProxiedSrcResult =
  | {
      ok: true;
      canonicalUrl: string;
      iframeSrc: string;
      proxyName?: string;
    }
  | {
      ok: false;
      canonicalUrl: string;
      reason: string;
      status?: number;
    };

export const resolveProxiedSrc = async (rawSrc: string): Promise<ProxiedSrcResult>;
```

Acceptance criteria:

- `/proxy/...` never appears in omnibox/history for external pages.
- PR badge clicks store and display canonical GitHub PR URLs.
- Registration failures show a clear fallback instead of a dead proxy page.

### Phase 2: Session-Scoped Proxy Registration

Replace global proxy registration semantics with scoped capabilities.

Relevant files:

- `src/server/proxy-rewriter.ts`
- `src/renderer/services/proxy-resolver.ts`
- `src/server/ws-handler.ts`
- `src/server/managers.ts`

Implementation work:

- Replace renderer-supplied proxy names with server-minted IDs.
- Scope proxy entries to user/session/tabset, depending on the server-mode identity model available at request time.
- Store upstream metadata with owner, created time, last-used time, allowed path prefix, and site class.
- Enforce owner/capability checks on `/proxy/:proxyName/*` and `/proxy/_register`.
- Add expiry and cleanup for unused dynamic proxy entries.
- Validate upstream protocol and network range before registration.

Acceptance criteria:

- One session cannot overwrite, guess, or use another session's proxy registration.
- Two tabs/users can proxy the same upstream without cookie/proxy-name collisions.
- Dynamic registration cannot be used to reach denied internal targets.

### Phase 3: HTTP Proxy Semantics

Harden request/response handling before adding broad runtime shims.

Relevant file:

- `src/server/proxy-rewriter.ts`

Implementation work:

- Preserve method, query string, body, and content type for non-GET requests.
- Normalize upstream-facing `Host`, `Origin`, and `Referer` for same-upstream proxied requests.
- Continue dropping hop-by-hop headers.
- Use streaming for non-HTML bodies instead of buffering everything into memory.
- Use manual redirect handling so `Location` can be rewritten intentionally.
- Rewrite same-upstream `Location` headers to `/proxy/<name>/...`.
- Define and test cross-origin redirect behavior.
- Rewrite `Set-Cookie` headers safely for proxy paths, preserving valid `HttpOnly`, `Secure`, and `SameSite` attributes.
- Redact sensitive query parameters from logs.

Suggested helper exports:

```ts
export function rewriteLocationHeader(location: string, upstream: string, proxyName: string): string;
export function rewriteSetCookieHeader(cookie: string, proxyName: string): string;
export function redactProxyUrlForLog(url: string): string;
```

Acceptance criteria:

- Large files and SSE responses are streamed.
- Cookie-backed same-upstream flows work in the supported test harness.
- Redirect chains preserve canonical browser state and do not leak `/proxy` to UI state.

### Phase 4: Static HTML And CSS Rewriting

Expand static rewriting using safer helper boundaries.

Relevant file:

- `src/server/proxy-rewriter.ts`

Implementation work:

- Expand URL-bearing HTML attribute support:
  - `href`
  - `src`
  - `action`
  - `formaction`
  - `poster`
  - `data`
  - `srcset`
  - `iframe[src]`
  - `source[src]`
  - `track[src]`
  - preload/prefetch/modulepreload links
- Rewrite `meta[http-equiv=refresh]` URLs.
- Add CSS `url(...)` rewriting for same-upstream and root-relative assets.
- Preserve the current rule that inline JavaScript and JSON literals are not rewritten by static regex replacement.

Suggested helper exports:

```ts
export function rewriteHtmlUrls(html: string, upstream: string, proxyName: string): string;
export function rewriteCssUrls(css: string, upstream: string, proxyName: string): string;
export function rewriteMetaRefresh(html: string, upstream: string, proxyName: string): string;
```

Acceptance criteria:

- Common static assets load for supported pages.
- Third-party absolute URLs are not rewritten unless explicitly registered.
- Existing CSP and XFO stripping behavior remains intact for proxied HTML.

### Phase 5: Runtime Compatibility Shims Behind A Flag

Only after Phase 0 security tests and Phase 2 scoping land, broaden injected runtime support.

Relevant file:

- `src/server/proxy-rewriter.ts`

Implementation work:

- Replace the current minimal navigation/WebSocket injection with a versioned runtime shim.
- Gate expanded shims behind a feature flag or per-site-class allowlist.
- Rewrite same-upstream or root-relative runtime URLs for:
  - anchor clicks
  - `target=_blank`
  - `window.open`
  - form submissions
  - `fetch`
  - `XMLHttpRequest`
  - `EventSource`
  - `WebSocket`
  - `Worker`
- Use `new URL(input, location.href)` for all runtime URL parsing.
- Block or no-op service worker registration for arbitrary proxied pages unless explicitly trusted.
- Keep navigation/title postMessage reporting canonical.

Acceptance criteria:

- Runtime shims do not allow access to launcher APIs or unrelated proxy entries.
- Same-upstream runtime calls work in the synthetic e2e harness.
- The shim can be disabled quickly if it breaks pages.

### Phase 6: User-Facing Fallback And Diagnostics

Make failures explicit and recoverable.

Relevant files:

- `src/renderer/common/Webview.tsx`
- `src/renderer/features/Browser/BrowserView.tsx`

Implementation work:

- Add a browser/server proxy failure panel.
- Show canonical URL, short reason, retry, copy URL, and browser-native open/copy instructions.
- Avoid showing `/proxy/...` except in a details/debug section.
- Include specific messages for registration forbidden, denied upstream, DNS/TLS failure, timeout, redirect loop, and unsupported browser feature.

Acceptance criteria:

- Users never get stranded on an opaque `/proxy/...` error page.
- Failure states are actionable and include canonical URLs.

## Test Plan

### Unit Tests

Expand `src/server/proxy-rewriter.test.ts`.

Add coverage for:

- `iframe[src]`, `source[src]`, `track[src]`.
- `modulepreload`, `preload`, and `prefetch` links.
- `meta refresh` rewriting.
- CSS `url(...)` rewriting.
- Multiple-value `srcset` rewriting.
- Same-upstream and cross-origin `Location` handling.
- `Set-Cookie` domain/path rewriting.
- URL redaction in logs.
- Relative WebSocket URL handling with `new URL(input, location.href)`.
- Service worker blocking shim behavior.

Add renderer unit tests for:

- `resolveProxiedSrc` non-OK registration failures.
- `resolveProxiedSrc` success result shape.
- `unproxyUrl` query/hash preservation.
- Unknown proxy names staying safe.
- Legacy `/proxy/...` normalization behavior.

### Integration Tests

Add a Fastify proxy integration harness with a synthetic upstream server.

Coverage:

- GET with query strings.
- POST/PUT/PATCH/DELETE body forwarding.
- Header normalization.
- CSP/XFO stripping.
- HTML and CSS rewriting.
- Same-upstream redirects.
- Cross-origin redirect behavior.
- Cookie set and replay.
- SSE streaming.
- Large binary streaming without buffering entire response.
- WebSocket echo, including binary frames.
- Forbidden, invalid, and denied `/proxy/_register` calls.
- Session-scoped proxy name isolation.

### Browser E2E Tests

Add a dedicated server-mode spec:

- `tests/e2e/specs/proxy-browser.spec.ts`

Use a synthetic upstream torture page with controls for:

- normal links
- absolute same-upstream links
- root-relative links
- `target=_blank`
- `window.open`
- forms
- `fetch('/api/data')`
- `XMLHttpRequest('/api/data')`
- `EventSource('/events')`
- `new WebSocket('/ws')`
- cookies
- redirects
- SPA `pushState` and `replaceState`
- file upload input where supported
- download response where supported

Assertions:

- iframe `src` uses `/proxy/...`.
- omnibox/history/app-control state uses canonical URLs.
- page content updates as expected.
- unsupported operations show fallback or documented failure.

### Security E2E Tests

Add hostile-page tests for browser/server mode.

Assertions:

- Proxied page cannot read parent DOM.
- Proxied page cannot read launcher localStorage/sessionStorage used by the app.
- Proxied page cannot call `/api/*` launcher endpoints.
- Proxied page cannot open `/ws` launcher WebSocket.
- Proxied page cannot call `/proxy/_register`.
- Proxied page cannot access unrelated proxy names.
- Proxied page cannot register a service worker under launcher origin.
- Two sessions/tabs cannot share proxy registrations or cookies unless explicitly expected.

### Regression Tests

Add PR badge regression coverage.

Coverage:

- Click a PR badge in a code deck column.
- Browser tab state stores canonical GitHub PR URL.
- Iframe transport uses `/proxy/...` internally.
- Omnibox/history never show `/proxy/...`.
- Failed proxy registration shows the fallback panel with the canonical GitHub URL.

## Acceptance Criteria

- Browser/server proxy has a documented capability and security contract.
- Proxy registrations are scoped, server-minted, validated, and expiring.
- Browser state and app-control state use canonical URLs.
- `/proxy/...` is confined to iframe transport and debug details.
- PR badge navigation no longer leaks proxy URLs.
- Common same-upstream operations work in unit, integration, and e2e tests.
- Hostile-page tests prove proxied pages cannot access launcher APIs/storage or register new proxies.
- Unsupported features fail with clear user-facing fallback.
- Electron behavior remains unchanged.

## Rollout Strategy

- Land Phase 0 and Phase 1 first to fix user-visible URL leakage without broadening proxy power.
- Land Phase 2 before cookie, redirect, and runtime compatibility changes.
- Land Phase 3 and Phase 4 with integration tests and security tests in place.
- Land Phase 5 behind a feature flag or allowlist.
- Land Phase 6 fallback UX before enabling expanded proxy behavior broadly.

## Assumptions

- Browser/server mode remains iframe/proxy-based for this overhaul.
- The proxy is intended to support a safe useful subset, not full Electron parity.
- Browser/server profile isolation must be either implemented or explicitly documented as unsupported.
- The implementation should prioritize local/sandbox/app surfaces and GitHub PR/documentation workflows before arbitrary external sites.
- Runtime shims are considered higher risk and should only be expanded after scoping and isolation are proven by tests.
