import { describe, expect, it } from 'vitest';

import type { CustomAppEntry } from '@/shared/app-registry';
import { buildAppRegistry,BUILTIN_APPS } from '@/shared/app-registry';

describe('buildAppRegistry', () => {
  it('returns builtin apps when no custom apps provided', () => {
    const registry = buildAppRegistry([]);
    expect(registry).toEqual(BUILTIN_APPS);
  });

  it('appends custom apps after builtins when order is higher', () => {
    const custom: CustomAppEntry[] = [{ id: 'teams', label: 'Teams', icon: 'People20Regular', url: 'https://teams.microsoft.com', order: 50 }];
    const registry = buildAppRegistry(custom);
    expect(registry).toHaveLength(BUILTIN_APPS.length + 1);
    expect(registry[registry.length - 1]).toMatchObject({ id: 'teams', kind: 'webview', scope: 'always', builtin: false });
  });

  it('sorts custom apps by order among builtins', () => {
    const custom: CustomAppEntry[] = [
      { id: 'app-a', label: 'A', icon: 'Star20Regular', url: 'https://a.com', order: 15 },
      { id: 'app-b', label: 'B', icon: 'Star20Regular', url: 'https://b.com', order: 5 },
    ];
    const registry = buildAppRegistry(custom);
    const ids = registry.map((a) => a.id);
    expect(ids).toEqual(['chat', 'app-b', 'code', 'app-a', 'desktop', 'browser', 'terminal']);
  });

  it('preserves stable order for equal-order items', () => {
    const custom: CustomAppEntry[] = [{ id: 'x', label: 'X', icon: 'Star20Regular', url: 'https://x.com', order: 0 }];
    const registry = buildAppRegistry(custom);
    // chat (order 0) comes before x (order 0) because builtins are first in the spread
    expect(registry[0].id).toBe('chat');
    expect(registry[1].id).toBe('x');
  });

  it('defaults custom apps to columnScoped=false and respects opt-in', () => {
    const custom: CustomAppEntry[] = [
      { id: 'a', label: 'A', icon: 'Star20Regular', url: 'https://a.com', order: 50 },
      { id: 'b', label: 'B', icon: 'Star20Regular', url: 'https://b.com', order: 60, columnScoped: true },
    ];
    const registry = buildAppRegistry(custom);
    const a = registry.find((r) => r.id === 'a');
    const b = registry.find((r) => r.id === 'b');
    expect(a?.columnScoped).toBe(false);
    expect(b?.columnScoped).toBe(true);
  });

  it('marks every builtin app as columnScoped', () => {
    for (const app of BUILTIN_APPS) {
      expect(app.columnScoped).toBe(true);
    }
  });
});
