/**
 * The one source of truth for "are surfaces glass right now?" (UI/UX gameplan
 * Phase 10). Glass is a property of the active THEME — never of the wallpaper:
 * `material: 'glass'` themes render translucent surfaces over a backdrop
 * (built-in gradient, or the user's wallpaper as an optional override).
 *
 * `prefers-reduced-transparency` wins over everything: the app falls back to
 * the theme's opaque base neutrals, no backdrop, no blur.
 */
import { atom, type ReadableAtom } from 'nanostores';

import { persistedStoreApi } from '@/renderer/services/store';

import { isGlassTheme } from './fluent-themes';

const REDUCED_TRANSPARENCY_MQ = '(prefers-reduced-transparency: reduce)';

// jsdom has no matchMedia — treat that as "no reduction requested".
const supportsMatchMedia = typeof window !== 'undefined' && typeof window.matchMedia === 'function';

const prefersReducedTransparency = (): boolean =>
  supportsMatchMedia && window.matchMedia(REDUCED_TRANSPARENCY_MQ).matches;

const compute = (): boolean => isGlassTheme(persistedStoreApi.get().theme ?? 'omni') && !prefersReducedTransparency();

const $glass = atom<boolean>(compute());

persistedStoreApi.$atom.listen(() => {
  $glass.set(compute());
});

if (supportsMatchMedia) {
  window.matchMedia(REDUCED_TRANSPARENCY_MQ).addEventListener('change', () => {
    $glass.set(compute());
  });
}

export const $glassEnabled: ReadableAtom<boolean> = $glass;
