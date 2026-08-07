import { beforeEach, describe, expect, it } from 'vitest';

import { demoteLegacyYooptaStyles } from './yoopta-style-demote';

function addStyle(css: string): HTMLStyleElement {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  return style;
}

beforeEach(() => {
  document.head.querySelectorAll('style').forEach((style) => style.remove());
});

describe('demoteLegacyYooptaStyles', () => {
  it('wraps legacy-convention sheets in the yoopta layer', () => {
    const legacy = addStyle('.bg-background{background-color:hsl(var(--background))}');
    const modern = addStyle('.bg-background{background-color:var(--background)}');

    expect(demoteLegacyYooptaStyles()).toBe(1);

    expect(legacy.textContent).toBe('@layer yoopta{.bg-background{background-color:hsl(var(--background))}}');
    // Sheets already using the valid convention are untouched.
    expect(modern.textContent).toBe('.bg-background{background-color:var(--background)}');
  });

  it('is idempotent across repeated calls', () => {
    const legacy = addStyle('.text-foreground{color:hsl(var(--foreground))}');

    expect(demoteLegacyYooptaStyles()).toBe(1);
    expect(demoteLegacyYooptaStyles()).toBe(0);

    expect(legacy.textContent).toBe('@layer yoopta{.text-foreground{color:hsl(var(--foreground))}}');
  });

  it('catches any injector using the broken convention, not just known files', () => {
    addStyle('.some-future-chip{border-color:hsl(var(--border))}');
    expect(demoteLegacyYooptaStyles()).toBe(1);
  });
});
