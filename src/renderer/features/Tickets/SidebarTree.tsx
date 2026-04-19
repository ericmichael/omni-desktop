// Board20/Flag20 are kept because they render inside MenuPopover action menus,
// which want the larger 20px icon size. The tree's iconBefore slot uses 16px.
import { makeStyles, tokens } from '@fluentui/react-components';
import {
  Add16Regular,
  Board16Regular,
  Board20Regular,
  Checkmark12Regular,
  Delete20Regular,
  Document16Regular,
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
});

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
      <span className={`action-buttons ${styles.actionButtons}`} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
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

    return (
      <TreeItem itemType={hasChildren ? 'branch' : 'leaf'} value={value} className={styles.hoverableItem} onClick={() => onItemClick(value)}>
        <TreeItemLayout
          iconBefore={
            page.icon ? (
              <span className={styles.emojiIcon}>{page.icon}</span>
            ) : (
              <DocumentText16Regular className={styles.icon} />
            )
          }
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

const TicketTreeItem = memo(({ ticket, onSelect, onItemClick }: { ticket: Ticket; onSelect: (value: string) => void; onItemClick: (value: string) => void }) => {
  const styles = useStyles();
  const phase = ticket.phase;
  const isRunning = phase != null && isActivePhase(phase);
  const value = `ticket:${ticket.id}`;

  const actionButtons = (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <span className={`action-buttons ${styles.actionButtons}`} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
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
                  void openTicketInCode(ticket.id);
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
});
TicketTreeItem.displayName = 'TicketTreeItem';

// ─── Main tree ───────────────────────────────────────────────────────────────

export const SidebarTree = memo(
  ({ projects, pages, milestones, tickets, onSelect, onExpandProject, onCreateMilestone }: SidebarTreeProps) => {
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
      <Tree
        aria-label="Project tree"
        className={styles.tree}
        openItems={openItems}
        onOpenChange={handleOpenChange}
      >
        {projects.map((project) => {
          const data = projectData[project.id];
          if (!data) {
return null;
}
          const { milestones: projectMilestones, ticketsByMilestone, looseTickets, rootPages, activeTicketCount } = data;

          const projectValue = `project:${project.id}`;

          const projectActions = (
            // eslint-disable-next-line jsx-a11y/no-static-element-interactions
            <span className={`action-buttons ${styles.actionButtons}`} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
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

          return (
            <TreeItem
              key={project.id}
              itemType="branch"
              value={projectValue}
              className={styles.hoverableItem}
              onClick={() => handleItemClick(projectValue)}
            >
                <TreeItemLayout
                  iconBefore={<Folder16Regular className={styles.icon} />}
                  aside={projectActions}
                >
                  <span className={styles.titleRow}>
                    <span className={styles.titleRowMain}>{project.label}</span>
                    <span className={`${styles.badge} ${styles.titleRowTrail}`}>({activeTicketCount})</span>
                  </span>
                </TreeItemLayout>

              <Tree>
                  {/* Board */}
                  <TreeItem
                    itemType="leaf"
                    value={`board:${project.id}`}
                    className={styles.hoverableItem}
                    onClick={() => handleItemClick(`board:${project.id}`)}
                  >
                      <TreeItemLayout iconBefore={<Board16Regular className={styles.icon} />}>
                        <span className={styles.titleRow}>
                          <span className={styles.titleRowMain}>Board</span>
                          <span className={`${styles.badge} ${styles.titleRowTrail}`}>({activeTicketCount})</span>
                        </span>
                      </TreeItemLayout>
                    </TreeItem>

                  {/* Pages */}
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
                    />
                  ))}

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

                    const milestoneActions = (
                      // eslint-disable-next-line jsx-a11y/no-static-element-interactions
                      <span className={`action-buttons ${styles.actionButtons}`} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          aria-label="New ticket"
                          className={styles.nativeBtn}
                          onClick={(e) => {
 e.stopPropagation(); handleNewMilestoneTicket(); 
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
                              <MenuDivider />
                              <MenuItem
                                icon={<Checkmark12Regular />}
                                onClick={() => void milestoneApi.updateMilestone(milestone.id, { status: 'completed' })}
                              >
                                Complete
                              </MenuItem>
                              <MenuItem
                                onClick={() => void milestoneApi.updateMilestone(milestone.id, { status: 'archived' })}
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

                    return (
                      <TreeItem
                        key={milestone.id}
                        itemType={milestoneTickets.length > 0 ? 'branch' : 'leaf'}
                        value={milestoneValue}
                        className={styles.hoverableItem}
                        onClick={() => handleItemClick(milestoneValue)}
                      >
                        <TreeItemLayout
                          iconBefore={<Flag16Regular className={styles.icon} />}
                          aside={milestoneActions}
                        >
                          <span className={styles.titleRow}>
                            <span className={styles.titleRowMain}>{milestone.title}</span>
                            <span className={`${styles.badge} ${styles.titleRowTrail}`}>({milestoneTickets.length})</span>
                          </span>
                        </TreeItemLayout>
                        {milestoneTickets.length > 0 && (
                          <Tree>
                            {milestoneTickets.map((ticket) => (
                              <TicketTreeItem key={ticket.id} ticket={ticket} onSelect={onSelect} onItemClick={handleItemClick} />
                            ))}
                          </Tree>
                        )}
                      </TreeItem>
                    );
                  })}

                  {/* Loose tickets (no milestone) */}
                  {looseTickets.length > 0 && (
                    <TreeItem itemType="branch" value={`backlog:${project.id}`}>
                      <TreeItemLayout iconBefore={<TaskListSquareLtr16Regular className={styles.icon} />}>
                        <span className={styles.titleRow}>
                          <span className={styles.titleRowMain}>Backlog</span>
                          <span className={`${styles.badge} ${styles.titleRowTrail}`}>({looseTickets.length})</span>
                        </span>
                      </TreeItemLayout>
                      <Tree>
                        {looseTickets.map((ticket) => (
                          <TicketTreeItem key={ticket.id} ticket={ticket} onSelect={onSelect} onItemClick={handleItemClick} />
                        ))}
                      </Tree>
                    </TreeItem>
                  )}

                  {/* Source / Workspace link */}
                  {project.source?.kind === 'local' && (
                    <TreeItem
                      itemType="leaf"
                      value={`source:${project.id}`}
                      className={styles.hoverableItem}
                    >
                      <TreeItemLayout iconBefore={<Link16Regular className={styles.icon} />}>
                        <span className={styles.sourceLabel} title={project.source.workspaceDir}>
                          {shortenPath(project.source.workspaceDir)}
                        </span>
                      </TreeItemLayout>
                    </TreeItem>
                  )}
                  {project.source?.kind === 'git-remote' && (
                    <TreeItem
                      itemType="leaf"
                      value={`source:${project.id}`}
                      className={styles.hoverableItem}
                    >
                      <TreeItemLayout iconBefore={<Globe16Regular className={styles.icon} />}>
                        <span className={styles.sourceLabel} title={project.source.repoUrl}>
                          {shortenRepoUrl(project.source.repoUrl)}
                        </span>
                      </TreeItemLayout>
                    </TreeItem>
                  )}
                </Tree>
            </TreeItem>
          );
        })}
      </Tree>
    );
  }
);
SidebarTree.displayName = 'SidebarTree';
