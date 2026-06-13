/**
 * Command registry for the ⌘K palette — pure builders so the list and the
 * filter are unit-testable. Commands close over their actions; the palette
 * just renders and runs them.
 */
import type { CodeLayoutMode, CodeTab, LayoutMode } from '@/shared/types';
import { isChatTab } from '@/shared/types';

export type PaletteCommand = {
  id: string;
  label: string;
  /** Secondary text (e.g. the column's started stamp or a hint). */
  hint?: string;
  /** Extra match terms beyond the label. */
  keywords?: string;
  run: () => void;
};

export type PaletteContext = {
  codeTabs: CodeTab[];
  codeLayoutMode: CodeLayoutMode;
  /** Resolve a session tab's display label (project name etc.). */
  resolveTabLabel: (tab: CodeTab) => string;
  navigate: (mode: LayoutMode) => void;
  goToInbox: () => void;
  activateColumn: (tabId: string) => void;
  addInboxItem: () => void;
  createProject: () => void;
  newSession: () => void;
  setDeckLayout: (mode: CodeLayoutMode) => void;
};

/** Session columns the palette can jump to (the deck's view of codeTabs). */
export const paletteColumns = (codeTabs: CodeTab[]): CodeTab[] =>
  codeTabs.filter((t) => !isChatTab(t) && !t.customAppId);

export function buildCommands(ctx: PaletteContext): PaletteCommand[] {
  const commands: PaletteCommand[] = [
    { id: 'nav-chat', label: 'Go to Chat', keywords: 'conversation talk', run: () => ctx.navigate('chat') },
    { id: 'nav-spaces', label: 'Go to Spaces', keywords: 'deck columns code', run: () => ctx.navigate('spaces') },
    {
      id: 'nav-projects',
      label: 'Go to Projects',
      keywords: 'tickets board home inbox',
      run: () => ctx.navigate('projects'),
    },
    { id: 'nav-inbox', label: 'Go to Inbox', keywords: 'capture ideas todo triage', run: ctx.goToInbox },
    {
      id: 'nav-settings',
      label: 'Go to Settings',
      keywords: 'preferences models mcp git',
      run: () => ctx.navigate('settings'),
    },
    { id: 'add-inbox-item', label: 'Add inbox item', keywords: 'capture idea todo quick', run: ctx.addInboxItem },
    { id: 'create-project', label: 'Create project', keywords: 'new workspace initiative', run: ctx.createProject },
    { id: 'new-session', label: 'New session', keywords: 'create column agent', run: ctx.newSession },
    {
      id: 'toggle-layout',
      label: ctx.codeLayoutMode === 'tile' ? 'Switch deck to Focus layout' : 'Switch deck to Tile layout',
      keywords: 'tile focus layout deck view',
      run: () => ctx.setDeckLayout(ctx.codeLayoutMode === 'tile' ? 'focus' : 'tile'),
    },
  ];

  paletteColumns(ctx.codeTabs).forEach((tab, index) => {
    commands.push({
      id: `column-${tab.id}`,
      label: `Go to column ${index + 1}: ${ctx.resolveTabLabel(tab)}`,
      hint: `⌘${index + 1}`,
      keywords: 'jump session column',
      run: () => ctx.activateColumn(tab.id),
    });
  });

  return commands;
}

/** Case-insensitive substring match over label + keywords. Empty query = all. */
export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return commands;
  }
  return commands.filter((c) => c.label.toLowerCase().includes(q) || (c.keywords ?? '').toLowerCase().includes(q));
}
