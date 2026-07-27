import type { PresenceBadgeStatus } from '@fluentui/react-components';
import { makeStyles, mergeClasses, PresenceBadge, tokens } from '@fluentui/react-components';
import {
  Add20Regular,
  ColumnTriple20Regular,
  Delete20Regular,
  Dismiss20Regular,
  MoreHorizontal20Regular,
} from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';

import { useNavTreeStyles } from '@/renderer/common/nav-tree';
import { NavSection } from '@/renderer/common/NavSection';
import {
  ConfirmDialog,
  CounterBadge,
  IconButton,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Tree,
  TreeItem,
  TreeItemLayout,
} from '@/renderer/ds';
import { $columnActivity, activityStatusText } from '@/renderer/services/column-activity';
import { persistedStoreApi } from '@/renderer/services/store';
import type { ChatConversation, CodeTab, CodeTabId } from '@/shared/types';

import { APP_LAUNCHER_ID, codeApi } from './state';
import { useRecentConversations } from './use-recent-conversations';

/**
 * The Sessions nav section: ONE list of the user's conversations (plus any
 * other open columns), sorted by recency. Whether a session currently holds
 * a column, a sandbox, or nothing is the app's bookkeeping — the user just
 * clicks a row and lands in the conversation. State shows as indicators in
 * the DM-row grammar (one status vocabulary across the sidebar), never as a
 * section:
 *
 * - a bare presence dot in the gutter (no glyph — deliberately quiet):
 *   busy = agent working now (status text in the tooltip), available =
 *   open and idle, offline = closed/archived (clicking resurrects it
 *   into a column)
 * - attention in the aside — the sessions equivalent of unread: a pending
 *   tool approval is waiting on YOU (badge + bold title, hidden while the
 *   row is selected)
 *
 * Row actions live in the standard "…" menu: Close for open rows (releases
 * the column; the conversation survives), Delete for archived ones (behind
 * the destructive confirm).
 *
 * Selection mirrors what fills the plane: in Focus mode the active
 * session's row paints selected (one session IS the view); in Tile mode the
 * sidebar's Deck row carries selection instead.
 */

/** Archived conversations shown initially (and added per "Show more") —
 *  open rows never count against the page. */
const PAGE_SIZE = 10;

type SessionEntry =
  | { kind: 'open'; key: string; tab: CodeTab; ts: number }
  | { kind: 'archived'; key: string; conversation: ChatConversation; ts: number };

const useStyles = makeStyles({
  rowActions: {
    display: 'flex',
    alignItems: 'center',
  },
  /* Fixed gutter box so labels align whether or not a row shows presence
     (app columns don't) — the bare dot replaces the old chat glyph. */
  sessionIcon: {
    width: '20px',
    height: '20px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  /* Attention rows follow the unread convention: weight, not just a badge. */
  attentionLabel: {
    fontWeight: tokens.fontWeightSemibold,
  },
  /* Long titles ellipsize on one line (the ProjectRow idiom): the layout's
     main slot must be allowed to shrink before text-overflow can apply. */
  sessionItem: {
    '& .fui-TreeItemLayout__main': {
      flex: '1 1 auto',
      minWidth: 0,
      overflow: 'hidden',
    },
  },
  sessionLabel: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  showMore: {
    display: 'block',
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    paddingTop: '4px',
    paddingBottom: '4px',
    paddingLeft: '36px',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    textAlign: 'left',
    width: '100%',
    ':hover': { color: tokens.colorBrandForeground1 },
    ':focus-visible': {
      outline: `2px solid ${tokens.colorBrandStroke1}`,
      outlineOffset: '-2px',
    },
  },
  dangerMenuItem: {
    color: tokens.colorPaletteRedForeground1,
  },
});

const stopPropagation = (e: React.SyntheticEvent) => e.stopPropagation();

const SessionRow = memo(function SessionRow({
  entry,
  label,
  selected,
  onActivate,
  onClose,
  onRequestDelete,
}: {
  entry: SessionEntry;
  label: string;
  selected: boolean;
  onActivate: (entry: SessionEntry) => void;
  onClose: (id: CodeTabId) => void;
  onRequestDelete: (conversation: ChatConversation) => void;
}): React.JSX.Element {
  const styles = useStyles();
  const nav = useNavTreeStyles();
  const [menuOpen, setMenuOpen] = useState(false);
  const tabId = entry.kind === 'open' ? entry.tab.id : null;
  const activity = useStore($columnActivity, { keys: [tabId ?? ''] })[tabId ?? ''];
  const liveText = tabId ? activityStatusText(activity) : null;
  // Same presence semantics as agent DM rows: busy = working a turn,
  // available = live and idle, offline = not live. App columns (Browser,
  // Apps) aren't agent counterparties — no presence.
  const isAppColumn = entry.kind === 'open' && entry.tab.customAppId !== undefined;
  const presence: PresenceBadgeStatus | null =
    entry.kind === 'archived' ? 'offline' : isAppColumn ? null : activity?.thinking ? 'busy' : 'available';
  // The sessions equivalent of unread: an approval is waiting on the user.
  const attention = entry.kind === 'open' && activity?.pendingApproval === true;

  const handleClick = useCallback(() => onActivate(entry), [onActivate, entry]);
  const handleMenuOpenChange = useCallback((_e: unknown, data: { open: boolean }) => setMenuOpen(data.open), []);
  const handleClose = useCallback(() => {
    if (tabId) {
      onClose(tabId);
    }
  }, [onClose, tabId]);
  const handleDelete = useCallback(() => {
    if (entry.kind === 'archived') {
      onRequestDelete(entry.conversation);
    }
  }, [onRequestDelete, entry]);

  return (
    <TreeItem
      itemType="leaf"
      value={entry.key}
      className={mergeClasses(nav.navItem, styles.sessionItem, selected && nav.navItemSelected)}
      onClick={handleClick}
    >
      <TreeItemLayout
        iconBefore={
          <span className={styles.sessionIcon} title={liveText ?? undefined}>
            {presence && <PresenceBadge status={presence} size="extra-small" />}
          </span>
        }
        aside={
          !selected && attention ? (
            <span title="Waiting for your approval">
              <CounterBadge dot color="brand" />
            </span>
          ) : undefined
        }
        actions={{
          // Keep the menu visible while open so it doesn't vanish under the
          // popover (the shared sidebar-row idiom).
          visible: menuOpen || undefined,
          children: (
            <span
              role="presentation"
              className={styles.rowActions}
              onClick={stopPropagation}
              onMouseDown={stopPropagation}
            >
              <Menu
                open={menuOpen}
                onOpenChange={handleMenuOpenChange}
                positioning={{ position: 'below', align: 'end' }}
              >
                <MenuTrigger disableButtonEnhancement>
                  <IconButton aria-label={`${label} actions`} icon={<MoreHorizontal20Regular />} size="sm" />
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    {entry.kind === 'open' ? (
                      <MenuItem icon={<Dismiss20Regular />} onClick={handleClose}>
                        Close
                      </MenuItem>
                    ) : (
                      <MenuItem icon={<Delete20Regular />} className={styles.dangerMenuItem} onClick={handleDelete}>
                        Delete…
                      </MenuItem>
                    )}
                  </MenuList>
                </MenuPopover>
              </Menu>
            </span>
          ),
        }}
      >
        <span className={mergeClasses(styles.sessionLabel, attention && styles.attentionLabel)} title={label}>
          {label}
        </span>
      </TreeItemLayout>
    </TreeItem>
  );
});

export function SessionsSection({ onNavigate }: { onNavigate?: () => void }): React.JSX.Element {
  const styles = useStyles();
  const nav = useNavTreeStyles();
  const store = useStore(persistedStoreApi.$atom);
  const columnActivity = useStore($columnActivity);
  const tabs = useMemo(() => store.codeTabs ?? [], [store.codeTabs]);
  const { recent, sessionTitles } = useRecentConversations(tabs);

  const projectLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of store.projects) {
      map.set(p.id, p.label);
    }
    return map;
  }, [store.projects]);
  const customApps = useMemo(() => store.customApps ?? [], [store.customApps]);

  // Same resolution the deck uses for column titles (identity must match
  // between the sidebar row and the column it opens).
  const resolveLabel = useCallback(
    (entry: SessionEntry): string => {
      if (entry.kind === 'archived') {
        return entry.conversation.title;
      }
      const tab = entry.tab;
      if (tab.customAppId === APP_LAUNCHER_ID) {
        return 'Apps';
      }
      if (tab.customAppId === 'browser') {
        return 'Browser';
      }
      if (tab.customAppId) {
        return customApps.find((a) => a.id === tab.customAppId)?.label ?? 'App';
      }
      if (!tab.projectId) {
        return (tab.sessionId ? sessionTitles.get(tab.sessionId) : undefined) ?? 'New chat';
      }
      return projectLabels.get(tab.projectId) ?? 'Unknown';
    },
    [customApps, sessionTitles, projectLabels]
  );

  // ONE list, recency-sorted; open and archived interleave honestly.
  // Empty chats stay out: a chat column earns its row when its session
  // becomes a conversation (first message titles it). The pristine landing
  // column in particular never shows. Bound columns (apps, projects,
  // tickets, routines) always have identities and always list.
  const entries = useMemo((): SessionEntry[] => {
    const isEmptyChat = (tab: CodeTab): boolean =>
      !tab.projectId &&
      !tab.customAppId &&
      !tab.ticketId &&
      !tab.routineId &&
      (!tab.sessionId || !sessionTitles.has(tab.sessionId));
    const open: SessionEntry[] = tabs
      .filter((tab) => !isEmptyChat(tab))
      .map((tab) => ({ kind: 'open', key: tab.id, tab, ts: tab.createdAt }));
    const archived: SessionEntry[] = recent.map((conversation) => ({
      kind: 'archived',
      key: `recent:${conversation.sessionId}`,
      conversation,
      ts: conversation.lastActiveAt,
    }));
    return [...open, ...archived].sort((a, b) => b.ts - a.ts);
  }, [tabs, recent, sessionTitles]);

  // Paging budgets archived rows only — open rows are never hidden behind
  // the fold, wherever recency sorts them.
  const [archivedVisible, setArchivedVisible] = useState(PAGE_SIZE);
  const handleShowMore = useCallback(() => setArchivedVisible((count) => count + PAGE_SIZE), []);
  const visibleEntries = useMemo(() => {
    let archivedBudget = archivedVisible;
    return entries.filter((entry) => {
      if (entry.kind === 'open') {
        return true;
      }
      if (archivedBudget > 0) {
        archivedBudget -= 1;
        return true;
      }
      return false;
    });
  }, [entries, archivedVisible]);
  const archivedHidden = Math.max(0, recent.length - archivedVisible);

  const activeTabId = store.activeCodeTabId ?? tabs[0]?.id ?? null;
  // Selection mirrors what fills the plane (see module doc).
  const selectedKey = store.layoutMode === 'chat' && (store.codeLayoutMode ?? 'tile') === 'focus' ? activeTabId : null;

  const raiseDeck = useCallback(() => {
    if (persistedStoreApi.$atom.get().layoutMode !== 'chat') {
      persistedStoreApi.setKey('layoutMode', 'chat');
    }
  }, []);

  // "Take me to this conversation" — whether that means activating a column
  // or materializing one from the archive is the app's business.
  const handleActivate = useCallback(
    (entry: SessionEntry) => {
      if (entry.kind === 'open') {
        codeApi.setActiveTab(entry.tab.id);
      } else {
        void codeApi.addTabForConversation(entry.conversation);
      }
      raiseDeck();
      onNavigate?.();
    },
    [raiseDeck, onNavigate]
  );
  const handleClose = useCallback((id: CodeTabId) => {
    // Deck-local per-column state (widths, sidecars) keys by id and goes
    // inert with it — the store-level close is all a remote close needs.
    codeApi.removeTab(id);
  }, []);
  // The deck is a VIEW over the open sessions (all columns at once), not a
  // destination — so it lives here as a view affordance, not a nav row.
  const handleDeckView = useCallback(() => {
    codeApi.setLayoutMode('tile');
    raiseDeck();
    onNavigate?.();
  }, [raiseDeck, onNavigate]);
  const handleNewChat = useCallback(() => {
    void codeApi.openFreshChat();
    raiseDeck();
    onNavigate?.();
  }, [raiseDeck, onNavigate]);

  const [pendingDelete, setPendingDelete] = useState<ChatConversation | null>(null);
  const handleRequestDelete = useCallback((conversation: ChatConversation) => setPendingDelete(conversation), []);
  const closeDelete = useCallback(() => setPendingDelete(null), []);
  const confirmDelete = useCallback(() => {
    if (pendingDelete) {
      void codeApi.deleteConversation(pendingDelete.sessionId);
    }
  }, [pendingDelete]);

  // Aggregate attention for the collapsed header: approvals waiting on you.
  const attentionCount = entries.filter(
    (entry) => entry.kind === 'open' && columnActivity[entry.tab.id]?.pendingApproval === true
  ).length;

  return (
    <>
      <NavSection
        id="sessions"
        label="Sessions"
        collapsedBadge={attentionCount}
        actions={
          <>
            <IconButton
              aria-label="Open deck view"
              icon={<ColumnTriple20Regular />}
              size="sm"
              onClick={handleDeckView}
            />
            <IconButton aria-label="New chat" icon={<Add20Regular />} size="sm" onClick={handleNewChat} />
          </>
        }
      >
        {visibleEntries.length > 0 && (
          <Tree aria-label="Sessions" className={nav.tree}>
            {visibleEntries.map((entry) => (
              <SessionRow
                key={entry.key}
                entry={entry}
                label={resolveLabel(entry)}
                selected={selectedKey === entry.key}
                onActivate={handleActivate}
                onClose={handleClose}
                onRequestDelete={handleRequestDelete}
              />
            ))}
          </Tree>
        )}
        {archivedHidden > 0 && (
          <button type="button" className={styles.showMore} onClick={handleShowMore}>
            Show more ({archivedHidden})
          </button>
        )}
      </NavSection>
      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={closeDelete}
        onConfirm={confirmDelete}
        title={`Delete "${pendingDelete?.title ?? ''}"?`}
        description="The conversation and its history are removed. This action cannot be undone."
        confirmLabel="Delete"
        destructive
      />
    </>
  );
}
