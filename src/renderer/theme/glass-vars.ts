import type { CSSProperties } from 'react';

/**
 * Theme-orthogonal glass material. Two tones (dark / light) chosen by
 * wallpaper luminance — dark wallpapers get a black scrim with light text,
 * light wallpapers get a white scrim with dark text.
 *
 * These vars are spread onto the deck-bg root in MainContent. They override
 * the active theme's neutral CSS vars on that subtree only — Fluent tokens
 * (`tokens.colorNeutralBackground1`, etc.), the Tailwind `--color-*` ramp,
 * the legacy `--color-bgMain` family, and shadcn semantic tokens
 * (`--color-card`, `--color-secondary`, ...) all converge on the same
 * material. Brand-related tokens are intentionally not overridden so the
 * theme's accent still tints CTAs.
 */

export type GlassTone = 'dark' | 'light';

const darkGlass: Record<string, string> = {
  // Fluent neutral surfaces
  '--colorNeutralBackground1': 'rgba(0, 0, 0, 0.35)',
  '--colorNeutralBackground2': 'rgba(0, 0, 0, 0.42)',
  '--colorNeutralBackground3': 'rgba(255, 255, 255, 0.08)',
  '--colorNeutralBackground4': 'rgba(0, 0, 0, 0.40)',
  '--colorNeutralBackground1Hover': 'rgba(255, 255, 255, 0.10)',
  '--colorNeutralBackground1Pressed': 'rgba(255, 255, 255, 0.16)',
  '--colorNeutralBackground1Selected': 'rgba(255, 255, 255, 0.14)',
  '--colorNeutralBackground2Hover': 'rgba(255, 255, 255, 0.10)',
  '--colorNeutralBackground2Pressed': 'rgba(255, 255, 255, 0.16)',
  '--colorNeutralBackground2Selected': 'rgba(255, 255, 255, 0.14)',
  '--colorNeutralBackground3Hover': 'rgba(255, 255, 255, 0.10)',
  '--colorNeutralBackground3Pressed': 'rgba(255, 255, 255, 0.16)',
  '--colorNeutralBackground3Selected': 'rgba(255, 255, 255, 0.14)',
  '--colorNeutralBackground4Hover': 'rgba(255, 255, 255, 0.10)',
  '--colorNeutralBackground4Pressed': 'rgba(255, 255, 255, 0.16)',
  '--colorSubtleBackground': 'transparent',
  '--colorSubtleBackgroundHover': 'rgba(255, 255, 255, 0.10)',
  '--colorSubtleBackgroundPressed': 'rgba(255, 255, 255, 0.16)',
  '--colorSubtleBackgroundSelected': 'rgba(255, 255, 255, 0.14)',
  '--colorNeutralStroke1': 'rgba(255, 255, 255, 0.14)',
  '--colorNeutralStrokeAccessible': 'rgba(255, 255, 255, 0.5)',
  '--colorNeutralStrokeAccessibleHover': 'rgba(255, 255, 255, 0.65)',
  '--colorNeutralForeground1': 'rgba(255, 255, 255, 0.95)',
  '--colorNeutralForeground2': 'rgba(255, 255, 255, 0.78)',
  '--colorNeutralForeground3': 'rgba(255, 255, 255, 0.6)',
  '--colorNeutralForeground4': 'rgba(255, 255, 255, 0.5)',

  // Tailwind app palette
  '--color-surface': 'rgba(0, 0, 0, 0.35)',
  '--color-surface-raised': 'rgba(0, 0, 0, 0.42)',
  '--color-surface-overlay': 'rgba(255, 255, 255, 0.08)',
  '--color-surface-border': 'rgba(255, 255, 255, 0.14)',
  '--color-fg': 'rgba(255, 255, 255, 0.95)',
  '--color-fg-muted': 'rgba(255, 255, 255, 0.78)',
  '--color-fg-subtle': 'rgba(255, 255, 255, 0.6)',

  // Legacy --color-bg* (chat UI Tailwind utilities)
  '--color-bgMain': 'rgba(0, 0, 0, 0.35)',
  '--color-bgColumn': 'rgba(0, 0, 0, 0.42)',
  '--color-bgCard': 'rgba(0, 0, 0, 0.42)',
  '--color-bgCardAlt': 'rgba(255, 255, 255, 0.08)',
  '--color-textPrimary': 'rgba(255, 255, 255, 0.95)',
  '--color-textHeading': 'rgba(255, 255, 255, 1)',
  '--color-textSecondary': 'rgba(255, 255, 255, 0.78)',
  '--color-textSubtle': 'rgba(255, 255, 255, 0.6)',

  // shadcn semantic
  '--color-background': 'rgba(0, 0, 0, 0.35)',
  '--color-foreground': 'rgba(255, 255, 255, 0.95)',
  '--color-card': 'rgba(0, 0, 0, 0.42)',
  '--color-card-foreground': 'rgba(255, 255, 255, 0.95)',
  '--color-popover': 'rgba(20, 20, 24, 0.85)',
  '--color-popover-foreground': 'rgba(255, 255, 255, 0.95)',
  '--color-muted': 'rgba(255, 255, 255, 0.06)',
  '--color-muted-foreground': 'rgba(255, 255, 255, 0.6)',
  '--color-secondary': 'rgba(255, 255, 255, 0.10)',
  '--color-secondary-foreground': 'rgba(255, 255, 255, 0.95)',
  '--color-accent': 'rgba(255, 255, 255, 0.12)',
  '--color-accent-foreground': 'rgba(255, 255, 255, 0.95)',
  '--color-border': 'rgba(255, 255, 255, 0.14)',
  '--color-input': 'rgba(255, 255, 255, 0.10)',
  '--color-sidebar': 'rgba(0, 0, 0, 0.42)',
  '--color-sidebar-foreground': 'rgba(255, 255, 255, 0.95)',

  // Blur layer (components opt in via backdropFilter: var(--glass-blur))
  '--glass-blur': 'blur(36px) saturate(160%)',
  '--glass-blur-light': 'blur(20px) saturate(160%)',
};

const lightGlass: Record<string, string> = {
  // Fluent neutral surfaces
  '--colorNeutralBackground1': 'rgba(255, 255, 255, 0.55)',
  '--colorNeutralBackground2': 'rgba(255, 255, 255, 0.65)',
  '--colorNeutralBackground3': 'rgba(0, 0, 0, 0.04)',
  '--colorNeutralBackground4': 'rgba(255, 255, 255, 0.50)',
  '--colorNeutralBackground1Hover': 'rgba(0, 0, 0, 0.05)',
  '--colorNeutralBackground1Pressed': 'rgba(0, 0, 0, 0.10)',
  '--colorNeutralBackground1Selected': 'rgba(0, 0, 0, 0.08)',
  '--colorNeutralBackground2Hover': 'rgba(0, 0, 0, 0.05)',
  '--colorNeutralBackground2Pressed': 'rgba(0, 0, 0, 0.10)',
  '--colorNeutralBackground2Selected': 'rgba(0, 0, 0, 0.08)',
  '--colorNeutralBackground3Hover': 'rgba(0, 0, 0, 0.05)',
  '--colorNeutralBackground3Pressed': 'rgba(0, 0, 0, 0.10)',
  '--colorNeutralBackground3Selected': 'rgba(0, 0, 0, 0.08)',
  '--colorNeutralBackground4Hover': 'rgba(0, 0, 0, 0.05)',
  '--colorNeutralBackground4Pressed': 'rgba(0, 0, 0, 0.10)',
  '--colorSubtleBackground': 'transparent',
  '--colorSubtleBackgroundHover': 'rgba(0, 0, 0, 0.05)',
  '--colorSubtleBackgroundPressed': 'rgba(0, 0, 0, 0.10)',
  '--colorSubtleBackgroundSelected': 'rgba(0, 0, 0, 0.08)',
  '--colorNeutralStroke1': 'rgba(0, 0, 0, 0.12)',
  '--colorNeutralStrokeAccessible': 'rgba(0, 0, 0, 0.5)',
  '--colorNeutralStrokeAccessibleHover': 'rgba(0, 0, 0, 0.65)',
  '--colorNeutralForeground1': 'rgba(0, 0, 0, 0.95)',
  '--colorNeutralForeground2': 'rgba(0, 0, 0, 0.7)',
  '--colorNeutralForeground3': 'rgba(0, 0, 0, 0.55)',
  '--colorNeutralForeground4': 'rgba(0, 0, 0, 0.45)',

  // Tailwind app palette
  '--color-surface': 'rgba(255, 255, 255, 0.55)',
  '--color-surface-raised': 'rgba(255, 255, 255, 0.65)',
  '--color-surface-overlay': 'rgba(0, 0, 0, 0.04)',
  '--color-surface-border': 'rgba(0, 0, 0, 0.12)',
  '--color-fg': 'rgba(0, 0, 0, 0.95)',
  '--color-fg-muted': 'rgba(0, 0, 0, 0.7)',
  '--color-fg-subtle': 'rgba(0, 0, 0, 0.55)',

  // Legacy --color-bg* (chat UI Tailwind utilities)
  '--color-bgMain': 'rgba(255, 255, 255, 0.55)',
  '--color-bgColumn': 'rgba(255, 255, 255, 0.65)',
  '--color-bgCard': 'rgba(255, 255, 255, 0.65)',
  '--color-bgCardAlt': 'rgba(0, 0, 0, 0.04)',
  '--color-textPrimary': 'rgba(0, 0, 0, 0.95)',
  '--color-textHeading': 'rgba(0, 0, 0, 1)',
  '--color-textSecondary': 'rgba(0, 0, 0, 0.7)',
  '--color-textSubtle': 'rgba(0, 0, 0, 0.55)',

  // shadcn semantic
  '--color-background': 'rgba(255, 255, 255, 0.55)',
  '--color-foreground': 'rgba(0, 0, 0, 0.95)',
  '--color-card': 'rgba(255, 255, 255, 0.65)',
  '--color-card-foreground': 'rgba(0, 0, 0, 0.95)',
  '--color-popover': 'rgba(245, 245, 248, 0.92)',
  '--color-popover-foreground': 'rgba(0, 0, 0, 0.95)',
  '--color-muted': 'rgba(0, 0, 0, 0.04)',
  '--color-muted-foreground': 'rgba(0, 0, 0, 0.55)',
  '--color-secondary': 'rgba(0, 0, 0, 0.06)',
  '--color-secondary-foreground': 'rgba(0, 0, 0, 0.95)',
  '--color-accent': 'rgba(0, 0, 0, 0.08)',
  '--color-accent-foreground': 'rgba(0, 0, 0, 0.95)',
  '--color-border': 'rgba(0, 0, 0, 0.12)',
  '--color-input': 'rgba(255, 255, 255, 0.6)',
  '--color-sidebar': 'rgba(255, 255, 255, 0.65)',
  '--color-sidebar-foreground': 'rgba(0, 0, 0, 0.95)',

  '--glass-blur': 'blur(36px) saturate(160%)',
  '--glass-blur-light': 'blur(20px) saturate(160%)',
};

export function getGlassVars(tone: GlassTone): CSSProperties {
  return (tone === 'light' ? lightGlass : darkGlass) as unknown as CSSProperties;
}

/**
 * Sample average perceptual luminance from a data:URL image. Returns a value
 * in [0, 1]. Used by the wallpaper picker to choose a glass tone — light
 * wallpapers (>= 0.5) get the light palette, dark wallpapers get dark.
 *
 * Downsamples to 32×32 before averaging — reading every pixel of a full-res
 * wallpaper would be wasteful and the tone choice doesn't need precision.
 */
export async function detectGlassTone(dataUrl: string): Promise<GlassTone> {
  const luma = await sampleLuminance(dataUrl).catch(() => 0);
  return luma >= 0.5 ? 'light' : 'dark';
}

async function sampleLuminance(dataUrl: string): Promise<number> {
  const img = new Image();
  img.src = dataUrl;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('image load failed'));
  });
  const SIZE = 32;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return 0;
  }
  ctx.drawImage(img, 0, 0, SIZE, SIZE);
  const { data } = ctx.getImageData(0, 0, SIZE, SIZE);
  let total = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    // Rec. 709 luma; good enough for tone classification.
    total += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    count += 1;
  }
  return count > 0 ? total / count : 0;
}
