import { useStore } from '@nanostores/react';
import { ArrowRight, FilePlus2, FileText, ListTodo, MessageSquarePlus, Plus } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import Markdown from 'react-markdown';

import { doneColumnIds } from '@/lib/pipeline-category';
import { Button } from '@/renderer/ds/ui/button';
import { codeApi } from '@/renderer/features/Code/state';
import { $pages, pageApi } from '@/renderer/features/Pages/state';
import { persistedStoreApi } from '@/renderer/services/store';
import { DEFAULT_PIPELINE } from '@/shared/pipeline-defaults';
import { isActivePhase } from '@/shared/ticket-phase';
import type { Page, ProjectId, Ticket } from '@/shared/types';

import { ProjectTaskComposer } from './ProjectTaskComposer';
import { $tickets, ticketApi } from './state';

const relativeTime = (timestamp: number): string => {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) {
    return 'Just now';
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
};

const taskStatus = (ticket: Ticket): string => {
  if (ticket.phase === 'error') {
    return 'Needs your attention';
  }
  if (ticket.phase === 'completed') {
    return 'Ready to check';
  }
  if (ticket.phase && isActivePhase(ticket.phase)) {
    return 'Omni is working';
  }
  return 'To do';
};

const HomeChoice = memo(
  ({
    icon,
    title,
    description,
    onClick,
  }: {
    icon: React.ReactNode;
    title: string;
    description: string;
    onClick: () => void;
  }) => (
    <Button
      type="button"
      variant="outline"
      className="h-auto min-h-28 items-start justify-start gap-3 whitespace-normal p-4 text-left"
      onClick={onClick}
    >
      <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="mt-1 block text-sm font-normal text-muted-foreground">{description}</span>
      </span>
    </Button>
  )
);
HomeChoice.displayName = 'HomeChoice';

export const ProjectHome = memo(({ projectId }: { projectId: ProjectId }) => {
  const store = useStore(persistedStoreApi.$atom);
  const pages = useStore($pages);
  const ticketMap = useStore($tickets);
  const [homeContent, setHomeContent] = useState('');
  const [taskComposerOpen, setTaskComposerOpen] = useState(false);

  const project = useMemo(
    () => store.projects.find((candidate) => candidate.id === projectId),
    [projectId, store.projects]
  );
  const rootPage = useMemo(
    () => Object.values(pages).find((page) => page.projectId === projectId && page.isRoot),
    [pages, projectId]
  );
  const recentPages = useMemo(
    () =>
      Object.values(pages)
        .filter((page) => page.projectId === projectId && !page.isRoot)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 5),
    [pages, projectId]
  );
  const terminalColumns = useMemo(() => doneColumnIds(project?.pipeline ?? DEFAULT_PIPELINE), [project?.pipeline]);
  const nextTasks = useMemo(
    () =>
      Object.values(ticketMap)
        .filter(
          (ticket) => ticket.projectId === projectId && !ticket.archivedAt && !terminalColumns.has(ticket.columnId)
        )
        .sort((a, b) => {
          const attentionA =
            taskStatus(a) === 'Needs your attention'
              ? 0
              : taskStatus(a) === 'Ready to check'
                ? 1
                : taskStatus(a) === 'Omni is working'
                  ? 2
                  : 3;
          const attentionB =
            taskStatus(b) === 'Needs your attention'
              ? 0
              : taskStatus(b) === 'Ready to check'
                ? 1
                : taskStatus(b) === 'Omni is working'
                  ? 2
                  : 3;
          return attentionA - attentionB || b.updatedAt - a.updatedAt;
        })
        .slice(0, 5),
    [projectId, terminalColumns, ticketMap]
  );

  useEffect(() => {
    if (!rootPage) {
      setHomeContent('');
      return;
    }
    let cancelled = false;
    void pageApi.readContent(rootPage.id).then((content) => {
      if (!cancelled) {
        setHomeContent(content);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [rootPage]);

  const handleOpenHomePage = useCallback(() => {
    if (rootPage) {
      ticketApi.goToPage(rootPage.id, projectId);
    }
  }, [projectId, rootPage]);

  const handleNewPage = useCallback(async () => {
    if (!rootPage) {
      return;
    }
    const siblings = Object.values($pages.get()).filter((page) => page.parentId === rootPage.id);
    const created = await pageApi.addPage({
      projectId,
      parentId: rootPage.id,
      title: 'Untitled',
      sortOrder: siblings.reduce((max, page) => Math.max(max, page.sortOrder), 0) + 1,
    });
    ticketApi.goToPage(created.id, projectId);
  }, [projectId, rootPage]);

  const handleAskOmni = useCallback(async () => {
    const tab = await codeApi.addTab();
    await codeApi.setTabProject(tab.id, projectId);
    codeApi.setLayoutMode('focus');
    await persistedStoreApi.setKey('layoutMode', 'chat');
  }, [projectId]);

  if (!project) {
    return null;
  }

  const isEmpty = !homeContent.trim() && recentPages.length === 0 && nextTasks.length === 0;

  return (
    <div className="h-full overflow-y-auto px-6 py-6" data-slot="project-home">
      <div className="mx-auto w-full max-w-5xl space-y-10">
        {isEmpty ? (
          <section>
            <h2 className="font-display text-xl font-semibold tracking-tight">What would you like to do?</h2>
            <p className="mt-1 text-sm text-muted-foreground">Start with a page, a task, or a conversation.</p>
            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <HomeChoice
                icon={<FilePlus2 />}
                title="Write a page"
                description="Capture notes, plans, research, or ideas."
                onClick={() => void handleNewPage()}
              />
              <HomeChoice
                icon={<ListTodo />}
                title="Add a task"
                description="Keep track of something you want to accomplish."
                onClick={() => setTaskComposerOpen(true)}
              />
              <HomeChoice
                icon={<MessageSquarePlus />}
                title="Ask Omni"
                description="Get help thinking, writing, researching, or doing."
                onClick={() => void handleAskOmni()}
              />
            </div>
          </section>
        ) : (
          <>
            <section>
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-sm font-medium">Project home</h2>
                <Button size="sm" variant="ghost" onClick={handleOpenHomePage}>
                  {homeContent.trim() ? 'Edit' : 'Write an introduction'}
                  <ArrowRight />
                </Button>
              </div>
              {homeContent.trim() ? (
                <div className="prose prose-sm line-clamp-8 max-w-3xl text-foreground dark:prose-invert">
                  <Markdown>{homeContent}</Markdown>
                </div>
              ) : (
                <p className="max-w-2xl text-sm text-muted-foreground">
                  Add a description, goals, notes, or anything else you want to keep at the heart of this project.
                </p>
              )}
            </section>

            <div className="grid gap-10 md:grid-cols-2">
              <section>
                <div className="mb-2 flex items-center gap-2">
                  <h2 className="min-w-0 flex-1 text-sm font-medium">Recent pages</h2>
                  <Button size="sm" variant="ghost" onClick={() => void handleNewPage()}>
                    <Plus />
                    New
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => ticketApi.goToProject(projectId, 'pages')}>
                    View all
                  </Button>
                </div>
                {recentPages.length ? (
                  <div className="space-y-1">
                    {recentPages.map((page: Page) => (
                      <Button
                        key={page.id}
                        variant="ghost"
                        className="h-auto w-full justify-start gap-3 px-3 py-2 text-left font-normal"
                        onClick={() => ticketApi.goToPage(page.id, projectId)}
                      >
                        <FileText className="text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{page.title || 'Untitled'}</span>
                        <span className="text-xs text-muted-foreground">{relativeTime(page.updatedAt)}</span>
                      </Button>
                    ))}
                  </div>
                ) : (
                  <p className="rounded-lg bg-muted/40 px-3 py-4 text-sm text-muted-foreground">No pages yet.</p>
                )}
              </section>

              <section>
                <div className="mb-2 flex items-center gap-2">
                  <h2 className="min-w-0 flex-1 text-sm font-medium">Next tasks</h2>
                  <Button size="sm" variant="ghost" onClick={() => setTaskComposerOpen(true)}>
                    <Plus />
                    New
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => ticketApi.goToProject(projectId, 'tasks')}>
                    View all
                  </Button>
                </div>
                {nextTasks.length ? (
                  <div className="space-y-1">
                    {nextTasks.map((ticket) => (
                      <Button
                        key={ticket.id}
                        variant="ghost"
                        className="h-auto w-full justify-start gap-3 px-3 py-2 text-left font-normal"
                        onClick={() => ticketApi.goToTicket(ticket.id)}
                      >
                        <ListTodo className="text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{ticket.title}</span>
                        <span className="text-xs text-muted-foreground">{taskStatus(ticket)}</span>
                      </Button>
                    ))}
                  </div>
                ) : (
                  <p className="rounded-lg bg-muted/40 px-3 py-4 text-sm text-muted-foreground">Nothing to do yet.</p>
                )}
              </section>
            </div>
          </>
        )}
      </div>

      <ProjectTaskComposer projectId={projectId} open={taskComposerOpen} onOpenChange={setTaskComposerOpen} />
    </div>
  );
});
ProjectHome.displayName = 'ProjectHome';
