import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  Add20Regular,
  Delete20Regular,
  Edit20Regular,
  Folder16Regular,
  MoreHorizontal16Regular,
  Pin16Filled,
  Pin16Regular,
} from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';

import { useNavTreeStyles } from '@/renderer/common/nav-tree';
import { NavSection } from '@/renderer/common/NavSection';
import {
  Caption1,
  ConfirmDialog,
  CounterBadge,
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
import { persistedStoreApi } from '@/renderer/services/store';
import type { Project } from '@/shared/types';

import { $needsYouByProject, $tickets, $ticketsView, ticketApi, viewToNavValue } from './state';

/**
 * The Projects nav section, self-contained (rows with pin/rename/delete,
 * the "+" and its create dialog, the delete confirm) so the app sidebar and
 * the Work surface's mobile overlay render the same component.
 */

const useStyles = makeStyles({
  emptyHint: {
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
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

const stopPropagation = (e: React.SyntheticEvent) => e.stopPropagation();

type ProjectRowProps = {
  project: Project;
  /** Tasks in this project waiting on the user (0 = no badge). */
  needsYou: number;
  selected: boolean;
  onNavigate?: () => void;
  onRequestDelete: (project: Project) => void;
};

const ProjectRow = memo(({ project, needsYou, selected, onNavigate, onRequestDelete }: ProjectRowProps) => {
  const styles = useStyles();
  const nav = useNavTreeStyles();
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
      className={mergeClasses(nav.navItem, styles.projectItem, selected && nav.navItemSelected)}
      onClick={handleClick}
    >
      <TreeItemLayout
        iconBefore={<Folder16Regular />}
        aside={
          pinned || needsYou > 0 ? (
            <>
              {/* Badges mean attention everywhere in the sidebar — this is
                  the project's needs-you count, not a task census. */}
              {needsYou > 0 && <CounterBadge count={needsYou} size="small" color="brand" />}
              {pinned && <Pin16Filled className={styles.pinnedIndicator} />}
            </>
          ) : undefined
        }
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
          </span>
        )}
      </TreeItemLayout>
    </TreeItem>
  );
});
ProjectRow.displayName = 'ProjectRow';

/** The Projects nav section: header + "+", rows, create + delete dialogs. */
export const ProjectsSection = memo(({ onNavigate }: { onNavigate?: () => void }) => {
  const styles = useStyles();
  const nav = useNavTreeStyles();
  const store = useStore(persistedStoreApi.$atom);
  const view = useStore($ticketsView);
  const tickets = useStore($tickets);
  const needsYouByProject = useStore($needsYouByProject);
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null);

  // Pinned projects float — stable partition, so relative order within
  // each group is untouched.
  const projects = useMemo(
    () => [...store.projects.filter((p) => p.pinnedAt != null), ...store.projects.filter((p) => p.pinnedAt == null)],
    [store.projects]
  );
  // Selection paints only while the Work surface is frontmost — the view
  // atom keeps its value across tab switches (keep-mounted panels).
  const selectedValue = store.layoutMode === 'work' ? viewToNavValue(view, tickets) : undefined;

  const handleOpenCreate = useCallback(() => setCreateOpen(true), []);
  const handleCloseCreate = useCallback(() => setCreateOpen(false), []);
  const handleCreated = useCallback(
    (project: Project) => {
      ticketApi.goToProject(project.id);
      onNavigate?.();
    },
    [onNavigate]
  );

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

  // Aggregate attention for the collapsed header: tasks waiting on you.
  const needsYouTotal = Object.values(needsYouByProject).reduce((sum, n) => sum + n, 0);

  return (
    <>
      <NavSection
        id="projects"
        label="Projects"
        collapsedBadge={needsYouTotal}
        actions={<IconButton aria-label="New project" icon={<Add20Regular />} size="sm" onClick={handleOpenCreate} />}
      >
        {projects.length === 0 ? (
          <Caption1 className={styles.emptyHint}>No projects yet</Caption1>
        ) : (
          <Tree aria-label="Projects" className={nav.tree}>
            {projects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                needsYou={needsYouByProject[project.id] ?? 0}
                selected={selectedValue === `project:${project.id}`}
                onNavigate={onNavigate}
                onRequestDelete={handleRequestDelete}
              />
            ))}
          </Tree>
        )}
      </NavSection>
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
    </>
  );
});
ProjectsSection.displayName = 'ProjectsSection';
