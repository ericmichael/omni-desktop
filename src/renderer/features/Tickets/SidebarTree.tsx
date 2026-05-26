// Board20/Flag20 are kept because they render inside MenuPopover action menus,
// which want the larger 20px icon size. The tree's iconBefore slot uses 16px.
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  Add16Regular,
  Board16Regular,
  Board20Regular,
  Checkmark12Regular,
  ChevronRight16Regular,
  Delete20Regular,
  Document16Regular,
  DocumentMultiple16Regular,
  DocumentText16Regular,
  Edit20Regular,
  Flag16Regular,
  Flag20Regular,
  Folder16Regular,
  Globe16Regular,
  Link16Regular,
  MoreHorizontal16Regular,
  Notebook20Regular,
  Open20Regular,
  Pin16Filled,
  Pin16Regular,
  Play20Filled,
  Settings20Regular,
  TaskListSquareLtr16Regular,
} from '@fluentui/react-icons';
import { memo, useCallback, useMemo, useRef, useState } from 'react';

import type { TreeItemOpenChangeData } from '@/renderer/ds';
import {
  Input,
  Menu,
  MenuDivider,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Tree,
  TreeItem,
  TreeItemLayout,
} from '@/renderer/ds';
import { milestoneApi } from '@/renderer/features/Initiatives/state';
import { pageApi } from '@/renderer/features/Pages/state';
import { openTicketInCode } from '@/renderer/services/navigation';
import { isActivePhase } from '@/shared/ticket-phase';
import type { Milestone, Page, PageId, Project, ProjectId, Ticket } from '@/shared/types';

import { ticketApi } from './state';

const useStyles = makeStyles({
  tree: {
    paddingTop: '2px',
    paddingBottom: '2px',
    /**
     * Tighten Fluent's per-level indent. Fluent's TreeItemLayout computes
     * left-padding as `level × var(--spacingHorizontalXXL)` (default 20px).
     * Overriding the variable locally on the tree root scales every nesting
     * level down at once and preserves Fluent's leaf-vs-branch alignment
     * logic, since both calcs use this same variable.
     */
    '--spacingHorizontalXXL': '12px',
    /**
     * Fluent's expandIcon column has a hard-coded min-width of 24px. With
     * the variable above at 12px, a level-N leaf gets N×12px padding while
     * a level-N branch gets (N-1)×12 + 24 = N×12 + 12 — branches end up
     * 12px further right than their sibling leaves. Shrinking the chevron
     * column to one indent step (12px) makes the math balance.
     */
    '& .fui-TreeItemLayout__expandIcon': {
      minWidth: '12px',
    },
  },
  liveDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    backgroundColor: tokens.colorPaletteGreenForeground1,
    flexShrink: 0,
  },
  badge: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
  },
  icon: {
    flexShrink: 0,
  },
  /**
   * Icon box for user-picked page emoji. Sized to match the tree's 16px icon
   * column so emoji pages line up vertically with icon-based siblings. Emoji
   * fonts render slightly larger than their font-size, so we use 13px inside
   * a 16px square for visual parity.
   */
  emojiIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '16px',
    height: '16px',
    fontSize: '13px',
    lineHeight: 1,
    flexShrink: 0,
  },
  renameInput: {
    width: '100%',
    minWidth: 0,
  },
  /**
   * Truncation wrapper for all user-editable text in the tree: project label,
   * milestone title, ticket title, page title. Fluent's TreeItemLayout slot
   * is flex, so truncation requires both min-width: 0 (to allow shrink) and
   * the standard overflow/ellipsis/nowrap trio on the inner span.
   */
  truncate: {
    display: 'block',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /**
   * Flex row for a title + trailing inline metadata (e.g. count badge).
   * The title truncates, the trailing span stays pinned on the right.
   */
  titleRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
  },
  titleRowMain: {
    flex: '0 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  titleRowTrail: {
    flexShrink: 0,
  },
  aside: {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    opacity: 0,
    ':hover > &': {
      opacity: 1,
    },
  },
  /** Applied to tree items so :hover reveals action buttons. */
  hoverableItem: {
    '&:hover .action-buttons': {
      opacity: 1,
      width: 'auto',
    },
    /**
     * Fluent's TreeItemLayout main slot only sets padding — it doesn't claim
     * remaining space or allow flex-shrink, so long titles push the whole row
     * past the sidebar edge. Force it to grow and permit shrinking so our
     * inner `truncate` span can actually ellipsize.
     */
    '& .fui-TreeItemLayout__main': {
      flex: '1 1 auto',
      minWidth: 0,
      overflow: 'hidden',
    },
  },
  actionButtons: {
    display: 'flex',
    alignItems: 'center',
    gap: '0px',
    /**
     * Collapsed to zero width by default so the label can use the full
     * remaining row width. On row hover (handled in `hoverableItem`) the
     * width expands to `auto`, the buttons fade in, and the label
     * truncates if it would now overflow.
     */
    width: 0,
    overflow: 'hidden',
    opacity: 0,
    transition: 'opacity 0.1s',
  },
  tinyBtn: {
    minWidth: 0,
    width: '22px',
    height: '22px',
    padding: 0,
  },
  sourceLabel: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  nativeBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '22px',
    height: '22px',
    padding: 0,
    border: 'none',
    backgroundColor: 'transparent',
    borderRadius: tokens.borderRadiusCircular,
    cursor: 'pointer',
    color: tokens.colorNeutralForeground2,
    ':hover': {
      backgroundColor: tokens.colorSubtleBackgroundHover,
      color: tokens.colorNeutralForeground1,
    },
  },
  /**
   * Pin slot. When the entity is pinned it sits outside the hover-revealed
   * action group and stays visible at all times in brand color, so the user
   * can see what's pinned at a glance. When unpinned it sits inside the
   * hover group via `actionButtons` and follows that opacity transition.
   */
  pinSlotVisible: {
    display: 'inline-flex',
    alignItems: 'center',
    color: tokens.colorBrandForeground1,
  },
  /**
   * Applied alongside `hoverableItem` on branch rows. Hides Fluent's native
   * expand chevron's glyph (visibility:hidden, not display:none) so its
   * column stays reserved and branch rows align with leaf rows. The custom
   * chevron stacked inside `iconBefore` (via `BranchIcon`) is the actual
   * toggle target — it sits on top of the row's icon, visible on hover, and
   * rotates 90° when the row is expanded (driven by aria-expanded).
   *
   * Every rule scopes to `> .fui-TreeItemLayout` so it only affects this
   * row's own chevron, never a descendant branch's. The hover rules also
   * use `:not(:has(.hoverableBranch:hover))` so only the innermost hovered
   * branch shows its chevron — otherwise hovering a child would light up
   * every ancestor chevron in the chain.
   */
  hoverableBranch: {
    '& > .fui-TreeItemLayout .fui-TreeItemLayout__expandIcon': {
      visibility: 'hidden',
    },
    '&:hover:not(:has(.hoverableBranch:hover)) > .fui-TreeItemLayout .branch-icon-default': {
      opacity: 0,
    },
    '&:hover:not(:has(.hoverableBranch:hover)) > .fui-TreeItemLayout .branch-icon-chevron': {
      opacity: 1,
    },
    '&[aria-expanded="true"] > .fui-TreeItemLayout .branch-icon-chevron': {
      transform: 'translate(-50%, -50%) rotate(90deg)',
    },
  },
  /**
   * Stack wrapper for the swap-icon used as iconBefore on branch rows. The
   * row's actual icon and the chevron share this 16px square — only one is
   * visible at a time, toggled via the parent `.hoverableBranch:hover` rule.
   */
  branchIconStack: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '16px',
    height: '16px',
    flexShrink: 0,
  },
  branchIconDefault: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    transitionProperty: 'opacity',
    transitionDuration: tokens.durationFaster,
  },
  branchIconChevron: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    opacity: 0,
    transitionProperty: 'opacity, transform',
    transitionDuration: tokens.durationFaster,
    pointerEvents: 'none',
  },
});

const stopPropagation = (e: React.SyntheticEvent) => e.stopPropagation();

/**
 * Stacked icon used as `iconBefore` on branch rows. The supplied icon shows
 * by default; on row hover the chevron fades in on top of it (via the
 * `hoverableBranch` parent class). Clicking the stack toggles expand state —
 * Fluent's native chevron is visually hidden, so this is the real toggle.
 */
const BranchIcon = memo(
  ({ icon, value, onToggle }: { icon: React.ReactNode; value: string; onToggle: (value: string) => void }) => {
    const styles = useStyles();
    const handleClick = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        onToggle(value);
      },
      [value, onToggle]
    );
    return (
      <span role="presentation" className={styles.branchIconStack} onMouseDown={stopPropagation} onClick={handleClick}>
        <span className={`branch-icon-default ${styles.branchIconDefault}`}>{icon}</span>
        <ChevronRight16Regular className={`branch-icon-chevron ${styles.branchIconChevron}`} />
      </span>
    );
  }
);
BranchIcon.displayName = 'BranchIcon';

/** Shorten a local path to the last 2 segments (e.g. ~/projects/my-app → projects/my-app). */
function shortenPath(fullPath: string): string {
  const parts = fullPath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 2) {
    return fullPath;
  }
  return parts.slice(-2).join('/');
}

/** Shorten a git remote URL to org/repo (e.g. https://github.com/org/repo.git → org/repo). */
function shortenRepoUrl(url: string): string {
  try {
    const cleaned = url.replace(/\.git$/, '');
    const parsed = new URL(cleaned);
    return parsed.pathname.replace(/^\//, '');
  } catch {
    // Not a valid URL — try extracting from ssh-style (git@host:org/repo.git)
    const sshMatch = url.match(/:([^/].*?)(?:\.git)?$/);
    if (sshMatch) {
      return sshMatch[1]!;
    }
    return url;
  }
}

type SidebarTreeProps = {
  projects: Project[];
  pages: Record<string, Page>;
  milestones: Record<string, Milestone>;
  tickets: Record<string, Ticket>;
  selectedValue?: string;
  onSelect: (value: string) => void;
  /** Called when a project node is expanded (to trigger data fetch). */
  onExpandProject?: (projectId: ProjectId) => void;
  /** Called when user requests a new milestone for a project. */
  onCreateMilestone?: (projectId: ProjectId) => void;
  /** Called when user requests to edit an existing milestone. */
  onEditMilestone?: (milestone: Milestone) => void;
  /** Called when user requests to add a source to a project. */
  onAddSource?: (projectId: ProjectId) => void;
  /** Called when user requests to remove a source from a project. */
  onRemoveSource?: (projectId: ProjectId, sourceId: string) => void;
};

/** Build child pages for a given parentId, sorted by sortOrder. */
function getChildPages(pages: Record<string, Page>, parentId: PageId): Page[] {
  return Object.values(pages)
    .filter((p) => p.parentId === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

// ─── Inline rename hook ──────────────────────────────────────────────────────

function useInlineRename() {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const startRename = useCallback((id: string, currentTitle: string) => {
    setRenamingId(id);
    setRenameValue(currentTitle);
  }, []);

  const cancelRename = useCallback(() => {
    setRenamingId(null);
    setRenameValue('');
  }, []);

  return { renamingId, renameValue, setRenameValue, startRename, cancelRename };
}

// ─── Page tree item (recursive) ──────────────────────────────────────────────

const PageTreeItem = memo(
  ({
    page,
    pages,
    onSelect,
    renamingId,
    renameValue,
    setRenameValue,
    onStartRename,
    onFinishRename,
    onCancelRename,
    onItemClick,
    onToggle,
  }: {
    page: Page;
    pages: Record<string, Page>;
    onSelect: (value: string) => void;
    renamingId: string | null;
    renameValue: string;
    setRenameValue: (v: string) => void;
    onStartRename: (id: string, title: string) => void;
    onFinishRename: (id: string, newTitle: string) => void;
    onCancelRename: () => void;
    /** Click handler that guards against double-fire with onOpenChange */
    onItemClick: (value: string) => void;
    /** Toggle a branch open/closed without navigating. */
    onToggle: (value: string) => void;
  }) => {
    const styles = useStyles();
    const children = getChildPages(pages, page.id);
    const hasChildren = children.length > 0;
    const value = `page:${page.id}:${page.projectId}`;
    const isRenaming = renamingId === page.id;

    const handleDelete = useCallback(() => {
      void pageApi.removePage(page.id);
    }, [page.id]);

    const handleRenameKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
          onFinishRename(page.id, renameValue);
        } else if (e.key === 'Escape') {
          onCancelRename();
        }
      },
      [page.id, renameValue, onFinishRename, onCancelRename]
    );

    const actionButtons = (
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions
      <span
        className={`action-buttons ${styles.actionButtons}`}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          aria-label="Add sub-page"
          className={styles.nativeBtn}
          onClick={(e) => {
            e.stopPropagation();
            const siblings = Object.values(pages).filter((p) => p.parentId === page.id);
            const maxSort = siblings.reduce((max, p) => Math.max(max, p.sortOrder), 0);
            void pageApi
              .addPage({ projectId: page.projectId, parentId: page.id, title: 'Untitled', sortOrder: maxSort + 1 })
              .then((newPage) => onSelect(`page:${newPage.id}:${newPage.projectId}`));
          }}
        >
          <Add16Regular />
        </button>
        <Menu positioning={{ position: 'below', align: 'end' }}>
          <MenuTrigger>
            <button type="button" aria-label="Page actions" className={styles.nativeBtn}>
              <MoreHorizontal16Regular />
            </button>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              <MenuItem icon={<Edit20Regular />} onClick={() => onStartRename(page.id, page.title)}>
                Rename
              </MenuItem>
              <MenuDivider />
              <MenuItem icon={<Delete20Regular />} onClick={handleDelete}>
                Delete
              </MenuItem>
            </MenuList>
          </MenuPopover>
        </Menu>
      </span>
    );

    const pageIconNode = page.icon ? (
      <span className={styles.emojiIcon}>{page.icon}</span>
    ) : (
      <DocumentText16Regular className={styles.icon} />
    );

    return (
      <TreeItem
        itemType={hasChildren ? 'branch' : 'leaf'}
        value={value}
        className={mergeClasses(styles.hoverableItem, hasChildren && styles.hoverableBranch)}
        onClick={() => onItemClick(value)}
      >
        <TreeItemLayout
          iconBefore={hasChildren ? <BranchIcon icon={pageIconNode} value={value} onToggle={onToggle} /> : pageIconNode}
          aside={actionButtons}
          onDoubleClick={() => onStartRename(page.id, page.title)}
        >
          {isRenaming ? (
            // eslint-disable-next-line jsx-a11y/no-static-element-interactions
            <span onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
              <Input
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={handleRenameKeyDown}
                onBlur={() => onFinishRename(page.id, renameValue)}
                className={styles.renameInput}
                size="sm"
                autoFocus
              />
            </span>
          ) : (
            <span className={styles.truncate}>{page.title || 'Untitled'}</span>
          )}
        </TreeItemLayout>
        {hasChildren && (
          <Tree>
            {children.map((child) => (
              <PageTreeItem
                key={child.id}
                page={child}
                pages={pages}
                onSelect={onSelect}
                renamingId={renamingId}
                renameValue={renameValue}
                setRenameValue={setRenameValue}
                onStartRename={onStartRename}
                onFinishRename={onFinishRename}
                onCancelRename={onCancelRename}
                onItemClick={onItemClick}
                onToggle={onToggle}
              />
            ))}
          </Tree>
        )}
      </TreeItem>
    );
  }
);
PageTreeItem.displayName = 'PageTreeItem';

// ─── Ticket tree item ────────────────────────────────────────────────────────

const TicketTreeItem = memo(
  ({
    ticket,
    onSelect,
    onItemClick,
  }: {
    ticket: Ticket;
    onSelect: (value: string) => void;
    onItemClick: (value: string) => void;
  }) => {
    const styles = useStyles();
    const phase = ticket.phase;
    const isRunning = phase != null && isActivePhase(phase);
    const value = `ticket:${ticket.id}`;

    const actionButtons = (
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions
      <span
        className={`action-buttons ${styles.actionButtons}`}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {isRunning && <span className={styles.liveDot} />}
        <Menu positioning={{ position: 'below', align: 'end' }}>
          <MenuTrigger>
            <button type="button" aria-label="Ticket actions" className={styles.nativeBtn}>
              <MoreHorizontal16Regular />
            </button>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              <MenuItem icon={<Open20Regular />} onClick={() => void openTicketInCode(ticket.id)}>
                Open in Code
              </MenuItem>
              {!isRunning && !ticket.resolution && (
                <MenuItem
                  icon={<Play20Filled />}
                  onClick={() => {
                    void ticketApi.startSupervisor(ticket.id);
                  }}
                >
                  Start autopilot
                </MenuItem>
              )}
            </MenuList>
          </MenuPopover>
        </Menu>
      </span>
    );

    return (
      <TreeItem itemType="leaf" value={value} className={styles.hoverableItem} onClick={() => onItemClick(value)}>
        <TreeItemLayout
          iconBefore={<Document16Regular className={styles.icon} />}
          aside={isRunning ? <span className={styles.liveDot} /> : actionButtons}
        >
          <span className={styles.truncate}>{ticket.title}</span>
        </TreeItemLayout>
      </TreeItem>
    );
  }
);
TicketTreeItem.displayName = 'TicketTreeItem';

// ─── Main tree ───────────────────────────────────────────────────────────────

export const SidebarTree = memo(
  ({
    projects,
    pages,
    milestones,
    tickets,
    onSelect,
    onExpandProject,
    onCreateMilestone,
    onEditMilestone,
    onAddSource,
    onRemoveSource,
  }: SidebarTreeProps) => {
    const styles = useStyles();
    const [openItems, setOpenItems] = useState<Set<string>>(new Set());
    const rename = useInlineRename();
    // Track whether onOpenChange already handled navigation for this click
    const handledByOpenChange = useRef(false);

    const handleOpenChange = useCallback(
      (_e: unknown, data: TreeItemOpenChangeData) => {
        const value = data.value as string;
        const isChevronClick = (data as { type?: string }).type === 'ExpandIconClick';

        if (isChevronClick) {
          // Chevron: just toggle open/close, no navigation
          setOpenItems((prev) => {
            const next = new Set(prev);
            if (data.open) {
              next.add(value);
            } else {
              next.delete(value);
            }
            return next;
          });
          // Fetch data when expanding a project
          if (data.open && value.startsWith('project:')) {
            onExpandProject?.(value.slice(8));
          }
        } else {
          // Label click on a branch: always open (never toggle closed) + navigate
          setOpenItems((prev) => {
            if (prev.has(value)) {
              return prev;
            }
            const next = new Set(prev);
            next.add(value);
            return next;
          });
          onSelect(value);
          handledByOpenChange.current = true;
          // Reset after this event cycle
          requestAnimationFrame(() => {
            handledByOpenChange.current = false;
          });
        }
      },
      [onSelect, onExpandProject]
    );

    /** Toggle a branch's open state without navigating. Used by `BranchIcon`
     *  in place of Fluent's native chevron (which is visually hidden). */
    const handleToggle = useCallback(
      (value: string) => {
        setOpenItems((prev) => {
          const next = new Set(prev);
          if (next.has(value)) {
            next.delete(value);
          } else {
            next.add(value);
            if (value.startsWith('project:')) {
              onExpandProject?.(value.slice(8));
            }
          }
          return next;
        });
      },
      [onExpandProject]
    );

    /** For leaf items that don't fire onOpenChange */
    const handleItemClick = useCallback(
      (value: string) => {
        if (!handledByOpenChange.current) {
          onSelect(value);
        }
      },
      [onSelect]
    );

    const handleFinishRename = useCallback(
      (pageId: string, newTitle: string) => {
        const trimmed = newTitle.trim();
        if (trimmed) {
          void pageApi.updatePage(pageId, { title: trimmed });
        }
        rename.cancelRename();
      },
      [rename]
    );

    // Group milestones and tickets by project
    const projectData = useMemo(() => {
      const result: Record<
        ProjectId,
        {
          milestones: Milestone[];
          ticketsByMilestone: Record<string, Ticket[]>;
          looseTickets: Ticket[];
          rootPages: Page[];
          activeTicketCount: number;
        }
      > = {};

      for (const project of projects) {
        const projectMilestones = Object.values(milestones)
          .filter((m) => m.projectId === project.id && m.status === 'active')
          .sort((a, b) => a.createdAt - b.createdAt);

        const projectTickets = Object.values(tickets).filter(
          (t) => t.projectId === project.id && !t.resolution && !t.archivedAt
        );

        const ticketsByMilestone: Record<string, Ticket[]> = {};
        const looseTickets: Ticket[] = [];
        for (const ticket of projectTickets) {
          if (ticket.milestoneId) {
            const list = ticketsByMilestone[ticket.milestoneId] ?? [];
            list.push(ticket);
            ticketsByMilestone[ticket.milestoneId] = list;
          } else {
            looseTickets.push(ticket);
          }
        }

        const rootPage = Object.values(pages).find((p) => p.projectId === project.id && p.isRoot);
        const rootPages = rootPage ? getChildPages(pages, rootPage.id) : [];

        result[project.id] = {
          milestones: projectMilestones,
          ticketsByMilestone,
          looseTickets,
          rootPages,
          activeTicketCount: projectTickets.length,
        };
      }

      return result;
    }, [projects, milestones, tickets, pages]);

    return (
      <Tree aria-label="Project tree" className={styles.tree} openItems={openItems} onOpenChange={handleOpenChange}>
        {projects.map((project) => {
          const data = projectData[project.id];
          if (!data) {
            return null;
          }
          const {
            milestones: projectMilestones,
            ticketsByMilestone,
            looseTickets,
            rootPages,
            activeTicketCount,
          } = data;

          const projectValue = `project:${project.id}`;

          const projectPinned = project.pinnedAt !== undefined;
          const handleProjectPin = (e: React.MouseEvent) => {
            e.stopPropagation();
            void ticketApi.updateProject(project.id, {
              pinnedAt: projectPinned ? undefined : Date.now(),
            });
          };
          const projectPinSlot = projectPinned ? (
            <span
              role="presentation"
              className={styles.pinSlotVisible}
              onMouseDown={stopPropagation}
              onClick={stopPropagation}
            >
              <button type="button" aria-label="Unpin project" className={styles.nativeBtn} onClick={handleProjectPin}>
                <Pin16Filled />
              </button>
            </span>
          ) : null;
          const projectActions = (
            // eslint-disable-next-line jsx-a11y/no-static-element-interactions
            <span
              className={`action-buttons ${styles.actionButtons}`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              {!projectPinned && (
                <button
                  type="button"
                  aria-label="Pin project to this week"
                  className={styles.nativeBtn}
                  onClick={handleProjectPin}
                >
                  <Pin16Regular />
                </button>
              )}
              <button
                type="button"
                aria-label="New page"
                className={styles.nativeBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  const rootPage = Object.values(pages).find((p) => p.projectId === project.id && p.isRoot);
                  if (!rootPage) {
                    return;
                  }
                  const siblings = Object.values(pages).filter((p) => p.parentId === rootPage.id);
                  const maxSort = siblings.reduce((max, p) => Math.max(max, p.sortOrder), 0);
                  void pageApi
                    .addPage({
                      projectId: project.id,
                      parentId: rootPage.id,
                      title: 'Untitled',
                      sortOrder: maxSort + 1,
                    })
                    .then((newPage) => {
                      onSelect(`page:${newPage.id}:${project.id}`);
                    });
                }}
              >
                <Add16Regular />
              </button>
              <Menu positioning={{ position: 'below', align: 'end' }}>
                <MenuTrigger>
                  <button type="button" aria-label="Project actions" className={styles.nativeBtn}>
                    <MoreHorizontal16Regular />
                  </button>
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    <MenuItem icon={<Board20Regular />} onClick={() => onSelect(`board:${project.id}`)}>
                      Board
                    </MenuItem>
                    <MenuItem icon={<Flag20Regular />} onClick={() => onCreateMilestone?.(project.id)}>
                      New milestone
                    </MenuItem>
                    <MenuItem
                      icon={<Notebook20Regular />}
                      onClick={() => {
                        const rootPage = Object.values(pages).find((p) => p.projectId === project.id && p.isRoot);
                        if (!rootPage) {
                          return;
                        }
                        const siblings = Object.values(pages).filter((p) => p.parentId === rootPage.id);
                        const maxSort = siblings.reduce((max, p) => Math.max(max, p.sortOrder), 0);
                        void pageApi
                          .addPage({
                            projectId: project.id,
                            parentId: rootPage.id,
                            title: 'Untitled notebook',
                            sortOrder: maxSort + 1,
                            kind: 'notebook',
                          })
                          .then((newPage) => onSelect(`page:${newPage.id}:${project.id}`));
                      }}
                    >
                      New notebook
                    </MenuItem>
                    <MenuDivider />
                    <MenuItem icon={<Settings20Regular />} onClick={() => onSelect(projectValue)}>
                      Project settings
                    </MenuItem>
                  </MenuList>
                </MenuPopover>
              </Menu>
            </span>
          );

          const projectAside = (
            <>
              {projectPinSlot}
              {projectActions}
            </>
          );

          return (
            <TreeItem
              key={project.id}
              itemType="branch"
              value={projectValue}
              className={mergeClasses(styles.hoverableItem, styles.hoverableBranch)}
              onClick={() => handleItemClick(projectValue)}
            >
              <TreeItemLayout
                iconBefore={
                  <BranchIcon
                    icon={<Folder16Regular className={styles.icon} />}
                    value={projectValue}
                    onToggle={handleToggle}
                  />
                }
                aside={projectAside}
              >
                <span className={styles.titleRow}>
                  <span className={styles.titleRowMain}>{project.label}</span>
                  <span className={`${styles.badge} ${styles.titleRowTrail}`}>({activeTicketCount})</span>
                </span>
              </TreeItemLayout>

              <Tree>
                {/* Pages */}
                {rootPages.length > 0 && (
                  <TreeItem itemType="branch" value={`pages:${project.id}`} className={styles.hoverableBranch}>
                    <TreeItemLayout
                      iconBefore={
                        <BranchIcon
                          icon={<DocumentMultiple16Regular className={styles.icon} />}
                          value={`pages:${project.id}`}
                          onToggle={handleToggle}
                        />
                      }
                    >
                      <span className={styles.titleRow}>
                        <span className={styles.titleRowMain}>Pages</span>
                        <span className={`${styles.badge} ${styles.titleRowTrail}`}>({rootPages.length})</span>
                      </span>
                    </TreeItemLayout>
                    <Tree>
                      {rootPages.map((page) => (
                        <PageTreeItem
                          key={page.id}
                          page={page}
                          pages={pages}
                          onSelect={onSelect}
                          renamingId={rename.renamingId}
                          renameValue={rename.renameValue}
                          setRenameValue={rename.setRenameValue}
                          onStartRename={rename.startRename}
                          onFinishRename={handleFinishRename}
                          onCancelRename={rename.cancelRename}
                          onItemClick={handleItemClick}
                          onToggle={handleToggle}
                        />
                      ))}
                    </Tree>
                  </TreeItem>
                )}

                {/* Board — branch grouping milestones + loose-ticket backlog.
                      Clicking the label navigates to the unified board view
                      (matches project rows); the chevron just expands. */}
                <TreeItem
                  itemType="branch"
                  value={`board:${project.id}`}
                  className={mergeClasses(styles.hoverableItem, styles.hoverableBranch)}
                  onClick={() => handleItemClick(`board:${project.id}`)}
                >
                  <TreeItemLayout
                    iconBefore={
                      <BranchIcon
                        icon={<Board16Regular className={styles.icon} />}
                        value={`board:${project.id}`}
                        onToggle={handleToggle}
                      />
                    }
                  >
                    <span className={styles.titleRow}>
                      <span className={styles.titleRowMain}>Board</span>
                      <span className={`${styles.badge} ${styles.titleRowTrail}`}>({activeTicketCount})</span>
                    </span>
                  </TreeItemLayout>
                  <Tree>
                    {/* Milestones */}
                    {projectMilestones.map((milestone) => {
                      const milestoneTickets = ticketsByMilestone[milestone.id] ?? [];
                      const milestoneValue = `milestone:${milestone.id}:${project.id}`;

                      const handleNewMilestoneTicket = () => {
                        void ticketApi
                          .addTicket({
                            projectId: project.id,
                            milestoneId: milestone.id,
                            title: 'Untitled',
                            description: '',
                            priority: 'medium',
                            blockedBy: [],
                          })
                          .then((ticket) => ticketApi.goToTicket(ticket.id));
                      };

                      const milestonePinned = milestone.pinnedAt !== undefined;
                      const handleMilestonePin = (e: React.MouseEvent) => {
                        e.stopPropagation();
                        void milestoneApi.updateMilestone(milestone.id, {
                          pinnedAt: milestonePinned ? undefined : Date.now(),
                        });
                      };
                      const milestonePinSlot = milestonePinned ? (
                        <span
                          role="presentation"
                          className={styles.pinSlotVisible}
                          onMouseDown={stopPropagation}
                          onClick={stopPropagation}
                        >
                          <button
                            type="button"
                            aria-label="Unpin milestone"
                            className={styles.nativeBtn}
                            onClick={handleMilestonePin}
                          >
                            <Pin16Filled />
                          </button>
                        </span>
                      ) : null;

                      const milestoneActions = (
                        // eslint-disable-next-line jsx-a11y/no-static-element-interactions
                        <span
                          className={`action-buttons ${styles.actionButtons}`}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {!milestonePinned && (
                            <button
                              type="button"
                              aria-label="Pin milestone to this week"
                              className={styles.nativeBtn}
                              onClick={handleMilestonePin}
                            >
                              <Pin16Regular />
                            </button>
                          )}
                          <button
                            type="button"
                            aria-label="New ticket"
                            className={styles.nativeBtn}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleNewMilestoneTicket();
                            }}
                          >
                            <Add16Regular />
                          </button>
                          <Menu positioning={{ position: 'below', align: 'end' }}>
                            <MenuTrigger>
                              <button type="button" aria-label="Milestone actions" className={styles.nativeBtn}>
                                <MoreHorizontal16Regular />
                              </button>
                            </MenuTrigger>
                            <MenuPopover>
                              <MenuList>
                                <MenuItem icon={<Add16Regular />} onClick={handleNewMilestoneTicket}>
                                  New ticket
                                </MenuItem>
                                <MenuItem icon={<Edit20Regular />} onClick={() => onEditMilestone?.(milestone)}>
                                  Edit milestone
                                </MenuItem>
                                <MenuDivider />
                                <MenuItem
                                  icon={<Checkmark12Regular />}
                                  onClick={() =>
                                    void milestoneApi.updateMilestone(milestone.id, { status: 'completed' })
                                  }
                                >
                                  Complete
                                </MenuItem>
                                <MenuItem
                                  onClick={() =>
                                    void milestoneApi.updateMilestone(milestone.id, { status: 'archived' })
                                  }
                                >
                                  Archive
                                </MenuItem>
                                <MenuDivider />
                                <MenuItem
                                  icon={<Delete20Regular />}
                                  onClick={() => void milestoneApi.removeMilestone(milestone.id)}
                                >
                                  Delete
                                </MenuItem>
                              </MenuList>
                            </MenuPopover>
                          </Menu>
                        </span>
                      );

                      const milestoneAside = (
                        <>
                          {milestonePinSlot}
                          {milestoneActions}
                        </>
                      );

                      const milestoneIsBranch = milestoneTickets.length > 0;
                      return (
                        <TreeItem
                          key={milestone.id}
                          itemType={milestoneIsBranch ? 'branch' : 'leaf'}
                          value={milestoneValue}
                          className={mergeClasses(styles.hoverableItem, milestoneIsBranch && styles.hoverableBranch)}
                          onClick={() => handleItemClick(milestoneValue)}
                        >
                          <TreeItemLayout
                            iconBefore={
                              milestoneIsBranch ? (
                                <BranchIcon
                                  icon={<Flag16Regular className={styles.icon} />}
                                  value={milestoneValue}
                                  onToggle={handleToggle}
                                />
                              ) : (
                                <Flag16Regular className={styles.icon} />
                              )
                            }
                            aside={milestoneAside}
                          >
                            <span className={styles.titleRow}>
                              <span className={styles.titleRowMain}>{milestone.title}</span>
                              <span className={`${styles.badge} ${styles.titleRowTrail}`}>
                                ({milestoneTickets.length})
                              </span>
                            </span>
                          </TreeItemLayout>
                          {milestoneTickets.length > 0 && (
                            <Tree>
                              {milestoneTickets.map((ticket) => (
                                <TicketTreeItem
                                  key={ticket.id}
                                  ticket={ticket}
                                  onSelect={onSelect}
                                  onItemClick={handleItemClick}
                                />
                              ))}
                            </Tree>
                          )}
                        </TreeItem>
                      );
                    })}

                    {/* Loose tickets (no milestone) */}
                    {looseTickets.length > 0 && (
                      <TreeItem itemType="branch" value={`backlog:${project.id}`} className={styles.hoverableBranch}>
                        <TreeItemLayout
                          iconBefore={
                            <BranchIcon
                              icon={<TaskListSquareLtr16Regular className={styles.icon} />}
                              value={`backlog:${project.id}`}
                              onToggle={handleToggle}
                            />
                          }
                        >
                          <span className={styles.titleRow}>
                            <span className={styles.titleRowMain}>Backlog</span>
                            <span className={`${styles.badge} ${styles.titleRowTrail}`}>({looseTickets.length})</span>
                          </span>
                        </TreeItemLayout>
                        <Tree>
                          {looseTickets.map((ticket) => (
                            <TicketTreeItem
                              key={ticket.id}
                              ticket={ticket}
                              onSelect={onSelect}
                              onItemClick={handleItemClick}
                            />
                          ))}
                        </Tree>
                      </TreeItem>
                    )}
                  </Tree>
                </TreeItem>

                {/* Sources — always a branch so the + (add) affordance is
                      reachable even with zero sources. Each leaf has a ⋯ Remove. */}
                <TreeItem
                  itemType="branch"
                  value={`sources:${project.id}`}
                  className={mergeClasses(styles.hoverableItem, styles.hoverableBranch)}
                >
                  <TreeItemLayout
                    iconBefore={
                      <BranchIcon
                        icon={<Link16Regular className={styles.icon} />}
                        value={`sources:${project.id}`}
                        onToggle={handleToggle}
                      />
                    }
                    aside={
                      <span
                        className={`action-buttons ${styles.actionButtons}`}
                        onMouseDown={stopPropagation}
                        onClick={stopPropagation}
                      >
                        <button
                          type="button"
                          aria-label="Add source"
                          className={styles.nativeBtn}
                          onClick={(e) => {
                            e.stopPropagation();
                            onAddSource?.(project.id);
                          }}
                        >
                          <Add16Regular />
                        </button>
                      </span>
                    }
                  >
                    <span className={styles.titleRow}>
                      <span className={styles.titleRowMain}>Sources</span>
                      <span className={`${styles.badge} ${styles.titleRowTrail}`}>({project.sources.length})</span>
                    </span>
                  </TreeItemLayout>
                  <Tree>
                    {project.sources.length === 0 ? (
                      <TreeItem itemType="leaf" value={`sources-empty:${project.id}`}>
                        <TreeItemLayout>
                          <span className={styles.sourceLabel}>No sources — click + to add</span>
                        </TreeItemLayout>
                      </TreeItem>
                    ) : (
                      project.sources.map((s) => {
                        const isLocal = s.kind === 'local';
                        const label = isLocal ? shortenPath(s.workspaceDir) : shortenRepoUrl(s.repoUrl);
                        const title = isLocal ? s.workspaceDir : s.repoUrl;
                        return (
                          <TreeItem
                            key={s.id}
                            itemType="leaf"
                            value={`source:${project.id}:${s.id}`}
                            className={styles.hoverableItem}
                          >
                            <TreeItemLayout
                              iconBefore={
                                isLocal ? (
                                  <Link16Regular className={styles.icon} />
                                ) : (
                                  <Globe16Regular className={styles.icon} />
                                )
                              }
                              aside={
                                <span
                                  className={`action-buttons ${styles.actionButtons}`}
                                  onMouseDown={stopPropagation}
                                  onClick={stopPropagation}
                                >
                                  <Menu positioning={{ position: 'below', align: 'end' }}>
                                    <MenuTrigger>
                                      <button type="button" aria-label="Source actions" className={styles.nativeBtn}>
                                        <MoreHorizontal16Regular />
                                      </button>
                                    </MenuTrigger>
                                    <MenuPopover>
                                      <MenuList>
                                        <MenuItem
                                          icon={<Delete20Regular />}
                                          onClick={() => onRemoveSource?.(project.id, s.id)}
                                        >
                                          Remove source
                                        </MenuItem>
                                      </MenuList>
                                    </MenuPopover>
                                  </Menu>
                                </span>
                              }
                            >
                              <span className={styles.sourceLabel} title={title}>
                                {label}
                              </span>
                            </TreeItemLayout>
                          </TreeItem>
                        );
                      })
                    )}
                  </Tree>
                </TreeItem>
              </Tree>
            </TreeItem>
          );
        })}
      </Tree>
    );
  }
);
SidebarTree.displayName = 'SidebarTree';
