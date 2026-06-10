import { useEffect } from 'react';

/** Visual-viewport shortfalls below this are browser-chrome / safe-area
 *  noise (home indicator ≈ 34px, collapsed toolbars ≈ 50px); real on-screen
 *  keyboards are 150px+. Only a keyboard should shrink the shell. */
const KEYBOARD_MIN_PX = 100;

export function isStandaloneDisplayMode(): boolean {
  return (
    (navigator as { standalone?: boolean }).standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches
  );
}

/** iOS standalone (installed PWA) cold start leaves env(safe-area-inset-*)
 *  and viewport units uninitialized until the viewport is "exercised" by a
 *  geometry change. Toggling viewport-fit off and back on forces WebKit to
 *  recompute them at launch. No-op outside standalone mode. */
function kickStandaloneViewport(): void {
  if (!isStandaloneDisplayMode()) {
    return;
  }
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  const original = meta?.getAttribute('content');
  if (!meta || !original?.includes('viewport-fit=cover')) {
    return;
  }
  meta.setAttribute('content', original.replace('viewport-fit=cover', 'viewport-fit=auto'));
  requestAnimationFrame(() => {
    meta.setAttribute('content', original);
  });
}

/** Measures env(safe-area-inset-top) in px via a hidden probe (there is no
 *  direct JS API for env()). */
function measureEnvTop(): number {
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;top:0;left:0;width:0;visibility:hidden;pointer-events:none;' +
    'height:env(safe-area-inset-top, 0px)';
  document.body.appendChild(probe);
  const envTop = probe.offsetHeight;
  probe.remove();
  return envTop;
}

/** iOS standalone bug: the page is laid out short by exactly the status bar
 *  while the window still paints full-bleed (measured on-device: layout
 *  viewport 879 on a 926 screen, env top 47 live, content underlapping the
 *  status bar, page not scrollable). Detected by the signature: layout
 *  viewport === screen height − env(top), with env(top) > 0 (a window that
 *  genuinely starts below the status bar reports env(top) 0, so this can't
 *  false-positive; iOS screen.height stays portrait-major in landscape, so
 *  the signature never matches there either).
 *
 *  Crucially, element painting is CLIPPED at the short layout viewport even
 *  though the window canvas paints full-bleed (verified on-device: a shell
 *  extended to 926 had its bottom nav labels sliced at exactly 879, while
 *  the html background painted to 926). So the zone below the layout
 *  viewport can never hold content — only the backstop color. The shell
 *  must stay at 100dvh; the response to this state is instead to zero
 *  --safe-area-bottom: the home indicator sits entirely inside the
 *  unpaintable band, so the nav-colored backstop band IS the safe-area
 *  clearance and bottom-most surfaces must not pad for it again. */
function isViewportShortOfFullBleed(layoutHeight: number): boolean {
  if (!isStandaloneDisplayMode()) {
    return false;
  }
  const envTop = measureEnvTop();
  if (envTop <= 0) {
    return false;
  }
  return Math.abs(window.screen.height - envTop - layoutHeight) <= 1;
}

/**
 * Keeps `--app-height` (the app shell's height) equal to the space actually
 * available to the app.
 *
 * The var is set ONLY while an on-screen keyboard overlays the page (iOS
 * Safari never resizes the layout viewport for the keyboard — it overlays
 * and force-scrolls, which with an `overflow: hidden` shell leaves the app
 * shifted with fixed elements floating mid-screen). At rest the var is
 * absent and the shell's CSS fallback (100dvh) applies. Android resizes
 * the layout viewport itself via `interactive-widget=resizes-content`, so
 * the override never fires there.
 *
 * Separately, in the iOS-standalone short-viewport state this sets
 * `--safe-area-bottom: 0px` (see isViewportShortOfFullBleed) — bottom-most
 * surfaces read `var(--safe-area-bottom, env(safe-area-inset-bottom, 0px))`
 * so their home-indicator padding collapses when the backstop band below
 * the viewport already provides the clearance.
 *
 * iOS standalone (installed PWA) cold-start geometry is unstable: the
 * layout viewport can come up short by the status bar (measured on-device:
 * innerHeight = clientHeight = vv.height = 100dvh = 879 on a 926 screen,
 * 100vh = 926, env insets 47/34). A previous fix read the 879 values as
 * "lies" and sized the shell to 100vh in standalone — that clipped the
 * bottom tab bar whenever the visible viewport really was 879 (element
 * rects are layout-viewport coordinates, so a rect bottom of 926 does NOT
 * prove pixel 926 is on screen). Always size to the layout viewport: when
 * it's short, the shell fails SHORT — a band below the nav, absorbed by the
 * nav-colored --safe-area-background backstop until kickStandaloneViewport
 * or rotation settles the viewport — instead of clipping the nav behind an
 * overflow:hidden shell. The keyboard branch is safe because it only
 * compares two same-basis measurements against each other.
 */
export function useAppHeight(): void {
  useEffect(() => {
    kickStandaloneViewport();

    const vv = window.visualViewport;
    const root = document.documentElement;

    const update = () => {
      // Pinch-zoom also shrinks the visual viewport — don't touch the layout
      // while zoomed.
      if (vv && vv.scale > 1.01) {
        return;
      }
      // For the root element, clientHeight is the layout viewport height.
      const layoutHeight = root.clientHeight;
      const visualHeight = vv ? vv.height : layoutHeight;
      const keyboardOpen = layoutHeight - visualHeight > KEYBOARD_MIN_PX;

      if (keyboardOpen) {
        root.style.setProperty('--app-height', `${Math.round(visualHeight)}px`);
      } else {
        root.style.removeProperty('--app-height');
      }
      if (isViewportShortOfFullBleed(layoutHeight)) {
        root.style.setProperty('--safe-area-bottom', '0px');
      } else {
        root.style.removeProperty('--safe-area-bottom');
      }
      // Undo Safari's compensating scroll of the layout viewport so the
      // shell stays pinned to the top of the screen.
      if (window.scrollY !== 0) {
        window.scrollTo(0, 0);
      }
    };

    // iOS settles viewport geometry late after rotation — re-measure after a
    // beat, matching the standard standalone-PWA workaround.
    const updateSettled = () => {
      update();
      setTimeout(update, 300);
    };

    update();
    // Cold-start values can be stale until first paint settles.
    const settleTimer = setTimeout(update, 500);
    vv?.addEventListener('resize', update);
    vv?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', updateSettled);
    return () => {
      clearTimeout(settleTimer);
      vv?.removeEventListener('resize', update);
      vv?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', updateSettled);
      root.style.removeProperty('--app-height');
      root.style.removeProperty('--safe-area-bottom');
    };
  }, []);
}
