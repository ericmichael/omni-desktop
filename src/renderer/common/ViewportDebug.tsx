import { useStore } from '@nanostores/react';
import { atom } from 'nanostores';
import { memo, useEffect, useState } from 'react';

/**
 * On-device viewport diagnostic (toggled from the command palette). iOS
 * standalone viewport geometry can only be debugged with live numbers from
 * the device — this readout shows the layout/visual/viewport-unit heights,
 * env() insets, the app-height/safe-area overrides, and where the shell and
 * sidebar actually end. Recreation of the June 2026 readout that pinned
 * down the short-ICB standalone state.
 */
export const $viewportDebug = atom(false);

type Metrics = [string, string][];

const probePx = (cssHeight: string): number => {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;top:0;left:0;width:0;visibility:hidden;pointer-events:none;' + `height:${cssHeight}`;
  document.body.appendChild(el);
  const height = el.offsetHeight;
  el.remove();
  return height;
};

const rectBottom = (el: Element | null): string =>
  el ? `${Math.round(el.getBoundingClientRect().bottom)}` : '—';

const isStandalone = (): boolean =>
  (navigator as { standalone?: boolean }).standalone === true ||
  window.matchMedia('(display-mode: standalone)').matches;

const collect = (): Metrics => {
  const root = document.documentElement;
  const vv = window.visualViewport;
  const shell = document.querySelector('.app-shell');
  const sidebar =
    document.querySelector('[data-slot="sidebar-container"]') ??
    document.querySelector('[data-mobile="true"][data-slot="sidebar"]');
  const sidebarInner = sidebar?.querySelector('[data-sidebar="sidebar"]') ?? sidebar;
  return [
    ['inner w×h', `${window.innerWidth}×${window.innerHeight}`],
    ['icb', `${root.clientHeight}`],
    ['vv h@top', vv ? `${Math.round(vv.height)}@${Math.round(vv.offsetTop)}` : '—'],
    ['screen', `${window.screen.width}×${window.screen.height}`],
    ['vh/dvh/svh', `${probePx('100vh')}/${probePx('100dvh')}/${probePx('100svh')}`],
    ['env t/b', `${probePx('env(safe-area-inset-top, 0px)')}/${probePx('env(safe-area-inset-bottom, 0px)')}`],
    ['--app-height', root.style.getPropertyValue('--app-height') || 'unset'],
    ['--safe-area-bottom', root.style.getPropertyValue('--safe-area-bottom') || 'unset'],
    ['backstop attr', root.dataset.sidebarBackstop ?? 'unset'],
    ['shell bottom', rectBottom(shell)],
    ['sidebar bottom', rectBottom(sidebar)],
    ['sidebar height', sidebar ? getComputedStyle(sidebar).height : '—'],
    ['sidebar bg bottom', rectBottom(sidebarInner)],
    ['scrollY/max', `${Math.round(window.scrollY)}/${Math.round((document.scrollingElement?.scrollHeight ?? 0) - window.innerHeight)}`],
    ['standalone', isStandalone() ? 'yes' : 'no'],
  ];
};

export const ViewportDebug = memo(() => {
  const visible = useStore($viewportDebug);
  const [metrics, setMetrics] = useState<Metrics>([]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    const update = () => setMetrics(collect());
    update();
    const timer = setInterval(update, 500);
    const vv = window.visualViewport;
    vv?.addEventListener('resize', update);
    vv?.addEventListener('scroll', update);
    return () => {
      clearInterval(timer);
      vv?.removeEventListener('resize', update);
      vv?.removeEventListener('scroll', update);
    };
  }, [visible]);

  if (!visible) {
    return null;
  }
  return (
    <div
      className="fixed top-12 right-2 z-9999 w-56 rounded-lg border border-border bg-card/95 p-2 font-mono text-[10px] leading-4 text-foreground shadow-lg"
      role="status"
      aria-label="Viewport debug"
    >
      {metrics.map(([key, value]) => (
        <div key={key} className="flex justify-between gap-2">
          <span className="text-muted-foreground">{key}</span>
          <span className="text-right">{value}</span>
        </div>
      ))}
    </div>
  );
});
ViewportDebug.displayName = 'ViewportDebug';
