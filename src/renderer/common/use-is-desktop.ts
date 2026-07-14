import { useSyncExternalStore } from 'react';

/** The app-wide desktop breakpoint (matches SM_BREAKPOINT = 640px). */
const DESKTOP_MQ = '(min-width: 640px)';

const subscribe = (cb: () => void) => {
  const mql = window.matchMedia(DESKTOP_MQ);
  mql.addEventListener('change', cb);
  return () => mql.removeEventListener('change', cb);
};
const getSnapshot = () => window.matchMedia(DESKTOP_MQ).matches;
const getServerSnapshot = () => true;

/**
 * True at or above the 640px desktop breakpoint, reactive to resizes.
 * Rail tabs use this to switch between master-detail (desktop) and
 * full-screen swap (mobile) layouts.
 */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
