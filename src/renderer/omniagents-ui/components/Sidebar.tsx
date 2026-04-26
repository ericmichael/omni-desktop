import {
  Button,
  Caption1,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  makeStyles,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  NavDrawer,
  NavDrawerBody,
  NavDrawerHeader,
  NavItem,
  NavSectionHeader,
  SearchBox,
  Subtitle2,
  tokens,
  Tooltip,
} from '@fluentui/react-components';
import {
  Add20Regular,
  Chat48Regular,
  Delete20Regular,
  Dismiss20Regular,
  MoreHorizontal20Regular,
} from '@fluentui/react-icons';
import { useEffect, useMemo, useState } from 'react';

import { formatRelativeTime, generateSessionTitle } from '@/renderer/omniagents-ui/lib/utils';

import type { SessionItem } from './SessionList';

// Pick desktop vs mobile layout via matchMedia rather than relying on
// `hidden md:flex` / `md:hidden` utilities. Those patterns are broken in this
// app because a pre-compiled shadcn/ai-elements CSS bundle ships a plain
// `.hidden{display:none}` rule that loads AFTER Tailwind v4's output and wins
// the cascade over `.md:flex`, so the desktop-inline sidebar would stay
// `display: none` at every viewport size.
function useIsDesktop(breakpointPx = 768): boolean {
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined'
      ? window.matchMedia(`(min-width: ${breakpointPx}px)`).matches
      : true
  );
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const mql = window.matchMedia(`(min-width: ${breakpointPx}px)`);
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [breakpointPx]);
  return isDesktop;
}

// ── Date bucketing — matches ChatGPT / Claude conventions ─────────────────
type Bucket = 'today' | 'yesterday' | 'previous7' | 'previous30' | 'older';
const BUCKET_LABELS: Record<Bucket, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  previous7: 'Previous 7 days',
  previous30: 'Previous 30 days',
  older: 'Older',
};
const BUCKET_ORDER: Bucket[] = ['today', 'yesterday', 'previous7', 'previous30', 'older'];

function sessionTimestamp(s: SessionItem): number {
  const raw = (s as { last_message?: { timestamp?: string }; created_at?: string }).last_message?.timestamp
    ?? (s as { created_at?: string }).created_at
    ?? '';
  const n = Date.parse(raw);
  return Number.isNaN(n) ? 0 : n;
}

function bucketFor(ts: number): Bucket {
  const now = Date.now();
  const dayMs = 24 * 3600 * 1000;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();
  const yesterdayStartMs = todayStartMs - dayMs;
  if (ts >= todayStartMs) {
    return 'today';
  }
  if (ts >= yesterdayStartMs) {
    return 'yesterday';
  }
  if (now - ts < 7 * dayMs) {
    return 'previous7';
  }
  if (now - ts < 30 * dayMs) {
    return 'previous30';
  }
  return 'older';
}

const useStyles = makeStyles({
  /* Drawer sizes: NavDrawer defaults to 260px; we bump to 288px to match the
     prior design and give room for two-line items.

     Explicit bg1 to match the Settings and Projects sidebars. NavDrawer's
     default (from @fluentui/react-drawer) is also bg1, but in this tree it
     ends up picking up a darker hover/selected layer — forcing bg1 here
     aligns it with the other internal sidebars. */
  drawer: {
    minWidth: '288px',
    maxWidth: '288px',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  /* 24px top to match the Settings sidebar and app nav rail. */
  headerStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    paddingTop: tokens.spacingVerticalXXL,
    paddingBottom: tokens.spacingVerticalL,
  },
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
  },
  headerActions: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
  },
  /* Session row = NavItem + kebab Menu side-by-side. NavItem takes the
     remaining flex space; kebab button appears on row hover/focus (the
     :focus-within branch keeps it visible during keyboard nav). */
  sessionRow: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    '&:hover [data-reveal="kebab"], &:focus-within [data-reveal="kebab"]': {
      opacity: 1,
    },
  },
  sessionNavItem: {
    flex: '1 1 0',
    minWidth: 0,
  },
  sessionLabel: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    gap: '2px',
  },
  sessionTitle: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  sessionMeta: {
    color: tokens.colorNeutralForeground3,
  },
  kebabWrap: {
    position: 'absolute',
    top: '50%',
    right: tokens.spacingHorizontalXS,
    transform: 'translateY(-50%)',
    opacity: 0,
    transitionProperty: 'opacity',
    transitionDuration: '150ms',
  },
  /* Empty + no-match states */
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: tokens.colorNeutralForeground3,
    paddingLeft: tokens.spacingHorizontalXL,
    paddingRight: tokens.spacingHorizontalXL,
    paddingTop: tokens.spacingVerticalXL,
    paddingBottom: tokens.spacingVerticalXL,
    textAlign: 'center',
  },
  emptyIcon: {
    marginBottom: tokens.spacingVerticalS,
    opacity: 0.5,
  },
  noMatches: {
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
    paddingTop: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalM,
  },
});

export function Sidebar({
  open,
  sessions,
  selectedId,
  onClose,
  onNewChat,
  onSelect,
  onDelete,
}: {
  open: boolean;
  sessions: SessionItem[];
  selectedId?: string;
  onClose: () => void;
  onNewChat: () => void;
  onSelect: (id: string) => void;
  onDelete?: (id: string) => void;
}) {
  const styles = useStyles();
  const [searchQuery, setSearchQuery] = useState('');
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const isDesktop = useIsDesktop();

  const nonEmpty = useMemo(
    () => sessions.filter((s) => s.message_count > 0),
    [sessions],
  );

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) {
      return nonEmpty;
    }
    return nonEmpty.filter((s) => {
      const title = generateSessionTitle(s).toLowerCase();
      return title.includes(q) || s.id.toLowerCase().includes(q);
    });
  }, [nonEmpty, searchQuery]);

  /* Group by bucket, sort each bucket newest-first. */
  const grouped = useMemo(() => {
    const buckets: Record<Bucket, SessionItem[]> = {
      today: [],
      yesterday: [],
      previous7: [],
      previous30: [],
      older: [],
    };
    for (const s of filtered) {
      buckets[bucketFor(sessionTimestamp(s))].push(s);
    }
    for (const bucket of BUCKET_ORDER) {
      buckets[bucket].sort((a, b) => sessionTimestamp(b) - sessionTimestamp(a));
    }
    return buckets;
  }, [filtered]);

  const handleSelect = (id: string) => {
    onSelect(id);
    if (!isDesktop) {
      onClose();
    }
  };

  const confirmDelete = () => {
    if (deleteTargetId && onDelete) {
      onDelete(deleteTargetId);
    }
    setDeleteTargetId(null);
  };

  const renderSessionRow = (s: SessionItem) => {
    const title = generateSessionTitle(s);
    const timestamp = formatRelativeTime(
      (s as { last_message?: { timestamp?: string } }).last_message?.timestamp ?? (s as { created_at?: string }).created_at,
    );

    return (
      <div key={s.id} className={styles.sessionRow}>
        <NavItem
          className={styles.sessionNavItem}
          value={s.id}
          onClick={() => handleSelect(s.id)}
        >
          <div className={styles.sessionLabel}>
            <span className={styles.sessionTitle}>{title}</span>
            <Caption1 className={styles.sessionMeta}>
              {timestamp}
              {s.message_count > 0 ? ` · ${s.message_count} ${s.message_count === 1 ? 'message' : 'messages'}` : ''}
            </Caption1>
          </div>
        </NavItem>
        {onDelete ? (
          <div data-reveal="kebab" className={styles.kebabWrap}>
            <Menu>
              <MenuTrigger disableButtonEnhancement>
                <Button
                  appearance="subtle"
                  size="small"
                  icon={<MoreHorizontal20Regular />}
                  aria-label="More actions"
                />
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  <MenuItem
                    icon={<Delete20Regular />}
                    onClick={() => setDeleteTargetId(s.id)}
                  >
                    Delete conversation
                  </MenuItem>
                </MenuList>
              </MenuPopover>
            </Menu>
          </div>
        ) : null}
      </div>
    );
  };

  const hasAnySession = nonEmpty.length > 0;
  const hasResults = filtered.length > 0;

  return (
    <>
      <NavDrawer
        className={styles.drawer}
        type={isDesktop ? 'inline' : 'overlay'}
        open={open}
        onOpenChange={(_e, d) => {
          if (!d.open) {
            onClose();
          }
        }}
        selectedValue={selectedId}
        density="small"
        separator
      >
        <NavDrawerHeader>
          <div className={styles.headerStack}>
            <div className={styles.headerRow}>
              <Subtitle2>Conversations</Subtitle2>
              <div className={styles.headerActions}>
                <Tooltip content="New chat" relationship="label">
                  <Button
                    appearance="subtle"
                    size="small"
                    icon={<Add20Regular />}
                    aria-label="New chat"
                    onClick={onNewChat}
                  />
                </Tooltip>
                <Button
                  appearance="subtle"
                  size="small"
                  icon={<Dismiss20Regular />}
                  aria-label="Close sidebar"
                  onClick={onClose}
                />
              </div>
            </div>
            {hasAnySession ? (
              <SearchBox
                placeholder="Search conversations…"
                value={searchQuery}
                onChange={(_e, data) => setSearchQuery(data.value ?? '')}
              />
            ) : null}
          </div>
        </NavDrawerHeader>

        <NavDrawerBody>
          {!hasAnySession ? (
            <div className={styles.emptyState}>
              <Chat48Regular className={styles.emptyIcon} />
              <div>No conversations yet</div>
              <Caption1>Start chatting to create your first session</Caption1>
            </div>
          ) : !hasResults ? (
            <div className={styles.noMatches}>No matching conversations</div>
          ) : (
            BUCKET_ORDER.flatMap((bucket) => {
              const items = grouped[bucket];
              if (items.length === 0) {
                return [];
              }
              return [
                <NavSectionHeader key={`h-${bucket}`}>{BUCKET_LABELS[bucket]}</NavSectionHeader>,
                ...items.map(renderSessionRow),
              ];
            })
          )}
        </NavDrawerBody>
      </NavDrawer>

      <Dialog
        open={deleteTargetId !== null}
        onOpenChange={(_e, data) => {
          if (!data.open) {
            setDeleteTargetId(null);
          }
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete conversation?</DialogTitle>
            <DialogContent>
              This conversation will be permanently deleted. You can&apos;t undo this.
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="secondary">Cancel</Button>
              </DialogTrigger>
              <Button appearance="primary" onClick={confirmDelete}>
                Delete
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}

export default Sidebar;
