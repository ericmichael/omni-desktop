/**
 * Theme system invariants (UI/UX gameplan Phase 10).
 */
import { describe, expect, it } from 'vitest';

import { schema } from '@/shared/types';

import { isThemeDark, themeDefNames } from './themes';

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

describe('theme modes', () => {
  it('keeps the stock shadcn baseline in dark mode', () => {
    expect(isThemeDark('default')).toBe(true);
  });
});
