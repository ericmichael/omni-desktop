import {
  makeStyles,
  mergeClasses,
  NavDrawer,
  NavDrawerBody,
  type NavDrawerProps,
  Subtitle2,
  tokens,
} from '@fluentui/react-components';
import {
  Add20Regular,
  Delete20Regular,
  Dismiss20Regular,
  Edit20Regular,
  Folder16Regular,
  MoreHorizontal16Regular,
  Pin16Filled,
  Pin16Regular,
  TaskListSquareLtr20Regular,
} from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';

import {
  Caption1,
  ConfirmDialog,
  IconButton,
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
import { ProjectCreateDialog } from '@/renderer/features/Projects/ProjectCreateDialog';
import { TeamSwitcher } from '@/renderer/features/Teams/TeamSwitcher';
import { persistedStoreApi } from '@/renderer/services/store';
import type { Project, Ticket } from '@/shared/types';

import { $tickets, $ticketsView, ticketApi, type TicketsView } from './state';

const useStyles = makeStyles({
  drawer: {
    width: '260px',
    height: '100%',
    /* Fluent's NavDrawer root defaults to colorNeutralBackground4 (#EBEBEB on
       vscode-light — noticeably darker than the rest of the app). Force bg1
       to match the Settings sidebar and the rest of the app's page plane. */
    backgroundColor: tokens.colorNeutralBackground1,
  },
  drawerOverlay: {
    boxSizing: 'border-box',
    paddingLeft: 'env(safe-area-inset-left, 0px)',
    paddingRight: 'env(safe-area-inset-right, 0px)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalXS,
    paddingTop: tokens.spacingVerticalXXL,
    paddingBottom: tokens.spacingVerticalL,
  },
  headerOverlay: {
    paddingTop: `calc(${tokens.spacingVerticalXXL} + env(safe-area-inset-top, 0px))`,
  },
  headerTitle: {
    flex: '1 1 0',
  },
  body: {
    flex: '1 1 0',
  },
  bodyOverlay: {
    paddingBottom: `calc(${tokens.spacingVerticalL} + var(--safe-area-bottom, env(safe-area-inset-bottom, 0px)))`,
  },
  sectionHeader: {
    paddingLeft: tokens.spacingHorizontalMNudge,
    paddingRight: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXL,
    paddingBottom: tokens.spacingVerticalXS,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground3,
  },
  /**
   * Shared tree geometry for the pinned rows and the project list. Override
   * `--spacingHorizontalXXL` so Fluent's per-level indent stays tight.
   */
  tree: {
    paddingTop: '2px',
    paddingBottom: '2px',
    '--spacingHorizontalXXL': '12px',
  },
  emptyHint: {
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
  },
  navItem: {
    position: 'relative',
  },
  /** Selected state à la Fluent NavItem: subtle bg + left brand indicator. */
  navItemSelected: {
    '& > .fui-TreeItemLayout': {
      backgroundColor: tokens.colorSubtleBackgroundSelected,
      fontWeight: tokens.fontWeightSemibold,
    },
    '::before': {
      content: '""',
      position: 'absolute',
      left: '2px',
      top: '6px',
      bottom: '6px',
      width: '3px',
      borderRadius: tokens.borderRadiusCircular,
      backgroundColor: tokens.colorCompoundBrandForeground1,
      zIndex: 1,
    },
  },
  projectItem: {
    '& .fui-TreeItemLayout__main': {
      flex: '1 1 auto',
      minWidth: 0,
      overflow: 'hidden',
    },
  },
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
  countBadge: {
    flexShrink: 0,
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
  },
  pinnedIndicator: {
    color: tokens.colorBrandForeground1,
  },
  rowActions: {
    display: 'flex',
    alignItems: 'center',
  },
  renameWrap: {
    display: 'flex',
    flex: '1 1 auto',
    minWidth: 0,
  },
  dangerMenuItem: {
    color: tokens.colorPaletteRedForeground1,
  },
});

/** Build a unique selectedValue from the current view state. Every
 *  project-scoped view (any tab, page, milestone, ticket) selects its
 *  project's row. */
function viewToNavValue(view: TicketsView, tickets: Record<string, Ticket>): string | undefined {
  if (view.type === 'all') {
    return 'all-work';
  }
  if (view.type === 'project' || view.type === 'page' || view.type === 'milestone') {
    return `project:${view.projectId}`;
  }
  if (view.type === 'ticket') {
    const projectId = tickets[view.ticketId]?.projectId;
    return projectId ? `project:${projectId}` : undefined;
  }
  return undefined;
}

const stopPropagation = (e: React.SyntheticEvent) => e.stopPropagation();

type ProjectRowProps = {
  project: Project;
  activeTicketCount: number;
  selected: boolean;
  onNavigate?: () => void;
  onRequestDelete: (project: Project) => void;
};

const ProjectRow = memo(({ project, activeTicketCount, selected, onNavigate, onRequestDelete }: ProjectRowProps) => {
  const styles = useStyles();
  const pinned = project.pinnedAt != null;

  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');

  const handleClick = useCallback(() => {
    if (renaming) {
      return;
    }
    ticketApi.goToProject(project.id);
    onNavigate?.();
  }, [project.id, onNavigate, renaming]);

  const handleTogglePin = useCallback(() => {
    void ticketApi.updateProject(project.id, { pinnedAt: pinned ? null : Date.now() });
  }, [project.id, pinned]);

  const handleStartRename = useCallback(() => {
    setRenameValue(project.label);
    setRenaming(true);
  }, [project.label]);

  const handleRenameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setRenameValue(e.target.value);
  }, []);

  const handleFinishRename = useCallback(() => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== project.label) {
      void ticketApi.renameProject(project.id, trimmed);
    }
    setRenaming(false);
  }, [renameValue, project.id, project.label]);

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Keep Enter/Escape/arrows away from the tree's keyboard handling.
      e.stopPropagation();
      if (e.key === 'Enter') {
        handleFinishRename();
      } else if (e.key === 'Escape') {
        setRenaming(false);
      }
    },
    [handleFinishRename]
  );

  const handleMenuOpenChange = useCallback((_e: unknown, data: { open: boolean }) => {
    setMenuOpen(data.open);
  }, []);

  const handleRequestDelete = useCallback(() => {
    onRequestDelete(project);
  }, [onRequestDelete, project]);

  return (
    <TreeItem
      itemType="leaf"
      value={`project:${project.id}`}
      className={mergeClasses(styles.navItem, styles.projectItem, selected && styles.navItemSelected)}
      onClick={handleClick}
    >
      <TreeItemLayout
        iconBefore={<Folder16Regular />}
        aside={pinned ? <Pin16Filled className={styles.pinnedIndicator} /> : undefined}
        actions={{
          // Fluent shows the actions slot on hover/focus; force it while the
          // menu is open so it doesn't vanish under the popover.
          visible: menuOpen || undefined,
          children: (
            <span
              role="presentation"
              className={styles.rowActions}
              onClick={stopPropagation}
              onMouseDown={stopPropagation}
            >
              <IconButton
                aria-label={pinned ? 'Unpin project' : 'Pin project'}
                icon={pinned ? <Pin16Filled className={styles.pinnedIndicator} /> : <Pin16Regular />}
                size="sm"
                onClick={handleTogglePin}
              />
              <Menu
                open={menuOpen}
                onOpenChange={handleMenuOpenChange}
                positioning={{ position: 'below', align: 'end' }}
              >
                <MenuTrigger disableButtonEnhancement>
                  <IconButton aria-label="Project actions" icon={<MoreHorizontal16Regular />} size="sm" />
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    <MenuItem icon={<Edit20Regular />} onClick={handleStartRename}>
                      Rename
                    </MenuItem>
                    <MenuItem icon={pinned ? <Pin16Filled /> : <Pin16Regular />} onClick={handleTogglePin}>
                      {pinned ? 'Unpin' : 'Pin'}
                    </MenuItem>
                    <MenuDivider />
                    <MenuItem
                      icon={<Delete20Regular />}
                      className={styles.dangerMenuItem}
                      onClick={handleRequestDelete}
                    >
                      Delete…
                    </MenuItem>
                  </MenuList>
                </MenuPopover>
              </Menu>
            </span>
          ),
        }}
      >
        {renaming ? (
          <span role="presentation" className={styles.renameWrap} onClick={stopPropagation}>
            <Input
              value={renameValue}
              onChange={handleRenameChange}
              onBlur={handleFinishRename}
              onKeyDown={handleRenameKeyDown}
              autoFocus
              size="sm"
              aria-label="Project name"
            />
          </span>
        ) : (
          <span className={styles.titleRow}>
            <span className={styles.titleRowMain}>{project.label}</span>
            <span className={styles.countBadge}>({activeTicketCount})</span>
          </span>
        )}
      </TreeItemLayout>
    </TreeItem>
  );
});
ProjectRow.displayName = 'ProjectRow';

type TicketsSidebarProps = {
  onNavigate?: () => void;
  type?: NavDrawerProps['type'];
  open?: boolean;
  onClose?: () => void;
};

/**
 * Flat navigation sidebar for the Work tab: an "All work" row (the global
 * cross-project task list) plus one row per project. Intra-project
 * navigation (pages, work list, settings) lives in the project shell's tabs
 * — the sidebar only picks the scope. Rows carry a hover "…" menu for
 * rename / pin / delete, mirroring the task rows' overflow idiom.
 */
export const TicketsSidebar = memo(({ onNavigate, type = 'inline', open = true, onClose }: TicketsSidebarProps) => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const view = useStore($ticketsView);
  const tickets = useStore($tickets);
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null);

  const projects = store.projects;
  // NavDrawer's own selectedValue only styles NavItems, not TreeItems —
  // selection is computed here and rendered by the rows themselves.
  const selectedValue = viewToNavValue(view, tickets);

  const handleOpenCreate = useCallback(() => setCreateOpen(true), []);
  const handleCloseCreate = useCallback(() => setCreateOpen(false), []);
  const handleCreated = useCallback(
    (project: Project) => {
      ticketApi.goToProject(project.id);
      onNavigate?.();
    },
    [onNavigate]
  );

  const handleOpenChange = useCallback(
    (_event: unknown, data: { open: boolean }) => {
      if (!data.open) {
        onClose?.();
      }
    },
    [onClose]
  );

  const handleGoAllWork = useCallback(() => {
    ticketApi.goToAllWork();
    onNavigate?.();
  }, [onNavigate]);

  const handleRequestDelete = useCallback((project: Project) => setPendingDelete(project), []);
  const handleCloseDelete = useCallback(() => setPendingDelete(null), []);
  const handleConfirmDelete = useCallback(() => {
    const project = pendingDelete;
    if (!project) {
      return;
    }
    const wasCurrent = viewToNavValue($ticketsView.get(), $tickets.get()) === `project:${project.id}`;
    void ticketApi.removeProject(project.id).then(() => {
      if (wasCurrent) {
        ticketApi.goToAllWork();
      }
    });
  }, [pendingDelete]);

  const activeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const ticket of Object.values(tickets)) {
      if (!ticket.resolution && !ticket.archivedAt) {
        counts[ticket.projectId] = (counts[ticket.projectId] ?? 0) + 1;
      }
    }
    return counts;
  }, [tickets]);

  return (
    <NavDrawer
      type={type}
      open={open}
      onOpenChange={handleOpenChange}
      className={mergeClasses(styles.drawer, type === 'overlay' && styles.drawerOverlay)}
      size="small"
    >
      {/* ── Header ── */}
      <div className={mergeClasses(styles.header, type === 'overlay' && styles.headerOverlay)}>
        <Subtitle2 className={styles.headerTitle}>Work</Subtitle2>
        <TeamSwitcher />
        <IconButton aria-label="New project" icon={<Add20Regular />} size="sm" onClick={handleOpenCreate} />
        {type === 'overlay' && (
          <IconButton aria-label="Close navigation" icon={<Dismiss20Regular />} size="sm" onClick={onClose} />
        )}
      </div>

      <NavDrawerBody className={mergeClasses(styles.body, type === 'overlay' && styles.bodyOverlay)}>
        {/* ── All work ── */}
        <Tree aria-label="All work" className={styles.tree}>
          <TreeItem
            itemType="leaf"
            value="all-work"
            className={mergeClasses(styles.navItem, selectedValue === 'all-work' && styles.navItemSelected)}
            onClick={handleGoAllWork}
          >
            <TreeItemLayout iconBefore={<TaskListSquareLtr20Regular />}>All work</TreeItemLayout>
          </TreeItem>
        </Tree>

        {/* ── Projects ── */}
        <div className={styles.sectionHeader}>Projects</div>
        {projects.length === 0 ? (
          <Caption1 className={styles.emptyHint}>No projects yet</Caption1>
        ) : (
          <Tree aria-label="Projects" className={styles.tree}>
            {projects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                activeTicketCount={activeCounts[project.id] ?? 0}
                selected={selectedValue === `project:${project.id}`}
                onNavigate={onNavigate}
                onRequestDelete={handleRequestDelete}
              />
            ))}
          </Tree>
        )}
      </NavDrawerBody>

      <ProjectCreateDialog open={createOpen} onClose={handleCloseCreate} onCreated={handleCreated} />
      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={handleCloseDelete}
        onConfirm={handleConfirmDelete}
        title={`Delete project "${pendingDelete?.label ?? ''}"?`}
        description="Deletes the project and all its tasks. Workspace files are not affected."
        confirmLabel="Delete"
        destructive
      />
    </NavDrawer>
  );
});
TicketsSidebar.displayName = 'TicketsSidebar';
