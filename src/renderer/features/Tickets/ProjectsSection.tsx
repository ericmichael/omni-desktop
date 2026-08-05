import { useStore } from '@nanostores/react';
import { Edit, Ellipsis, Folder, FolderOpen, Pin, PinOff, Plus } from 'lucide-react';
import { atom } from 'nanostores';
import { memo, useCallback, useMemo, useState } from 'react';

import { NavSection } from '@/renderer/common/NavSection';
import { SidebarRowActions, SidebarRowLayout } from '@/renderer/common/SidebarRow';
import { cn } from '@/renderer/ds/cn';
import { ButtonGroup } from '@/renderer/ds/ui/button-group';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/ds/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/renderer/ds/ui/dropdown-menu';
import { Input } from '@/renderer/ds/ui/input';
import {
  SidebarGroupAction,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/renderer/ds/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/ds/ui/tooltip';
import { ProjectSessionRows } from '@/renderer/features/Code/SessionsSection';
import { ProjectCreateDialog } from '@/renderer/features/Projects/ProjectCreateDialog';
import { persistedStoreApi } from '@/renderer/services/store';
import type { Project } from '@/shared/types';

import { $needsYouByProject, $tickets, $ticketsView, ticketApi, viewToNavValue } from './state';

/**
 * The Projects nav section, self-contained (rows with sessions, pin, and rename,
 * plus the create action) so the app sidebar and
 * the Work surface's mobile overlay render the same component.
 */

const EXPANDED_PROJECTS_STORAGE_KEY = 'omni.sidebarExpandedProjects';

function loadExpandedProjects(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(EXPANDED_PROJECTS_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

const $expandedProjects = atom<Record<string, boolean>>(loadExpandedProjects());

function setProjectExpanded(projectId: string, expanded: boolean): void {
  // Persist both states. Absence means "use the sensible default" (expanded
  // when the project has sessions); false means the user explicitly folded
  // it and must survive a restart.
  const next = { ...$expandedProjects.get(), [projectId]: expanded };
  $expandedProjects.set(next);
  try {
    localStorage.setItem(EXPANDED_PROJECTS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* Ignore unavailable renderer storage. */
  }
}

const stopPropagation = (e: React.SyntheticEvent) => e.stopPropagation();

type ProjectRowProps = {
  project: Project;
  /** Tasks in this project waiting on the user (0 = no badge). */
  needsYou: number;
  selected: boolean;
  hasSessions: boolean;
  sessionTitles: ReadonlyMap<string, string>;
  onNavigate?: () => void;
};

export const ProjectRow = memo(
  ({ project, needsYou, selected, hasSessions, sessionTitles, onNavigate }: ProjectRowProps) => {
    const pinned = project.pinnedAt != null;

    const savedExpanded = useStore($expandedProjects)[project.id];
    const expanded = savedExpanded ?? hasSessions;
    const [menuOpen, setMenuOpen] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const [renameValue, setRenameValue] = useState('');

    const handleOpen = useCallback(
      (event?: React.SyntheticEvent) => {
        event?.stopPropagation();
        if (renaming) {
          return;
        }
        ticketApi.goToProject(project.id);
        onNavigate?.();
      },
      [project.id, onNavigate, renaming]
    );

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

    const handleMenuOpenChange = useCallback((open: boolean) => {
      setMenuOpen(open);
    }, []);
    const handleExpandedChange = useCallback(
      (nextExpanded: boolean) => setProjectExpanded(project.id, nextExpanded),
      [project.id]
    );

    return (
      <Collapsible asChild open={expanded} onOpenChange={handleExpandedChange}>
        <SidebarMenuItem>
          <SidebarRowLayout>
            {renaming ? (
              <SidebarMenuButton asChild isActive={selected}>
                <div>
                  <Folder />
                  <span role="presentation" className="flex min-w-0 flex-auto" onClick={stopPropagation}>
                    <Input
                      value={renameValue}
                      onChange={handleRenameChange}
                      onBlur={handleFinishRename}
                      onKeyDown={handleRenameKeyDown}
                      autoFocus
                      aria-label="Project name"
                    />
                  </span>
                </div>
              </SidebarMenuButton>
            ) : (
              <CollapsibleTrigger asChild>
                <SidebarMenuButton
                  type="button"
                  isActive={selected}
                  aria-label={`${expanded ? 'Hide' : 'Show'} sessions for ${project.label}`}
                >
                  <Folder />
                  <span className="flex min-w-0 flex-1 items-baseline gap-2">
                    <span className="min-w-0 truncate">{project.label}</span>
                  </span>
                </SidebarMenuButton>
              </CollapsibleTrigger>
            )}
            {!renaming && needsYou > 0 && (
              <SidebarMenuBadge className="h-4 min-w-4 text-xs">{needsYou}</SidebarMenuBadge>
            )}
            {!renaming && (
              <SidebarRowActions open={menuOpen}>
                <ButtonGroup>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <SidebarMenuAction aria-label={`Open ${project.label}`} onClick={handleOpen}>
                        <FolderOpen />
                      </SidebarMenuAction>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={6}>
                      Open project
                    </TooltipContent>
                  </Tooltip>
                  <DropdownMenu open={menuOpen} onOpenChange={handleMenuOpenChange}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <DropdownMenuTrigger asChild>
                          <SidebarMenuAction aria-label="Project actions">
                            <Ellipsis />
                          </SidebarMenuAction>
                        </DropdownMenuTrigger>
                      </TooltipTrigger>
                      <TooltipContent side="top" sideOffset={6}>
                        Project actions
                      </TooltipContent>
                    </Tooltip>
                    <DropdownMenuContent>
                      <DropdownMenuItem onClick={handleStartRename}>
                        <Edit />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={handleTogglePin}>
                        {pinned ? <PinOff /> : <Pin />}
                        {pinned ? 'Unpin' : 'Pin'}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </ButtonGroup>
              </SidebarRowActions>
            )}
          </SidebarRowLayout>
          <CollapsibleContent>
            <ProjectSessionRows projectId={project.id} sessionTitles={sessionTitles} onNavigate={onNavigate} />
          </CollapsibleContent>
        </SidebarMenuItem>
      </Collapsible>
    );
  }
);
ProjectRow.displayName = 'ProjectRow';

/** The Projects nav section: collapsible header, rows, and create dialog. */
export const ProjectsSection = memo(
  ({ sessionTitles, onNavigate }: { sessionTitles: ReadonlyMap<string, string>; onNavigate?: () => void }) => {
    const store = useStore(persistedStoreApi.$atom);
    const view = useStore($ticketsView);
    const tickets = useStore($tickets);
    const needsYouByProject = useStore($needsYouByProject);
    const [createOpen, setCreateOpen] = useState(false);

    // Pinned projects float — stable partition, so relative order within
    // each group is untouched.
    const projects = useMemo(
      () => [...store.projects.filter((p) => p.pinnedAt != null), ...store.projects.filter((p) => p.pinnedAt == null)],
      [store.projects]
    );
    const projectsWithSessions = useMemo(() => {
      const ids = new Set<string>();
      for (const tab of store.codeTabs ?? []) {
        if (tab.projectId) {
          ids.add(tab.projectId);
        }
      }
      for (const conversation of store.chatConversations ?? []) {
        if (conversation.projectId && !conversation.archivedAt) {
          ids.add(conversation.projectId);
        }
      }
      return ids;
    }, [store.chatConversations, store.codeTabs]);
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

    // Aggregate attention for the collapsed header: tasks waiting on you.
    const needsYouTotal = Object.values(needsYouByProject).reduce((sum, n) => sum + n, 0);

    return (
      <>
        <NavSection
          id="projects"
          label="Projects"
          collapsedBadge={needsYouTotal}
          actions={
            <Tooltip>
              <TooltipTrigger asChild>
                <SidebarGroupAction aria-label="New project" onClick={handleOpenCreate}>
                  <Plus />
                </SidebarGroupAction>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                New project
              </TooltipContent>
            </Tooltip>
          }
        >
          {projects.length === 0 ? (
            <span className={cn('px-5 py-1 text-xs text-muted-foreground')}>No projects yet</span>
          ) : (
            <SidebarMenu aria-label="Projects">
              {projects.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  needsYou={needsYouByProject[project.id] ?? 0}
                  selected={selectedValue === `project:${project.id}`}
                  hasSessions={projectsWithSessions.has(project.id)}
                  sessionTitles={sessionTitles}
                  onNavigate={onNavigate}
                />
              ))}
            </SidebarMenu>
          )}
        </NavSection>
        <ProjectCreateDialog open={createOpen} onClose={handleCloseCreate} onCreated={handleCreated} />
      </>
    );
  }
);
ProjectsSection.displayName = 'ProjectsSection';
