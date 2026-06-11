/**
 * Theme system invariants (UI/UX gameplan Phase 10).
 */
import { describe, expect, it } from 'vitest';

import { schema } from '@/shared/types';

import { getFluentTheme, isGlassTheme, scaleThemeFonts, themeDefNames } from './fluent-themes';

describe('theme schema parity', () => {
  it('every theme def is in the store schema enum (clearInvalidConfig wipes stores otherwise)', () => {
    const enumValues = (schema.theme as { enum?: string[] }).enum ?? [];
    for (const name of themeDefNames) {
      expect(enumValues).toContain(name);
    }
  });

  it('every schema enum value has a theme def', () => {
    const enumValues = (schema.theme as { enum?: string[] }).enum ?? [];
    for (const value of enumValues) {
      expect(themeDefNames).toContain(value);
    }
  });

  it('the schema default theme exists', () => {
    const def = (schema.theme as { default?: string }).default;
    expect(themeDefNames).toContain(def);
  });
});

describe('isGlassTheme', () => {
  it('omni is glass', () => {
    expect(isGlassTheme('omni')).toBe(true);
  });

  it('flat themes are not glass', () => {
    expect(isGlassTheme('tokyo-night')).toBe(false);
    expect(isGlassTheme('teams-light')).toBe(false);
    expect(isGlassTheme('vscode-dark')).toBe(false);
  });
});

describe('scaleThemeFonts', () => {
  const base = getFluentTheme('omni', 100);

  it('returns the theme unchanged at 100', () => {
    expect(scaleThemeFonts(base, 100)).toBe(base);
  });

  it('scales font sizes and line heights, rounding to integers', () => {
    const scaled = scaleThemeFonts(base, 125);
    const basePx = Number.parseFloat(base.fontSizeBase300);
    expect(scaled.fontSizeBase300).toBe(`${Math.round(basePx * 1.25)}px`);
    const baseLh = Number.parseFloat(base.lineHeightBase300);
    expect(scaled.lineHeightBase300).toBe(`${Math.round(baseLh * 1.25)}px`);
  });

  it('scales down at 90', () => {
    const scaled = scaleThemeFonts(base, 90);
    const basePx = Number.parseFloat(base.fontSizeBase300);
    expect(scaled.fontSizeBase300).toBe(`${Math.round(basePx * 0.9)}px`);
  });

  it('leaves non-font tokens untouched', () => {
    const scaled = scaleThemeFonts(base, 125);
    expect(scaled.colorNeutralBackground1).toBe(base.colorNeutralBackground1);
    expect(scaled.fontFamilyBase).toBe(base.fontFamilyBase);
  });

  it('getFluentTheme caches scaled themes', () => {
    expect(getFluentTheme('omni', 125)).toBe(getFluentTheme('omni', 125));
  });
});
