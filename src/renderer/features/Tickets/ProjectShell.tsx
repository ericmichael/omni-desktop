import { useStore } from '@nanostores/react';
import { Ellipsis, MessageSquarePlus, Pin, PinOff } from 'lucide-react';
import { memo, type ReactNode, useCallback, useMemo } from 'react';

import { useIsDesktop } from '@/renderer/common/use-is-desktop';
import { PageTabsList, PageTabsTrigger } from '@/renderer/ds/PageTabs';
import { Button } from '@/renderer/ds/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/renderer/ds/ui/dropdown-menu';
import { Tabs } from '@/renderer/ds/ui/tabs';
import { codeApi } from '@/renderer/features/Code/state';
import { persistedStoreApi } from '@/renderer/services/store';
import type { ProjectId } from '@/shared/types';

import { type ProjectTab, ticketApi } from './state';

const PRIMARY_TABS: { value: ProjectTab; label: string }[] = [
  { value: 'home', label: 'Home' },
  { value: 'pages', label: 'Pages' },
  { value: 'tasks', label: 'Tasks' },
  { value: 'settings', label: 'Settings' },
];

type ProjectShellProps = {
  projectId: ProjectId;
  activeTab: ProjectTab;
  children: ReactNode;
};

export const ProjectShell = memo(({ projectId, activeTab, children }: ProjectShellProps) => {
  const store = useStore(persistedStoreApi.$atom);
  const isDesktop = useIsDesktop();
  const project = useMemo(
    () => store.projects.find((candidate) => candidate.id === projectId),
    [projectId, store.projects]
  );

  const handleTabChange = useCallback(
    (value: string) => ticketApi.goToProject(projectId, value as ProjectTab),
    [projectId]
  );

  const handleAskOmni = useCallback(async () => {
    const tab = await codeApi.addTab();
    await codeApi.setTabProject(tab.id, projectId);
    codeApi.setLayoutMode('focus');
    await persistedStoreApi.setKey('layoutMode', 'chat');
  }, [projectId]);

  const handleTogglePin = useCallback(() => {
    if (project) {
      void ticketApi.updateProject(projectId, { pinnedAt: project.pinnedAt != null ? null : Date.now() });
    }
  }, [project, projectId]);

  if (!project) {
    return (
      <div className="flex h-full items-center px-6">
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight">Project unavailable</h1>
          <p className="mt-1 text-sm text-muted-foreground">This project may have been archived or removed.</p>
          <Button className="mt-4" variant="outline" onClick={() => ticketApi.goToAllWork()}>
            Back to projects
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col" data-slot="project-shell">
      {isDesktop && (
        <header className="shrink-0 bg-card px-5 pt-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="truncate font-display text-xl font-semibold tracking-tight">{project.label}</h1>
            </div>

            <Button size="sm" onClick={handleAskOmni}>
              <MessageSquarePlus />
              Ask Omni
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label="Project actions">
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={handleTogglePin}>
                  {project.pinnedAt != null ? <PinOff /> : <Pin />}
                  {project.pinnedAt != null ? 'Unpin project' : 'Pin project'}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <Tabs value={activeTab} onValueChange={handleTabChange} className="mt-3 gap-0">
            <PageTabsList>
              {PRIMARY_TABS.map((tab) => (
                <PageTabsTrigger key={tab.value} value={tab.value}>
                  {tab.label}
                </PageTabsTrigger>
              ))}
            </PageTabsList>
          </Tabs>
        </header>
      )}

      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
});
ProjectShell.displayName = 'ProjectShell';
