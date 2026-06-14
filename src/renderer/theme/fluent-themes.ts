import type { BrandVariants, Theme } from '@fluentui/react-components';
import { createDarkTheme, createLightTheme } from '@fluentui/react-components';

import type { OmniTheme } from '@/shared/types';

// ── Brand palettes ──────────────────────────────────────────────────────────

/**
 * Omni – azure ramp anchored on the aura/voice glow cyan (#5ac8fa at 100).
 * The signature "living glow" visuals (ColumnAura, VoiceGlow) already speak
 * this color; the omni theme makes it the accent so they're one voice.
 */
const omniBrand: BrandVariants = {
  10: '#04141c',
  20: '#082636',
  30: '#0b3a52',
  40: '#0d4e6e',
  50: '#0f628b',
  60: '#1076a8',
  70: '#118ac5',
  80: '#2b9fd9',
  90: '#45b4e9',
  100: '#5ac8fa',
  110: '#7dd3fb',
  120: '#9eddfc',
  130: '#bce7fd',
  140: '#d6f0fe',
  150: '#e9f7fe',
  160: '#f4fbff',
};

/** Microsoft Teams / M365 – official brand ramp based on #0078d4 */
const teamsBrand: BrandVariants = {
  10: '#001b3d',
  20: '#002e5e',
  30: '#003e7a',
  40: '#004e96',
  50: '#005eb2',
  60: '#006ecf',
  70: '#0078d4',
  80: '#1a8cde',
  90: '#3a9fe8',
  100: '#5bb2f2',
  110: '#7bc4fc',
  120: '#96d3ff',
  130: '#b4e1ff',
  140: '#d0eeff',
  150: '#e8f6ff',
  160: '#f5fbff',
};

/** Default – indigo/zinc dark */
const defaultBrand: BrandVariants = {
  10: '#050418',
  20: '#12102e',
  30: '#1b1649',
  40: '#221c5f',
  50: '#282275',
  60: '#312e81',
  70: '#3730a3',
  80: '#4338ca',
  90: '#4f46e5',
  100: '#6366f1',
  110: '#818cf8',
  120: '#a5b4fc',
  130: '#c7d2fe',
  140: '#e0e7ff',
  150: '#eef2ff',
  160: '#f5f7ff',
};

/** Tokyo Night – deep blue-purple */
const tokyoNightBrand: BrandVariants = {
  10: '#080a14',
  20: '#111b30',
  30: '#1a2747',
  40: '#22335d',
  50: '#2b4074',
  60: '#344d8a',
  70: '#3d59a1',
  80: '#4a6ab5',
  90: '#5d80e0',
  100: '#7a9bf0',
  110: '#9db2ef',
  120: '#b5c5f3',
  130: '#c5d0f5',
  140: '#d9e0f8',
  150: '#e8edfb',
  160: '#f2f4fd',
};

/** VS Code Dark – blue */
const vscodeDarkBrand: BrandVariants = {
  10: '#001024',
  20: '#001e3a',
  30: '#003058',
  40: '#004277',
  50: '#005496',
  60: '#0066b5',
  70: '#0078d4',
  80: '#1a8cff',
  90: '#4da6ff',
  100: '#80bfff',
  110: '#99ccff',
  120: '#b3d9ff',
  130: '#cce5ff',
  140: '#e0f0ff',
  150: '#ebf5ff',
  160: '#f5faff',
};

/** VS Code Light – blue (same brand, light theme) */
const vscodeLightBrand: BrandVariants = {
  10: '#001024',
  20: '#001e38',
  30: '#002b52',
  40: '#00386b',
  50: '#004585',
  60: '#00529e',
  70: '#005fb8',
  80: '#1a8cff',
  90: '#4da6ff',
  100: '#80bfff',
  110: '#99ccff',
  120: '#b3d9ff',
  130: '#cce5ff',
  140: '#e0f0ff',
  150: '#ebf5ff',
  160: '#f5faff',
};

/** UTRGV – orange/red institutional */
const utrgvBrand: BrandVariants = {
  10: '#1f0805',
  20: '#3d120a',
  30: '#5a1a0e',
  40: '#6e2413',
  50: '#8c2c15',
  60: '#b03617',
  70: '#d4431b',
  80: '#f05023',
  90: '#f47a4a',
  100: '#f9a080',
  110: '#fbb89a',
  120: '#fcc5b5',
  130: '#fde3dc',
  140: '#fef3f0',
  150: '#fef8f6',
  160: '#fffcfb',
};

// ── Theme definition type ────────────────────────────────────────────────────

/** Terminal (xterm) palette for a theme. */
interface XtermColors {
  fg: string;
  black: string;
  brightBlack: string;
  white: string;
  brightWhite: string;
  cursor: string;
  cursorAccent: string;
  blue: string;
  brightBlue: string;
  cyan: string;
  brightCyan: string;
  green: string;
  brightGreen: string;
  yellow: string;
  brightYellow: string;
  red: string;
  brightRed: string;
  magenta: string;
  brightMagenta: string;
}

/** Compact theme definition — the single source of truth for each theme. */
interface ThemeDef {
  brand: BrandVariants;
  mode: 'light' | 'dark';
  /**
   * Surface material. Glass themes render translucent surfaces (glass-vars)
   * over a backdrop; the `overrides` neutrals double as the opaque base and
   * the flat fallback under `prefers-reduced-transparency`. Defaults to flat.
   */
  material?: 'flat' | 'glass';
  /** Built-in backdrop for glass themes — any CSS `background` value. */
  backdrop?: string;
  /** Glass tone when rendering over the built-in backdrop (user wallpapers
   *  carry their own luminance-detected tone in the store). */
  builtinGlassTone?: 'dark' | 'light';
  /** Fluent token overrides applied after createLightTheme/createDarkTheme. */
  overrides: Partial<Theme>;
  /** Terminal color palette. */
  xterm: XtermColors;
  /** Optional header bar overrides (defaults to surface/fg/stroke). */
  header?: { bg: string; fg: string; border: string };
  /** Scrollbar colors. */
  scrollbar: { thumb: string; thumbHover: string };
  /** Selection/focus ring accent. */
  selectionColor: string;
  focusRingColor: string;
}

// ── Theme definitions ────────────────────────────────────────────────────────

const themeDefs: Record<OmniTheme, ThemeDef> = {
  omni: {
    brand: omniBrand,
    mode: 'dark',
    material: 'glass',
    builtinGlassTone: 'dark',
    // The "quiet glass" backdrop: deep neutral base, one azure bloom top-right,
    // a faint indigo counter-bloom bottom-left. Static gradients — no asset,
    // no decode cost, cheap to blur over.
    backdrop: [
      'radial-gradient(1200px 800px at 80% -10%, rgba(90, 200, 250, 0.16), transparent 60%)',
      'radial-gradient(1000px 700px at -10% 110%, rgba(94, 92, 230, 0.12), transparent 55%)',
      'linear-gradient(160deg, #0b1016 0%, #0d1117 45%, #0a0c10 100%)',
    ].join(', '),
    overrides: {
      colorNeutralBackground1: '#09090b',
      colorNeutralBackground2: '#18181b',
      colorNeutralBackground3: '#27272a',
      colorNeutralBackground4: '#111113',
      colorNeutralBackground4Hover: '#1e1e21',
      colorNeutralBackground4Pressed: '#18181b',
      colorNeutralStroke1: '#3f3f46',
      colorNeutralForeground1: '#fafafa',
      colorNeutralForeground2: '#a1a1aa',
      colorNeutralForeground3: '#71717a',
      colorPaletteRedForeground1: '#f87171',
      colorPaletteGreenForeground1: '#4ade80',
      colorPaletteYellowForeground1: '#fbbf24',
      colorSubtleBackground: 'transparent',
      colorSubtleBackgroundHover: '#1a1a1f',
      colorSubtleBackgroundPressed: '#151518',
      colorSubtleBackgroundSelected: '#1f1f24',
      colorNeutralForeground4: '#52525b',
      colorNeutralStrokeAccessible: '#63636b',
      colorNeutralStrokeAccessibleHover: '#71717a',
      colorNeutralStrokeAccessiblePressed: '#6a6a73',
      colorNeutralForegroundDisabled: '#52525b',
      colorNeutralBackgroundDisabled: '#18181b',
      colorNeutralStrokeDisabled: '#27272a',
      fontFamilyBase: "'Inter Variable', ui-sans-serif, system-ui, sans-serif",
      fontFamilyMonospace: 'JetBrainsMonoNerdFont, ui-monospace, monospace',
    },
    xterm: {
      fg: '#fafafa',
      black: '#fafafa',
      brightBlack: '#fafafa',
      white: '#09090b',
      brightWhite: '#09090b',
      cursor: '#5ac8fa',
      cursorAccent: '#09090b',
      blue: '#45b4e9',
      brightBlue: '#7dd3fb',
      cyan: '#2dd4bf',
      brightCyan: '#2dd4bf',
      green: '#4ade80',
      brightGreen: '#4ade80',
      yellow: '#facc15',
      brightYellow: '#facc15',
      red: '#f87171',
      brightRed: '#f87171',
      magenta: '#c084fc',
      brightMagenta: '#c084fc',
    },
    scrollbar: { thumb: '#3f3f46', thumbHover: '#52525b' },
    selectionColor: 'rgb(90 200 250 / 0.25)',
    focusRingColor: 'rgb(90 200 250 / 0.5)',
  },

  'teams-light': {
    brand: teamsBrand,
    mode: 'light',
    overrides: {
      colorNeutralBackground1: '#ffffff',
      colorNeutralBackground1Hover: '#f5f5f5',
      colorNeutralBackground1Pressed: '#ebebeb',
      colorNeutralBackground1Selected: '#ebebeb',
      colorNeutralBackground2: '#fafafa',
      colorNeutralBackground3: '#f5f5f5',
      colorNeutralBackground4: '#f5f5f5',
      colorNeutralBackground4Hover: '#ebebeb',
      colorNeutralBackground4Pressed: '#e0e0e0',
      colorNeutralStroke1: '#d1d1d1',
      colorNeutralForeground1: '#242424',
      colorNeutralForeground2: '#424242',
      colorNeutralForeground3: '#616161',
      colorSubtleBackground: 'transparent',
      colorSubtleBackgroundHover: '#f0f0f0',
      colorSubtleBackgroundPressed: '#e0e0e0',
      colorSubtleBackgroundSelected: '#e5e5e5',
      colorPaletteRedForeground1: '#c4314b',
      colorPaletteGreenForeground1: '#0e7a0d',
      colorPaletteYellowForeground1: '#8a7400',
      fontFamilyBase: "'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
      fontFamilyMonospace: "'Cascadia Code', 'Consolas', ui-monospace, monospace",
    },
    xterm: {
      fg: '#242424',
      black: '#242424',
      brightBlack: '#424242',
      white: '#ffffff',
      brightWhite: '#fafafa',
      cursor: '#0078d4',
      cursorAccent: '#ffffff',
      blue: '#0078d4',
      brightBlue: '#1a8cde',
      cyan: '#038387',
      brightCyan: '#038387',
      green: '#0e7a0d',
      brightGreen: '#0e7a0d',
      yellow: '#8a7400',
      brightYellow: '#8a7400',
      red: '#c4314b',
      brightRed: '#c4314b',
      magenta: '#881798',
      brightMagenta: '#881798',
    },
    scrollbar: { thumb: '#d1d1d1', thumbHover: '#a8a8a8' },
    selectionColor: 'rgb(0 120 212 / 0.2)',
    focusRingColor: 'rgb(0 120 212 / 0.5)',
  },

  'teams-dark': {
    brand: teamsBrand,
    mode: 'dark',
    overrides: {
      colorNeutralBackground1: '#1f1f1f',
      colorNeutralBackground1Hover: '#383838',
      colorNeutralBackground1Pressed: '#2e2e2e',
      colorNeutralBackground1Selected: '#404040',
      colorNeutralBackground2: '#2b2b2b',
      colorNeutralBackground3: '#333333',
      colorNeutralBackground4: '#242424',
      colorNeutralBackground4Hover: '#2e2e2e',
      colorNeutralBackground4Pressed: '#282828',
      colorNeutralStroke1: '#404040',
      colorNeutralForeground1: '#e0e0e0',
      colorNeutralForeground2: '#c8c8c8',
      colorNeutralForeground3: '#9e9e9e',
      colorSubtleBackground: 'transparent',
      colorSubtleBackgroundHover: '#3a3a3a',
      colorSubtleBackgroundPressed: '#333333',
      colorSubtleBackgroundSelected: '#444444',
      colorNeutralForeground4: '#808080',
      colorNeutralStrokeAccessible: '#707070',
      colorNeutralStrokeAccessibleHover: '#808080',
      colorNeutralStrokeAccessiblePressed: '#787878',
      colorNeutralForegroundDisabled: '#5c5c5c',
      colorNeutralBackgroundDisabled: '#2b2b2b',
      colorNeutralStrokeDisabled: '#3a3a3a',
      colorPaletteRedForeground1: '#e74856',
      colorPaletteGreenForeground1: '#13a10e',
      colorPaletteYellowForeground1: '#fce100',
      fontFamilyBase: "'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
      fontFamilyMonospace: "'Cascadia Code', 'Consolas', ui-monospace, monospace",
    },
    xterm: {
      fg: '#e0e0e0',
      black: '#e0e0e0',
      brightBlack: '#c8c8c8',
      white: '#1f1f1f',
      brightWhite: '#2b2b2b',
      cursor: '#0078d4',
      cursorAccent: '#1f1f1f',
      blue: '#3a9fe8',
      brightBlue: '#5bb2f2',
      cyan: '#2dc7c4',
      brightCyan: '#2dc7c4',
      green: '#13a10e',
      brightGreen: '#13a10e',
      yellow: '#fce100',
      brightYellow: '#fce100',
      red: '#e74856',
      brightRed: '#e74856',
      magenta: '#b4009e',
      brightMagenta: '#b4009e',
    },
    scrollbar: { thumb: '#404040', thumbHover: '#555555' },
    selectionColor: 'rgb(0 120 212 / 0.3)',
    focusRingColor: 'rgb(0 120 212 / 0.5)',
  },

  default: {
    brand: defaultBrand,
    mode: 'dark',
    overrides: {
      colorNeutralBackground1: '#09090b',
      colorNeutralBackground2: '#18181b',
      colorNeutralBackground3: '#27272a',
      colorNeutralBackground4: '#111113',
      colorNeutralBackground4Hover: '#1e1e21',
      colorNeutralBackground4Pressed: '#18181b',
      colorNeutralStroke1: '#3f3f46',
      colorNeutralForeground1: '#fafafa',
      colorNeutralForeground2: '#a1a1aa',
      colorNeutralForeground3: '#71717a',
      colorPaletteRedForeground1: '#f87171',
      colorPaletteGreenForeground1: '#4ade80',
      colorPaletteYellowForeground1: '#fbbf24',
      colorSubtleBackground: 'transparent',
      colorSubtleBackgroundHover: '#1a1a1f',
      colorSubtleBackgroundPressed: '#151518',
      colorSubtleBackgroundSelected: '#1f1f24',
      colorNeutralForeground4: '#52525b',
      colorNeutralStrokeAccessible: '#63636b',
      colorNeutralStrokeAccessibleHover: '#71717a',
      colorNeutralStrokeAccessiblePressed: '#6a6a73',
      colorNeutralForegroundDisabled: '#52525b',
      colorNeutralBackgroundDisabled: '#18181b',
      colorNeutralStrokeDisabled: '#27272a',
      fontFamilyBase: "'Inter Variable', ui-sans-serif, system-ui, sans-serif",
      fontFamilyMonospace: 'JetBrainsMonoNerdFont, ui-monospace, monospace',
    },
    xterm: {
      fg: '#fafafa',
      black: '#fafafa',
      brightBlack: '#fafafa',
      white: '#09090b',
      brightWhite: '#09090b',
      cursor: '#fafafa',
      cursorAccent: '#09090b',
      blue: '#818cf8',
      brightBlue: '#818cf8',
      cyan: '#2dd4bf',
      brightCyan: '#2dd4bf',
      green: '#4ade80',
      brightGreen: '#4ade80',
      yellow: '#facc15',
      brightYellow: '#facc15',
      red: '#f87171',
      brightRed: '#f87171',
      magenta: '#c084fc',
      brightMagenta: '#c084fc',
    },
    scrollbar: { thumb: '#3f3f46', thumbHover: '#52525b' },
    selectionColor: 'rgb(99 102 241 / 0.3)',
    focusRingColor: 'rgb(99 102 241 / 0.5)',
  },

  'tokyo-night': {
    brand: tokyoNightBrand,
    mode: 'dark',
    overrides: {
      colorNeutralBackground1: '#1a1b26',
      colorNeutralBackground2: '#1c1d29',
      colorNeutralBackground3: '#292e42',
      colorNeutralBackground4: '#161722',
      colorNeutralBackground4Hover: '#222336',
      colorNeutralBackground4Pressed: '#1c1d29',
      colorNeutralStroke1: '#3b4261',
      colorNeutralForeground1: '#c0caf5',
      colorNeutralForeground2: '#a9b1d6',
      colorNeutralForeground3: '#545c7e',
      colorPaletteRedForeground1: '#f7768e',
      colorPaletteGreenForeground1: '#9ece6a',
      colorPaletteYellowForeground1: '#e0af68',
      colorSubtleBackground: 'transparent',
      colorSubtleBackgroundHover: '#222336',
      colorSubtleBackgroundPressed: '#1e1f30',
      colorSubtleBackgroundSelected: '#262840',
      colorNeutralForeground4: '#444b6a',
      colorNeutralStrokeAccessible: '#5a6190',
      colorNeutralStrokeAccessibleHover: '#6b73a0',
      colorNeutralStrokeAccessiblePressed: '#636a98',
      colorNeutralForegroundDisabled: '#545c7e',
      colorNeutralBackgroundDisabled: '#1c1d29',
      colorNeutralStrokeDisabled: '#292e42',
      fontFamilyBase: "'Inter Variable', ui-sans-serif, system-ui, sans-serif",
      fontFamilyMonospace: 'JetBrainsMonoNerdFont, ui-monospace, monospace',
    },
    xterm: {
      fg: '#c0caf5',
      black: '#c0caf5',
      brightBlack: '#c0caf5',
      white: '#1a1b26',
      brightWhite: '#1a1b26',
      cursor: '#c0caf5',
      cursorAccent: '#1a1b26',
      blue: '#7aa2f7',
      brightBlue: '#7aa2f7',
      cyan: '#7dcfff',
      brightCyan: '#7dcfff',
      green: '#9ece6a',
      brightGreen: '#9ece6a',
      yellow: '#e0af68',
      brightYellow: '#e0af68',
      red: '#f7768e',
      brightRed: '#f7768e',
      magenta: '#bb9af7',
      brightMagenta: '#bb9af7',
    },
    scrollbar: { thumb: '#3b4261', thumbHover: '#545c7e' },
    selectionColor: 'rgb(61 89 161 / 0.3)',
    focusRingColor: 'rgb(61 89 161 / 0.5)',
  },

  'vscode-dark': {
    brand: vscodeDarkBrand,
    mode: 'dark',
    overrides: {
      colorNeutralBackground1: '#1f1f1f',
      colorNeutralBackground2: '#2b2b2b',
      colorNeutralBackground3: '#313131',
      colorNeutralBackground4: '#252525',
      colorNeutralBackground4Hover: '#2f2f2f',
      colorNeutralBackground4Pressed: '#2a2a2a',
      colorNeutralStroke1: '#3c3c3c',
      colorNeutralForeground1: '#cccccc',
      colorNeutralForeground2: '#bbbbbb',
      colorNeutralForeground3: '#9d9d9d',
      colorPaletteRedForeground1: '#f85149',
      colorPaletteGreenForeground1: '#0dbc79',
      colorPaletteYellowForeground1: '#cca700',
      colorSubtleBackground: 'transparent',
      colorSubtleBackgroundHover: '#2a2a2a',
      colorSubtleBackgroundPressed: '#262626',
      colorSubtleBackgroundSelected: '#2f2f2f',
      colorNeutralForeground4: '#6e6e6e',
      colorNeutralStrokeAccessible: '#707070',
      colorNeutralStrokeAccessibleHover: '#808080',
      colorNeutralStrokeAccessiblePressed: '#787878',
      colorNeutralForegroundDisabled: '#5c5c5c',
      colorNeutralBackgroundDisabled: '#2b2b2b',
      colorNeutralStrokeDisabled: '#3a3a3a',
      fontFamilyBase: "'Inter Variable', ui-sans-serif, system-ui, sans-serif",
      fontFamilyMonospace: 'JetBrainsMonoNerdFont, ui-monospace, monospace',
    },
    xterm: {
      fg: '#cccccc',
      black: '#cccccc',
      brightBlack: '#cccccc',
      white: '#1f1f1f',
      brightWhite: '#1f1f1f',
      cursor: '#cccccc',
      cursorAccent: '#1f1f1f',
      blue: '#569cd6',
      brightBlue: '#9cdcfe',
      cyan: '#4ec9b0',
      brightCyan: '#4ec9b0',
      green: '#0dbc79',
      brightGreen: '#0dbc79',
      yellow: '#cca700',
      brightYellow: '#cca700',
      red: '#f85149',
      brightRed: '#f85149',
      magenta: '#c586c0',
      brightMagenta: '#c586c0',
    },
    scrollbar: { thumb: '#3c3c3c', thumbHover: '#4f4f4f' },
    selectionColor: 'rgb(0 120 212 / 0.3)',
    focusRingColor: 'rgb(0 120 212 / 0.5)',
  },

  'vscode-light': {
    brand: vscodeLightBrand,
    mode: 'light',
    overrides: {
      colorNeutralBackground1: '#ffffff',
      colorNeutralBackground2: '#f3f3f3',
      colorNeutralBackground3: '#e5e5e5',
      colorNeutralBackground4: '#ebebeb',
      colorNeutralBackground4Hover: '#e0e0e0',
      colorNeutralBackground4Pressed: '#d9d9d9',
      colorNeutralStroke1: '#d4d4d4',
      colorNeutralForeground1: '#1f1f1f',
      colorNeutralForeground2: '#3b3b3b',
      colorNeutralForeground3: '#767676',
      colorPaletteRedForeground1: '#f85149',
      colorPaletteGreenForeground1: '#2ea043',
      colorPaletteYellowForeground1: '#cca700',
      colorSubtleBackground: 'transparent',
      colorSubtleBackgroundHover: '#ebebeb',
      colorSubtleBackgroundPressed: '#e0e0e0',
      colorSubtleBackgroundSelected: '#e5e5e5',
      fontFamilyBase: "'Inter Variable', ui-sans-serif, system-ui, sans-serif",
      fontFamilyMonospace: 'JetBrainsMonoNerdFont, ui-monospace, monospace',
    },
    xterm: {
      fg: '#1f1f1f',
      black: '#1f1f1f',
      brightBlack: '#1f1f1f',
      white: '#ffffff',
      brightWhite: '#ffffff',
      cursor: '#1f1f1f',
      cursorAccent: '#ffffff',
      blue: '#0451a5',
      brightBlue: '#0451a5',
      cyan: '#267f99',
      brightCyan: '#267f99',
      green: '#2ea043',
      brightGreen: '#2ea043',
      yellow: '#cca700',
      brightYellow: '#cca700',
      red: '#f85149',
      brightRed: '#f85149',
      magenta: '#af00db',
      brightMagenta: '#af00db',
    },
    scrollbar: { thumb: '#d4d4d4', thumbHover: '#b0b0b0' },
    selectionColor: 'rgb(0 95 184 / 0.3)',
    focusRingColor: 'rgb(0 95 184 / 0.5)',
  },

  utrgv: {
    brand: utrgvBrand,
    mode: 'light',
    overrides: {
      /* Shell bg aligned with --omni-bgMain so the chat body, nav rail (bg2),
         and Gallery (bg-background) all sit on a single plane (#F7F7F8). */
      colorNeutralBackground1: '#f7f7f8',
      colorNeutralBackground2: '#f1f1f3',
      colorNeutralBackground3: '#efefef',
      colorNeutralBackground4: '#f0f0f1',
      colorNeutralBackground4Hover: '#e8e8e9',
      colorNeutralBackground4Pressed: '#e2e2e3',
      colorNeutralStroke1: '#d9d9dc',
      colorNeutralForeground1: '#1a1a1e',
      colorNeutralForeground2: '#646469',
      colorNeutralForeground3: '#8e8e93',
      colorPaletteRedForeground1: '#dc2626',
      colorPaletteGreenForeground1: '#1a7f37',
      colorPaletteYellowForeground1: '#9a6700',
      colorSubtleBackground: 'transparent',
      colorSubtleBackgroundHover: '#ebebec',
      colorSubtleBackgroundPressed: '#e2e2e3',
      colorSubtleBackgroundSelected: '#e7e7e8',
      fontFamilyBase: "'Inter Variable', ui-sans-serif, system-ui, sans-serif",
      fontFamilyMonospace: 'JetBrainsMonoNerdFont, ui-monospace, monospace',
    },
    header: { bg: '#c63727', fg: '#ffffff', border: '#a82e21' },
    xterm: {
      fg: '#1a1a1e',
      black: '#1a1a1e',
      brightBlack: '#646469',
      white: '#ffffff',
      brightWhite: '#f7f7f8',
      cursor: '#f05023',
      cursorAccent: '#ffffff',
      blue: '#0451a5',
      brightBlue: '#0065d1',
      cyan: '#0e7c86',
      brightCyan: '#0e7c86',
      green: '#1a7f37',
      brightGreen: '#1a7f37',
      yellow: '#9a6700',
      brightYellow: '#9a6700',
      red: '#dc2626',
      brightRed: '#dc2626',
      magenta: '#8b3fc7',
      brightMagenta: '#8b3fc7',
    },
    scrollbar: { thumb: '#d4d4d8', thumbHover: '#b0b0b5' },
    selectionColor: 'rgb(240 80 35 / 0.15)',
    focusRingColor: 'rgb(240 80 35 / 0.4)',
  },
};

// ── Build Fluent themes + CSS vars from definitions ──────────────────────────

/** Build a Fluent Theme object from a ThemeDef. */
function buildFluentTheme(def: ThemeDef): Theme {
  const base = def.mode === 'light' ? createLightTheme(def.brand) : createDarkTheme(def.brand);
  return { ...base, ...def.overrides } as Theme;
}

/** Derive CSS custom properties from a ThemeDef + its resolved Fluent Theme.
 *  This is the core deduplication: colors are defined once in `overrides`
 *  and automatically flow to both Fluent tokens AND CSS vars. */
function buildCssVars(def: ThemeDef, theme: Theme): Record<string, string> {
  const b = def.brand;
  const x = def.xterm;
  const themeColor = (key: keyof Theme, fallback: string): string => {
    const value = theme[key];
    return typeof value === 'string' ? value : fallback;
  };
  const background1 = themeColor('colorNeutralBackground1', '#09090b');
  const background2 = themeColor('colorNeutralBackground2', '#18181b');
  const background3 = themeColor('colorNeutralBackground3', '#27272a');
  const stroke1 = themeColor('colorNeutralStroke1', '#3f3f46');
  const foreground1 = themeColor('colorNeutralForeground1', '#fafafa');
  const foreground2 = themeColor('colorNeutralForeground2', '#a1a1aa');
  const foreground3 = themeColor('colorNeutralForeground3', '#71717a');

  return {
    // Surface / foreground — derived from Fluent theme tokens
    '--color-surface': background1,
    /* Backstop painted by html/body wherever the app shell doesn't reach.
       In practice that's only the bottom safe-area zone (the top inset is
       painted by the shell itself), so it must match the mobile bottom nav —
       background2, or the branded header fill when the theme has one —
       otherwise a visible seam appears at the nav's bottom edge. */
    '--safe-area-background': def.header?.bg ?? background2,
    '--color-surface-raised': background2,
    '--color-surface-overlay': background3,
    '--color-surface-border': stroke1,
    '--color-fg': foreground1,
    '--color-fg-muted': foreground2,
    '--color-fg-subtle': foreground3,
    '--color-fg-error': themeColor('colorPaletteRedForeground1', '#f87171'),
    '--color-fg-success': themeColor('colorPaletteGreenForeground1', '#4ade80'),
    '--color-fg-warning': themeColor('colorPaletteYellowForeground1', '#fbbf24'),

    // Accent ramp — derived from BrandVariants (reversed: 150→50, 100→500, etc.)
    '--color-accent-50': b[150],
    '--color-accent-100': b[140],
    '--color-accent-200': b[130],
    '--color-accent-300': b[120],
    '--color-accent-400': b[110],
    '--color-accent-500': b[100],
    '--color-accent-600': b[90],
    '--color-accent-700': b[80],
    '--color-accent-800': b[70],
    '--color-accent-900': b[60],
    '--color-accent-950': b[20],

    // Header — defaults to surface colors, can be overridden (e.g. UTRGV branded header)
    '--color-header': def.header?.bg ?? background1,
    '--color-header-fg': def.header?.fg ?? foreground1,
    '--color-header-border': def.header?.border ?? stroke1,

    // Terminal (xterm) palette
    '--xterm-fg': x.fg,
    '--xterm-black': x.black,
    '--xterm-bright-black': x.brightBlack,
    '--xterm-white': x.white,
    '--xterm-bright-white': x.brightWhite,
    '--xterm-cursor': x.cursor,
    '--xterm-cursor-accent': x.cursorAccent,
    '--xterm-blue': x.blue,
    '--xterm-bright-blue': x.brightBlue,
    '--xterm-cyan': x.cyan,
    '--xterm-bright-cyan': x.brightCyan,
    '--xterm-green': x.green,
    '--xterm-bright-green': x.brightGreen,
    '--xterm-yellow': x.yellow,
    '--xterm-bright-yellow': x.brightYellow,
    '--xterm-red': x.red,
    '--xterm-bright-red': x.brightRed,
    '--xterm-magenta': x.magenta,
    '--xterm-bright-magenta': x.brightMagenta,

    // Scrollbar
    '--scrollbar-thumb': def.scrollbar.thumb,
    '--scrollbar-thumb-hover': def.scrollbar.thumbHover,

    // Selection / focus
    '--selection-color': def.selectionColor,
    '--focus-ring-color': def.focusRingColor,

    // Display typeface — identity face for headings/empty states/onboarding.
    // Same for every theme; body text stays on fontFamilyBase.
    '--font-display': "'Space Grotesk Variable', 'Inter Variable', ui-sans-serif, system-ui, sans-serif",
  };
}

// ── Generated lookups ────────────────────────────────────────────────────────

function buildAll() {
  const themes = {} as Record<OmniTheme, Theme>;
  const cssVars = {} as Record<OmniTheme, Record<string, string>>;

  for (const [name, def] of Object.entries(themeDefs) as [OmniTheme, ThemeDef][]) {
    const fluentTheme = buildFluentTheme(def);
    themes[name] = fluentTheme;
    cssVars[name] = buildCssVars(def, fluentTheme);
  }

  return { themes, cssVars };
}

const { themes: fluentThemesBuilt, cssVars: themeCssVarsBuilt } = buildAll();

// ── Text scaling ─────────────────────────────────────────────────────────────

/** Supported "Text size" steps (percent). */
export const TEXT_SCALES = [90, 100, 110, 125] as const;
export type TextScale = (typeof TEXT_SCALES)[number];

const FONT_TOKEN_RE = /^(fontSizeBase|fontSizeHero|lineHeightBase|lineHeightHero)/;

/**
 * Scale a theme's type ramp (font sizes + line heights) by `scale` percent.
 * Pure — exported for tests. Non-font tokens pass through untouched.
 */
export function scaleThemeFonts(theme: Theme, scale: number): Theme {
  if (scale === 100) {
    return theme;
  }
  const factor = scale / 100;
  const out: Record<string, unknown> = { ...theme };
  for (const [key, value] of Object.entries(theme)) {
    if (FONT_TOKEN_RE.test(key) && typeof value === 'string' && value.endsWith('px')) {
      const px = Number.parseFloat(value);
      if (!Number.isNaN(px)) {
        out[key] = `${Math.round(px * factor)}px`;
      }
    }
  }
  return out as unknown as Theme;
}

const scaledThemeCache = new Map<string, Theme>();

/** Resolve the Fluent theme for a theme name at a text scale (cached). */
export function getFluentTheme(theme: OmniTheme, scale: number = 100): Theme {
  const base = fluentThemesBuilt[theme];
  if (scale === 100) {
    return base;
  }
  const key = `${theme}:${scale}`;
  let scaled = scaledThemeCache.get(key);
  if (!scaled) {
    scaled = scaleThemeFonts(base, scale);
    scaledThemeCache.set(key, scaled);
  }
  return scaled;
}

// ── Material / backdrop helpers ──────────────────────────────────────────────

/** Whether the theme's surfaces are glass (translucent over a backdrop). */
export function isGlassTheme(theme: OmniTheme): boolean {
  return themeDefs[theme].material === 'glass';
}

/** The theme's built-in backdrop (CSS `background` value), if it has one. */
export function getThemeBackdrop(theme: OmniTheme): string | null {
  return themeDefs[theme].backdrop ?? null;
}

/** Glass tone to use over the theme's built-in backdrop. */
export function getThemeBuiltinGlassTone(theme: OmniTheme): 'dark' | 'light' {
  return themeDefs[theme].builtinGlassTone ?? 'dark';
}

/** Theme-def names — exported so tests can assert parity with the store schema enum. */
export const themeDefNames = Object.keys(themeDefs) as OmniTheme[];

/** Whether a theme uses dark mode. */
export function isThemeDark(theme: OmniTheme): boolean {
  return themeDefs[theme].mode === 'dark';
}

export function getThemeSurfaceColor(theme: OmniTheme): string {
  return themeCssVarsBuilt[theme]['--color-surface'] ?? '#09090b';
}

/** The color of the mobile bottom nav for this theme — what the html/body
 *  backstop must paint so the bottom safe-area zone is seamless with the bar
 *  (see the `--safe-area-background` comment in buildCssVars). */
export function getThemeSafeAreaColor(theme: OmniTheme): string {
  return themeCssVarsBuilt[theme]['--safe-area-background'] ?? '#18181b';
}

export function applyPwaTheme(theme: OmniTheme): void {
  const surfaceColor = getThemeSurfaceColor(theme);
  const safeAreaColor = getThemeSafeAreaColor(theme);

  document.documentElement.style.setProperty('--safe-area-background', safeAreaColor);
  document.documentElement.style.backgroundColor = safeAreaColor;

  if (document.body) {
    document.body.style.backgroundColor = safeAreaColor;
  }

  const root = document.getElementById('root');
  if (root) {
    root.style.backgroundColor = safeAreaColor;
  }

  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = surfaceColor;
  }

  const statusBarMeta = document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-status-bar-style"]');
  if (statusBarMeta) {
    statusBarMeta.content = isThemeDark(theme) ? 'black-translucent' : 'default';
  }
}

/** Apply CSS custom properties for the given theme onto :root. */
export function applyCssVars(theme: OmniTheme): void {
  const vars = themeCssVarsBuilt[theme];
  const style = document.documentElement.style;
  for (const [key, value] of Object.entries(vars)) {
    style.setProperty(key, value);
  }
}
