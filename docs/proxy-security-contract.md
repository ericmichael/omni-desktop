# Browser/Server Proxy Security Contract

This contract covers the browser/server-mode iframe proxy served from `/proxy`. It is the Phase 0 safety baseline for the browser/server proxy overhaul and should be updated before any compatibility shim expands proxy power.

## Supported Page Classes

- Localhost and sandbox surfaces launched by Omni, including chat UI, code-server, noVNC, notebooks, dashboards, and other app panes that are expected to run behind the launcher proxy.
- Static same-upstream HTML assets whose URLs appear in supported attributes such as `href`, `src`, `action`, `formaction`, `poster`, `data`, and `srcset`.
- Server-minted dynamic registration for browser/server surfaces where the caller is already allowed by the same network policy used for `/api/ws-token`.
- Basic GitHub documentation and PR reading flows as a target outcome of the overhaul, once later phases separate canonical browser state from proxy transport state.

## Best-Effort Page Classes

- Complex public SPAs that rely on runtime URL construction, aggressive CSP/COOP/COEP, cross-origin widgets, or anti-embedding behavior.
- OAuth and other redirect-heavy workflows until redirect handling and fallback UI are explicitly implemented.
- Downloads, uploads, and cookies until later phases add scoped tests and behavior. EventSource, WebSocket, Workers, and same-upstream runtime fetch/XHR are supported only where Phase 5 runtime policy enables expanded shims.

## Unsupported Or Fallback Page Classes

- WebAuthn/passkeys, DRM/protected media, browser extension APIs, camera/microphone permissions in arbitrary proxied pages, and anti-bot/high-security flows.
- Service worker registration by arbitrary proxied pages unless a future trusted-site allowlist explicitly permits it.
- Cross-tab cookie/storage isolation for browser/server profiles. Dynamic proxy names are now opaque and expiring, but full browser profile isolation remains unsupported.

## Security Invariants

- `/proxy/_register` must be denied for callers outside the trusted network unless the operator explicitly sets `OMNI_ALLOW_EXTERNAL_REGISTER=1`.
- Dynamic proxy registration is server-minted, expiring, owner-checked when EasyAuth identity is present, and restricted to `http:` and `https:` upstreams.
- Proxied pages must not be able to call launcher APIs such as `/api/*`, `/ws`, `/proxy/_register`, or unrelated `/proxy` names as launcher-origin capabilities.
- Proxied pages must not access parent DOM, launcher localStorage/sessionStorage, IPC bridges, or app state.
- Static root-relative links and forms in proxied HTML should stay under that page's proxy prefix instead of targeting launcher-origin routes directly.
- Sensitive query strings and tokens must not be logged or surfaced in diagnostics without redaction.

## Phase 0 Executable Baseline

The Phase 0 Vitest coverage in `src/server/proxy-rewriter.test.ts` establishes the current safety foundation without changing runtime proxy behavior:

- `/proxy/_register` rejects untrusted callers.
- `/proxy/_register` accepts trusted HTTP registrations and preserves the initial path/query in the returned proxy path.
- `OMNI_ALLOW_EXTERNAL_REGISTER=1` remains a current operator escape hatch.
- Static hostile-page links to launcher-looking paths are rewritten under the active proxy prefix where the current attribute rewriter supports them.
- Inline hostile scripts are not rewritten by static HTML rewriting, documenting the current launcher API and service-worker exposure gap.

## Phase 2 Baseline

- `/proxy/_register` ignores renderer-supplied names and returns the actual opaque `proxyName` and `proxyPath` minted by the server.
- Dynamic registrations carry owner metadata. In EasyAuth mode, proxy access requires the same authenticated principal header that created the registration.
- In non-EasyAuth server mode, every request belongs to the local single tenant. Dynamic proxy names are unguessable expiring capabilities, but there is no stronger per-browser-session HTTP identity available yet.
- Internal status rewrites from `rewriteStatusUrls` / `registerAndRewrite` remain trusted, process-local registrations with stable names so existing chat/code-server/noVNC surfaces keep working.
- Expired dynamic registrations are removed deterministically by the proxy cleanup path during registration/access and by the exported cleanup helper used in tests.

## Phase 5 Baseline

- Proxied HTML receives a versioned runtime shim that always reports navigation/title messages using canonical upstream URLs.
- Expanded runtime URL rewriting defaults on for trusted-internal entries and off for dynamic entries unless an operator explicitly sets `OMNI_PROXY_DYNAMIC_RUNTIME_SHIMS=1`.
- Setting `OMNI_PROXY_RUNTIME_SHIMS=0` disables expanded runtime URL rewriting quickly while leaving the canonical reporting and service-worker guard in place.
- Runtime rewriting keeps same-upstream and launcher-origin root-relative requests under the active proxy prefix, including `/api/*`, `/ws`, `/proxy/_register`, and unrelated `/proxy/...` paths.
- Service worker registration is blocked for dynamic proxied pages. Trusted-internal entries do not receive that block by default.

## Current Known Gaps

- Dynamic registrations are not yet scoped to a specific browser tab/tabset; EasyAuth scopes to principal, while single-tenant mode relies on unguessable expiring names.
- The proxy still relies on trusted-network gating plus minted capabilities rather than a dedicated CSRF token for `/proxy/_register`.
- Static links or forms that already point at `/proxy/...`, including `/proxy/_register`, are not double-proxied by the static rewriter; Phase 5 runtime shims cover user/runtime flows when expanded rewriting is enabled.
- Proxied HTML can still run scripts in the launcher origin iframe sandbox configuration, so Phase 5 relies on the injected runtime guard for supported fetch/XHR/EventSource/WebSocket/Worker/service-worker APIs rather than full origin isolation.
- Console capture posts arbitrary proxied-page console output to the parent by default; later phases should scope or disable it for untrusted pages.
- Cookie and storage isolation for browser/server profiles is not implemented as a supported feature.

## Phase 1 Handoff

- Keep `/proxy/...` as iframe transport only; browser tab state, history, omnibox, and app-control state should use canonical upstream URLs.
- Check `/proxy/_register` responses before caching or navigating to proxy paths, and surface a clear fallback for non-OK registration.
- Do not broaden runtime fetch/XHR/WebSocket/Worker shims until Phase 2 session-scoped capabilities and hostile-page tests are in place.
