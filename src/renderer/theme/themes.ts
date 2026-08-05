import type { OmniTheme } from '@/shared/types';

/**
 * Theme selection deliberately contains no color values.
 *
 * shadcn themes are semantic CSS variables declared in tailwind.css. Selecting
 * a theme only chooses the relevant CSS cascade and light/dark mode; it does
 * not translate a product palette into shadcn tokens at runtime.
 */
const themeModes: Record<OmniTheme, 'light' | 'dark'> = {
  omni: 'dark',
  'teams-light': 'light',
  'teams-dark': 'dark',
  default: 'dark',
  'tokyo-night': 'dark',
  'vscode-dark': 'dark',
  'vscode-light': 'light',
  utrgv: 'light',
};

/** Supported "Text size" steps (percent). */
export const TEXT_SCALES = [90, 100, 110, 125] as const;
export type TextScale = (typeof TEXT_SCALES)[number];

/** Theme names are exported so the persisted-store schema can be kept safe. */
export const themeDefNames = Object.keys(themeModes) as OmniTheme[];

export function isThemeDark(theme: OmniTheme): boolean {
  return themeModes[theme] === 'dark';
}

/**
 * Apply a theme the same way shadcn's dark-mode guidance does: select a CSS
 * theme and toggle `.dark`. All semantic color values remain in CSS.
 */
export function applyTheme(theme: OmniTheme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle('dark', isThemeDark(theme));
}

/** Keep browser/PWA chrome aligned with the CSS-selected app surface. */
export function applyPwaTheme(theme: OmniTheme): void {
  const surfaceColor = getComputedStyle(document.documentElement).getPropertyValue('--background').trim();

  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = surfaceColor;
  }

  const statusBarMeta = document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-status-bar-style"]');
  if (statusBarMeta) {
    statusBarMeta.content = isThemeDark(theme) ? 'black-translucent' : 'default';
  }
}
