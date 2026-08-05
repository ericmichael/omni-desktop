import { useStore } from '@nanostores/react';
import { useSelector } from '@xstate/react';
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useState } from 'react';

import { cn } from '@/renderer/ds/cn';
import { Alert, AlertDescription } from '@/renderer/ds/ui/alert';
import { Button } from '@/renderer/ds/ui/button';
import { ButtonGroup } from '@/renderer/ds/ui/button-group';
import { Input } from '@/renderer/ds/ui/input';
import { Skeleton } from '@/renderer/ds/ui/skeleton';
import { NotebookView } from '@/renderer/features/Notebooks/NotebookView';
import { acquirePageEditor, releasePageEditor } from '@/renderer/features/Pages/page-editor-registry';
import type { PageId, ProjectId } from '@/shared/types';

import { PageBreadcrumb } from './Breadcrumb';
import { $pages, pageApi } from './state';

/**
 * Kick off the ContextEditor chunk download the moment this module is parsed.
 * PageView is statically imported by the Tickets feature tree, so the chunk
 * begins loading as soon as the user opens the Tickets tab — well before they
 * click an inbox row or a sidebar page. By the time the editor actually needs
 * to mount, the promise is typically already resolved, so React.lazy resolves
 * synchronously and there is no Suspense suspend on first open.
 *
 * The skeleton fallback below is the safety net for the cold case (slow disk,
 * first run, dev-mode HMR), not the common case.
 */
const contextEditorPromise = import('@/renderer/features/Tickets/ContextEditor');
const ContextEditor = lazy(() => contextEditorPromise.then((m) => ({ default: m.ContextEditor })));

/** How long the "Saved" affordance stays visible after a successful save. */
const SAVED_AFFORDANCE_MS = 1200;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type PageViewProps = {
  pageId: PageId;
  projectId: ProjectId;
};

const DocPageView = memo(({ pageId, projectId }: PageViewProps) => {
  const pages = useStore($pages);
  const page = pages[pageId];

  // -------------------------------------------------------------------------
  // Per-page editor actor.
  //
  // The actor owns the editor's content, dirty/clean/conflict state, the
  // file watcher, and the debounced save. It lives in a module-level
  // registry keyed by pageId, NOT inside this component, which is what
  // makes navigation races safe: switching pageId means acquiring a
  // different actor, not reusing this component's closures on new data.
  //
  // useMemo gives us a stable reference for the lifetime of this pageId;
  // the cleanup effect releases it when pageId changes or on unmount.
  // -------------------------------------------------------------------------
  const actor = useMemo(() => acquirePageEditor(pageId), [pageId]);
  useEffect(() => {
    return () => releasePageEditor(pageId);
  }, [pageId]);

  const phase = useSelector(actor, (s) => {
    // `s.value` is a string in top-level states and `{ dirty: 'debouncing' | 'saving' }`
    // while dirty — collapse both to a flat phase for the view.
    if (typeof s.value === 'object' && s.value !== null && 'dirty' in s.value) {
      return 'dirty' as const;
    }
    return s.value as 'loading' | 'clean' | 'conflict' | 'flushing' | 'disposed';
  });
  const isSaving = useSelector(actor, (s) => s.matches({ dirty: 'saving' }));
  const content = useSelector(actor, (s) => s.context.content);
  const revision = useSelector(actor, (s) => s.context.revision);

  const handleMarkdownChange = useCallback(
    (md: string) => {
      actor.send({ type: 'LOCAL_EDIT', content: md });
    },
    [actor]
  );

  // -------------------------------------------------------------------------
  // "Saved" affordance — flashes briefly on dirty → clean transitions.
  // -------------------------------------------------------------------------
  const [justSaved, setJustSaved] = useState(false);
  useEffect(() => {
    let wasDirty = false;
    let flashTimer: ReturnType<typeof setTimeout> | null = null;
    const sub = actor.subscribe((s) => {
      const isDirty = typeof s.value === 'object' && s.value !== null && 'dirty' in s.value;
      if (isDirty) {
        wasDirty = true;
        return;
      }
      if (s.matches('clean') && wasDirty) {
        wasDirty = false;
        setJustSaved(true);
        if (flashTimer) {
          clearTimeout(flashTimer);
        }
        flashTimer = setTimeout(() => setJustSaved(false), SAVED_AFFORDANCE_MS);
      }
    });
    return () => {
      sub.unsubscribe();
      if (flashTimer) {
        clearTimeout(flashTimer);
      }
    };
  }, [actor]);

  // Title editing state
  const [title, setTitle] = useState(page?.title ?? '');
  useEffect(() => {
    if (page) {
      setTitle(page.title);
    }
  }, [page]);

  const handleTitleBlur = useCallback(() => {
    const trimmed = title.trim();
    if (trimmed && page && !page.isRoot && trimmed !== page.title) {
      void pageApi.updatePage(pageId, { title: trimmed });
    }
  }, [title, page, pageId]);

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleTitleBlur();
      }
    },
    [handleTitleBlur]
  );

  // -------------------------------------------------------------------------
  // Conflict resolution — delegated to the machine.
  // -------------------------------------------------------------------------
  const handleUseDisk = useCallback(() => {
    actor.send({ type: 'RESOLVE_USE_DISK' });
  }, [actor]);

  const handleKeepLocal = useCallback(() => {
    actor.send({ type: 'RESOLVE_KEEP_LOCAL' });
  }, [actor]);

  if (!page) {
    return null;
  }

  const showConflict = phase === 'conflict';
  const saveLabel =
    phase === 'dirty' && isSaving ? 'Saving…' : phase === 'dirty' ? 'Unsaved' : justSaved ? 'Saved' : '';

  // Agent-authored documents often open with an H1 that repeats the page
  // title; rendering the title input above it shows the same heading twice.
  // Let the document's own H1 be the visible title in that case (the row
  // reappears as soon as the leading H1 stops matching). The context page's
  // fixed "Context" title never collides with body H1s, so it always shows.
  const firstLine = (content ?? '').trimStart().split('\n', 1)[0] ?? '';
  const leadingH1 = /^#\s+(.+?)\s*$/.exec(firstLine)?.[1];
  const contentLeadsWithTitle =
    !page.isRoot && !!leadingH1 && leadingH1.trim().toLowerCase() === page.title.trim().toLowerCase();

  return (
    <div className="flex flex-col h-full w-full" data-slot="page-view">
      {/* Header: the standard sub-page recipe — ancestors-only breadcrumb
          above the page title. The context page (root) titles itself
          "Context"; renaming the project lives on Home, not here. */}
      <div className="shrink-0 flex flex-col gap-5 pl-8 pr-8 pt-8 pb-2 max-w-4xl w-full ml-auto mr-auto box-border">
        <div className="hidden items-center gap-1 sm:flex">
          <PageBreadcrumb projectId={projectId} pageId={pageId} />
        </div>
        {page.isRoot ? (
          <div className="flex items-center gap-4">
            <span className="flex-1 text-2xl font-semibold leading-8 text-foreground">Context</span>
            <span
              className="text-xs text-muted-foreground select-none whitespace-nowrap transition-opacity duration-200 ease-in-out"
              aria-live="polite"
            >
              {saveLabel}
            </span>
          </div>
        ) : !contentLeadsWithTitle ? (
          <div className="flex items-center gap-4">
            <Input
              aria-label="Page title"
              className={`${'flex-1 text-2xl font-semibold border-0 bg-transparent p-0 outline-none text-foreground leading-8 placeholder:text-muted-foreground'} h-auto`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={handleTitleBlur}
              onKeyDown={handleTitleKeyDown}
              placeholder="Untitled"
            />
            <span
              className="text-xs text-muted-foreground select-none whitespace-nowrap transition-opacity duration-200 ease-in-out"
              aria-live="polite"
            >
              {saveLabel}
            </span>
          </div>
        ) : (
          saveLabel && (
            <div className="flex items-center gap-4">
              <span
                className="text-xs text-muted-foreground select-none whitespace-nowrap transition-opacity duration-200 ease-in-out"
                aria-live="polite"
              >
                {saveLabel}
              </span>
            </div>
          )
        )}
      </div>

      {/* External-change banner */}
      {showConflict && (
        <Alert className="mx-8 my-2 flex max-w-4xl items-center gap-4" role="status" data-slot="page-conflict-banner">
          <AlertDescription className="min-w-0 flex-1 text-foreground">
            This page was updated somewhere else. Your changes haven’t been saved over it yet.
          </AlertDescription>
          <ButtonGroup className="shrink-0">
            <Button variant="outline" onClick={handleUseDisk}>
              Use the newer version
            </Button>
            <Button onClick={handleKeepLocal}>Keep my version</Button>
          </ButtonGroup>
        </Alert>
      )}

      {/* Editor body */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-4xl w-full ml-auto mr-auto box-border pl-4 pr-4">
          {phase === 'loading' ? (
            <EditorSkeleton />
          ) : (
            <Suspense fallback={<EditorSkeleton />}>
              <ContextEditor
                // Keying on revision forces a remount whenever the machine
                // swaps content out from under the editor (initial load,
                // silent auto-reload from external change, resolve-use-disk).
                // Keying additionally on pageId is defensive: the registry
                // already gives us a different actor per pageId, but the
                // key pins the invariant at the React layer too.
                key={`${pageId}-${revision}`}
                initialMarkdown={content}
                onChangeMarkdown={handleMarkdownChange}
              />
            </Suspense>
          )}
        </div>
      </div>
    </div>
  );
});
DocPageView.displayName = 'DocPageView';

const NotebookPageView = memo(({ pageId, projectId }: PageViewProps) => {
  const pages = useStore($pages);
  const page = pages[pageId];
  const [title, setTitle] = useState(page?.title ?? '');

  useEffect(() => {
    if (page) {
      setTitle(page.title);
    }
  }, [page]);

  const handleTitleBlur = useCallback(() => {
    const trimmed = title.trim();
    if (trimmed && page && !page.isRoot && trimmed !== page.title) {
      void pageApi.updatePage(pageId, { title: trimmed });
    }
  }, [title, page, pageId]);

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleTitleBlur();
      }
    },
    [handleTitleBlur]
  );

  if (!page) {
    return null;
  }

  return (
    <div className="flex flex-col h-full w-full">
      <div className="shrink-0 flex flex-col gap-5 pl-8 pr-8 pt-8 pb-2 max-w-4xl w-full ml-auto mr-auto box-border">
        <div className="hidden items-center gap-1 sm:flex">
          <PageBreadcrumb projectId={projectId} pageId={pageId} />
        </div>
        <div className="flex items-center gap-4">
          {page.isRoot ? (
            <span className="flex-1 text-2xl font-semibold leading-8 text-foreground">Context</span>
          ) : (
            <Input
              aria-label="Page title"
              className={`${'flex-1 text-2xl font-semibold border-0 bg-transparent p-0 outline-none text-foreground leading-8 placeholder:text-muted-foreground'} h-auto`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={handleTitleBlur}
              onKeyDown={handleTitleKeyDown}
              placeholder="Untitled"
            />
          )}
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <NotebookView pageId={pageId} />
      </div>
    </div>
  );
});
NotebookPageView.displayName = 'NotebookPageView';

/**
 * Dispatch on `page.kind`: notebook pages mount the marimo extension webview;
 * everything else uses the Yoopta-based DocPageView. Keeps hook order stable
 * because the dispatcher itself only ever runs one hook.
 */
export const PageView = memo(({ pageId, projectId }: PageViewProps) => {
  const pages = useStore($pages);
  const page = pages[pageId];
  if (page?.kind === 'notebook') {
    return <NotebookPageView pageId={pageId} projectId={projectId} />;
  }
  return <DocPageView pageId={pageId} projectId={projectId} />;
});
PageView.displayName = 'PageView';

/**
 * Placeholder shown while either (a) the disk read is in flight or (b) the
 * lazy-loaded editor chunk is still downloading. Matches the editor's padding
 * and max-width so swapping to the real editor causes no layout shift.
 */
const EditorSkeleton = memo(() => {
  return (
    <div className="pl-4 pr-4 pt-4 pb-4 flex flex-col gap-4" aria-label="Loading editor" role="status">
      <Skeleton className={cn('h-4', 'w-11/12')} />
      <Skeleton className={cn('h-4', 'w-4/5')} />
      <Skeleton className={cn('h-4', 'w-11/12')} />
      <Skeleton className={cn('h-4', 'w-2/3')} />
    </div>
  );
});
EditorSkeleton.displayName = 'EditorSkeleton';
