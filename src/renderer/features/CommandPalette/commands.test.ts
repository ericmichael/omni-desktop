import { describe, expect, it, vi } from 'vitest';

import type { CodeTab } from '@/shared/types';

import { buildCommands, filterCommands, paletteColumns } from './commands';

const tab = (patch: Partial<CodeTab>): CodeTab => ({
  id: 'tab-1',
  projectId: null,
  createdAt: 1,
  ...patch,
});

const ctx = (codeTabs: CodeTab[] = []) => ({
  codeTabs,
  codeLayoutMode: 'tile' as const,
  resolveTabLabel: (t: CodeTab) => `label:${t.id}`,
  navigate: vi.fn(),
  activateColumn: vi.fn(),
  newSession: vi.fn(),
  setDeckLayout: vi.fn(),
});

describe('paletteColumns', () => {
  it('excludes the reserved chat record and app columns', () => {
    const tabs = [
      tab({ id: 'chat' }),
      tab({ id: 'a', projectId: 'p1' }),
      tab({ id: 'b', customAppId: 'browser' }),
      tab({ id: 'c' }),
    ];
    expect(paletteColumns(tabs).map((t) => t.id)).toEqual(['a', 'c']);
  });
});

describe('buildCommands', () => {
  it('includes navigation, session, layout, and per-column commands', () => {
    const c = ctx([tab({ id: 'chat' }), tab({ id: 'a', projectId: 'p1' })]);
    const commands = buildCommands(c);
    const ids = commands.map((cmd) => cmd.id);
    expect(ids).toEqual(
      expect.arrayContaining(['nav-chat', 'nav-spaces', 'nav-projects', 'nav-settings', 'new-session', 'toggle-layout', 'column-a'])
    );
    expect(ids).not.toContain('column-chat');
  });

  it('labels the layout toggle by the current mode and numbers column hints', () => {
    const c = { ...ctx([tab({ id: 'a', projectId: 'p1' }), tab({ id: 'b', projectId: 'p2' })]), codeLayoutMode: 'focus' as const };
    const commands = buildCommands(c);
    expect(commands.find((cmd) => cmd.id === 'toggle-layout')!.label).toContain('Tile');
    expect(commands.find((cmd) => cmd.id === 'column-b')!.hint).toBe('⌘2');
  });

  it('runs the bound actions', () => {
    const c = ctx([tab({ id: 'a', projectId: 'p1' })]);
    const commands = buildCommands(c);
    commands.find((cmd) => cmd.id === 'nav-projects')!.run();
    expect(c.navigate).toHaveBeenCalledWith('projects');
    commands.find((cmd) => cmd.id === 'column-a')!.run();
    expect(c.activateColumn).toHaveBeenCalledWith('a');
  });
});

describe('filterCommands', () => {
  const commands = buildCommands(ctx([tab({ id: 'a', projectId: 'p1' })]));

  it('returns all commands for an empty query', () => {
    expect(filterCommands(commands, '  ')).toHaveLength(commands.length);
  });

  it('matches labels case-insensitively', () => {
    expect(filterCommands(commands, 'SETTINGS').map((c) => c.id)).toEqual(['nav-settings']);
  });

  it('matches keywords', () => {
    expect(filterCommands(commands, 'kanban board').map((c) => c.id)).toEqual([]);
    expect(filterCommands(commands, 'board').map((c) => c.id)).toEqual(['nav-projects']);
  });
});
