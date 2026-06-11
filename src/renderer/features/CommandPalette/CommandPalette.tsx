/**
 * ⌘K command palette + the global keyboard map (UI/UX gameplan Phase 4).
 *
 * - mod+K opens the palette: type to filter, ↑/↓ to move, Enter to run,
 *   Esc to close.
 * - mod+1…9 jump straight to the Nth deck column (and switch to Spaces),
 *   palette closed or open.
 *
 * Mounted once at the app root, renders nothing until opened.
 */
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';

import { codeApi } from '@/renderer/features/Code/state';
import { persistedStoreApi } from '@/renderer/services/store';
import type { CodeTab, LayoutMode } from '@/shared/types';

import { buildCommands, filterCommands, paletteColumns } from './commands';

const useStyles = makeStyles({
  overlay: {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 1000,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'flex-start',
    paddingTop: '16vh',
  },
  panel: {
    width: '560px',
    maxWidth: '92vw',
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    boxShadow: tokens.shadow64,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    border: 'none',
    outline: 'none',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground1,
    fontSize: tokens.fontSizeBase400,
    padding: '16px 20px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    '::placeholder': { color: tokens.colorNeutralForeground4 },
  },
  list: {
    maxHeight: '320px',
    overflowY: 'auto',
    padding: '6px',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    width: '100%',
    textAlign: 'left',
    border: 'none',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground1,
    fontSize: tokens.fontSizeBase300,
    padding: '10px 14px',
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
  },
  rowActive: {
    backgroundColor: tokens.colorSubtleBackgroundSelected,
  },
  rowLabel: {
    flex: '1 1 0',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  rowHint: {
    flexShrink: 0,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    fontFamily: tokens.fontFamilyMonospace,
  },
  empty: {
    padding: '18px 20px',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase300,
  },
});

const HOTKEY_OPTS = { enableOnFormTags: true, preventDefault: true } as const;

export const CommandPalette = memo(() => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const navigate = useCallback((mode: LayoutMode) => {
    persistedStoreApi.setKey('layoutMode', mode);
  }, []);

  const activateColumn = useCallback((tabId: string) => {
    codeApi.setActiveTab(tabId);
    persistedStoreApi.setKey('layoutMode', 'spaces');
  }, []);

  const resolveTabLabel = useCallback(
    (tab: CodeTab) => {
      const project = store.projects.find((p) => p.id === tab.projectId);
      if (project) {
        return tab.ticketTitle ? `${project.label} — ${tab.ticketTitle}` : project.label;
      }
      return 'New Session';
    },
    [store.projects]
  );

  const commands = useMemo(
    () =>
      buildCommands({
        codeTabs: store.codeTabs ?? [],
        codeLayoutMode: store.codeLayoutMode ?? 'tile',
        resolveTabLabel,
        navigate,
        activateColumn,
        newSession: () => {
          void codeApi.addTab();
          persistedStoreApi.setKey('layoutMode', 'spaces');
        },
        setDeckLayout: (mode) => {
          codeApi.setLayoutMode(mode);
          persistedStoreApi.setKey('layoutMode', 'spaces');
        },
      }),
    [store.codeTabs, store.codeLayoutMode, resolveTabLabel, navigate, activateColumn]
  );

  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActiveIndex(0);
  }, []);

  const runCommand = useCallback(
    (index: number) => {
      const cmd = filtered[index];
      if (!cmd) {
        return;
      }
      close();
      cmd.run();
    },
    [filtered, close]
  );

  useHotkeys('mod+k', () => setOpen((v) => !v), HOTKEY_OPTS, []);

  // mod+1…9: jump to the Nth deck column directly.
  useHotkeys(
    'mod+1,mod+2,mod+3,mod+4,mod+5,mod+6,mod+7,mod+8,mod+9',
    (e) => {
      const digit = Number(e.key);
      if (!Number.isInteger(digit) || digit < 1) {
        return;
      }
      const columns = paletteColumns(persistedStoreApi.getKey('codeTabs') ?? []);
      const target = columns[digit - 1];
      if (target) {
        activateColumn(target.id);
      }
    },
    HOTKEY_OPTS,
    [activateColumn]
  );

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  // Clamp the active row when the filter shrinks the list.
  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        runCommand(activeIndex);
      }
    },
    [close, filtered.length, runCommand, activeIndex]
  );

  const handleQueryChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
    setActiveIndex(0);
  }, []);

  const stopPropagation = useCallback((e: React.MouseEvent) => e.stopPropagation(), []);

  if (!open) {
    return null;
  }

  return (
    <div className={styles.overlay} onClick={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className={styles.panel}
        onClick={stopPropagation}
        onKeyDown={handleKeyDown}
      >
        <input
          ref={inputRef}
          className={styles.input}
          value={query}
          onChange={handleQueryChange}
          placeholder="Type a command…"
          aria-label="Search commands"
          role="combobox"
          aria-expanded="true"
          aria-controls="command-palette-list"
          aria-activedescendant={filtered[activeIndex] ? `palette-cmd-${filtered[activeIndex].id}` : undefined}
        />
        <div id="command-palette-list" role="listbox" aria-label="Commands" className={styles.list}>
          {filtered.length === 0 && <div className={styles.empty}>No matching commands</div>}
          {filtered.map((cmd, index) => (
            <button
              key={cmd.id}
              id={`palette-cmd-${cmd.id}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={mergeClasses(styles.row, index === activeIndex && styles.rowActive)}
              onMouseEnter={setActiveIndex.bind(null, index)}
              onClick={runCommand.bind(null, index)}
            >
              <span className={styles.rowLabel}>{cmd.label}</span>
              {cmd.hint && <span className={styles.rowHint}>{cmd.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
});
CommandPalette.displayName = 'CommandPalette';
