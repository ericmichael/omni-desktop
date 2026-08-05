import { useStore } from '@nanostores/react';
import { Ellipsis, FileText, House, Notebook, Plus } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';

import { flattenPageTree } from '@/lib/page-list';
import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/renderer/ds/ui/dropdown-menu';
import { Input } from '@/renderer/ds/ui/input';
import { $pages, pageApi } from '@/renderer/features/Pages/state';
import type { Page, ProjectId } from '@/shared/types';

import { ticketApi } from './state';

type PageRowItemProps = {
  page: Page;
  depth: number;
  projectId: ProjectId;
  renamingId: string | null;
  renameValue: string;
  onRenameValueChange: (value: string) => void;
  onStartRename: (page: Page) => void;
  onFinishRename: (pageId: string) => void;
  onCancelRename: () => void;
};

function PageDepthIndent({ depth, children }: { depth: number; children: React.ReactNode }): React.JSX.Element {
  if (depth <= 0) {
    return <>{children}</>;
  }
  return (
    <div className="pl-5">
      <PageDepthIndent depth={depth - 1}>{children}</PageDepthIndent>
    </div>
  );
}

const PageRowItem = memo(
  ({
    page,
    depth,
    projectId,
    renamingId,
    renameValue,
    onRenameValueChange,
    onStartRename,
    onFinishRename,
    onCancelRename,
  }: PageRowItemProps) => {
    const isRenaming = renamingId === page.id;

    const handleOpen = useCallback(() => ticketApi.goToPage(page.id, projectId), [page.id, projectId]);
    const handleStartRename = useCallback(() => onStartRename(page), [onStartRename, page]);
    const handleRenameChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => onRenameValueChange(e.target.value),
      [onRenameValueChange]
    );
    const handleRenameBlur = useCallback(() => onFinishRename(page.id), [onFinishRename, page.id]);
    const handleRenameKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
          onFinishRename(page.id);
        } else if (e.key === 'Escape') {
          onCancelRename();
        }
      },
      [onFinishRename, onCancelRename, page.id]
    );

    const icon = page.icon ? (
      <span className="inline-flex items-center justify-center w-4 h-4 text-sm leading-none shrink-0">{page.icon}</span>
    ) : (
      <FileText />
    );

    return (
      <PageDepthIndent depth={depth}>
        <div className="flex items-center gap-2 rounded-lg py-1.5 pr-1 pl-2 hover:bg-accent [&:hover_.page-row-actions]:opacity-100">
          {isRenaming ? (
            <Input
              value={renameValue}
              onChange={handleRenameChange}
              onKeyDown={handleRenameKeyDown}
              onBlur={handleRenameBlur}
              className="flex-1 min-w-0"
              autoFocus
            />
          ) : (
            <Button
              type="button"
              variant="ghost"
              className="h-auto min-w-0 flex-1 justify-start gap-2 border-0 bg-transparent p-0 text-left font-normal text-foreground hover:bg-transparent"
              onClick={handleOpen}
            >
              <span className="shrink-0 text-muted-foreground inline-flex">{icon}</span>
              <span className="flex-initial min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-sm">
                {page.title || 'Untitled'}
              </span>
              {page.kind === 'notebook' && <span className="text-xs text-muted-foreground">notebook</span>}
            </Button>
          )}
          {!isRenaming && (
            <span className={cn('page-row-actions', 'shrink-0 opacity-0 transition-opacity duration-100')}>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="Page actions">
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>
                <>
                  <DropdownMenuContent>
                    <DropdownMenuItem onClick={handleStartRename}>Rename</DropdownMenuItem>
                  </DropdownMenuContent>
                </>
              </DropdownMenu>
            </span>
          )}
        </div>
      </PageDepthIndent>
    );
  }
);
PageRowItem.displayName = 'PageRowItem';

/**
 * The project's user-owned knowledge space: its home page and full nested
 * page hierarchy in `sortOrder` order.
 */
export const ProjectPagesTab = memo(({ projectId }: { projectId: ProjectId }) => {
  const pages = useStore($pages);

  const rootPage = useMemo(
    () => Object.values(pages).find((p) => p.projectId === projectId && p.isRoot),
    [pages, projectId]
  );
  const entries = useMemo(() => flattenPageTree(pages, projectId), [pages, projectId]);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const handleStartRename = useCallback((page: Page) => {
    setRenamingId(page.id);
    setRenameValue(page.title);
  }, []);
  const handleCancelRename = useCallback(() => {
    setRenamingId(null);
    setRenameValue('');
  }, []);
  const handleFinishRename = useCallback(
    (pageId: string) => {
      const trimmed = renameValue.trim();
      if (trimmed) {
        void pageApi.updatePage(pageId, { title: trimmed });
      }
      setRenamingId(null);
      setRenameValue('');
    },
    [renameValue]
  );

  const createPage = useCallback(
    async (kind?: Page['kind']) => {
      const all = $pages.get();
      const root = Object.values(all).find((p) => p.projectId === projectId && p.isRoot);
      if (!root) {
        return;
      }
      const siblings = Object.values(all).filter((p) => p.parentId === root.id);
      const maxSort = siblings.reduce((max, p) => Math.max(max, p.sortOrder), 0);
      const created = await pageApi.addPage({
        projectId,
        parentId: root.id,
        title: kind === 'notebook' ? 'Untitled notebook' : 'Untitled',
        sortOrder: maxSort + 1,
        ...(kind ? { kind } : {}),
      });
      ticketApi.goToPage(created.id, projectId);
    },
    [projectId]
  );
  const handleNewPage = useCallback(() => void createPage(), [createPage]);
  const handleNewNotebook = useCallback(() => void createPage('notebook'), [createPage]);
  const handleOpenHome = useCallback(() => {
    if (rootPage) {
      ticketApi.goToPage(rootPage.id, projectId);
    }
  }, [projectId, rootPage]);

  return (
    <div className="h-full overflow-y-auto" data-slot="project-pages-tab">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-1 px-6 py-6">
        <div className="mb-6 flex min-w-0 items-start gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-lg font-semibold tracking-tight">Pages</h2>
            <p className="mt-1 text-sm text-muted-foreground">Notes, plans, research, and ideas for this project.</p>
          </div>
          <Button size="sm" variant="ghost" onClick={handleNewPage}>
            <Plus />
            New page
          </Button>
          <Button size="sm" variant="ghost" onClick={handleNewNotebook}>
            <Notebook className="size-4" />
            New notebook
          </Button>
        </div>

        {rootPage && (
          <div className="mb-7 flex items-center gap-4 rounded-xl border p-4">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground">
              <House />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-medium">Project home</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">The introduction and home page for this project.</p>
            </div>
            <Button size="sm" variant="outline" onClick={handleOpenHome}>
              Open
            </Button>
          </div>
        )}

        <h3 className="mb-2 text-sm font-medium">All pages</h3>
        {entries.map(({ page, depth }) => (
          <PageRowItem
            key={page.id}
            page={page}
            depth={depth}
            projectId={projectId}
            renamingId={renamingId}
            renameValue={renameValue}
            onRenameValueChange={setRenameValue}
            onStartRename={handleStartRename}
            onFinishRename={handleFinishRename}
            onCancelRename={handleCancelRename}
          />
        ))}
        {entries.length === 0 && (
          <div className="pt-4 text-muted-foreground italic text-sm">No pages yet. Create one to start writing.</div>
        )}
      </div>
    </div>
  );
});
ProjectPagesTab.displayName = 'ProjectPagesTab';
