import { makeStyles, shorthands,Skeleton, SkeletonItem, tokens } from '@fluentui/react-components';
import { ArrowLeft20Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { lazy, memo, Suspense, useCallback, useEffect, useMemo,useReducer, useRef, useState } from 'react';

import { currentContent, editorReducer, type EditorState } from '@/lib/page-editor-state';
import { IconButton } from '@/renderer/ds';
import { NotebookView } from '@/renderer/features/Notebooks/NotebookView';
import { ticketApi } from '@/renderer/features/Tickets/state';
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

/** Debounce for auto-save after a local edit. Short enough to feel instant. */
const SAVE_DEBOUNCE_MS = 400;
/** How long the "Saved" affordance stays visible after a successful save. */
const SAVED_AFFORDANCE_MS = 1200;

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    width: '100%',
  },
  header: {
    flexShrink: 0,
    paddingLeft: tokens.spacingHorizontalXXL,
    paddingRight: tokens.spacingHorizontalXXL,
    paddingTop: tokens.spacingVerticalXXL,
    paddingBottom: tokens.spacingVerticalS,
    maxWidth: '900px',
    width: '100%',
    boxSizing: 'border-box',
  },
  backRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
  },
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
  },
  titleInputLarge: {
    flex: 1,
    fontSize: '32px',
    fontWeight: tokens.fontWeightBold,
    border: 'none',
    backgroundColor: 'transparent',
    padding: '0',
    outline: 'none',
    color: tokens.colorNeutralForeground1,
    lineHeight: '1.2',
    '::placeholder': {
      color: tokens.colorNeutralForeground4,
    },
  },
  titleInput: {
    flex: 1,
    fontSize: tokens.fontSizeBase600,
    fontWeight: tokens.fontWeightBold,
    border: 'none',
    backgroundColor: 'transparent',
    padding: '0',
    outline: 'none',
    color: tokens.colorNeutralForeground1,
    lineHeight: tokens.lineHeightBase600,
    '::placeholder': {
      color: tokens.colorNeutralForeground4,
    },
  },
  /* Subtle save affordance — appears briefly, never demands attention. */
  saveIndicator: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    userSelect: 'none',
    whiteSpace: 'nowrap',
    transition: 'opacity 200ms ease',
  },
  banner: {
    marginLeft: tokens.spacingHorizontalXXL,
    marginRight: tokens.spacingHorizontalXXL,
    marginTop: tokens.spacingVerticalS,
    marginBottom: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
    backgroundColor: tokens.colorNeutralBackground3,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    borderRadius: tokens.borderRadiusLarge,
    maxWidth: '900px',
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
  },
  bannerText: {
    flex: '1 1 auto',
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
  },
  bannerButtons: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    flexShrink: 0,
  },
  bannerButton: {
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    border: 'none',
    cursor: 'pointer',
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    ':hover': {
      backgroundColor: tokens.colorSubtleBackgroundHover,
    },
  },
  bannerButtonPrimary: {
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    ...shorthands.border('1px', 'solid', tokens.colorBrandBackground),
    ':hover': {
      backgroundColor: tokens.colorBrandBackgroundHover,
    },
  },
  body: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
  },
  /**
   * Content column for everything inside the scroll viewport. Width and
   * horizontal padding are split between this wrapper (spacingHorizontalM)
   * and ContextEditor's internal root padding (spacingHorizontalM), so
   * blocks end up exactly `spacingHorizontalXXL` from the left edge — the
   * same offset the header uses for the title and PropertyStrip. This is
   * what keeps paragraphs, headings, and list items visually aligned with
   * the title above them.
   *
   * The editor keeps its own internal padding so Yoopta's floating block
   * actions (drag handle, "+" menu) still have a gutter to render into
   * without clipping.
   */
  bodyInner: {
    maxWidth: '900px',
    width: '100%',
    boxSizing: 'border-box',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
  },
  childPages: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    paddingLeft: tokens.spacingHorizontalXXL,
    paddingRight: tokens.spacingHorizontalXXL,
    paddingTop: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalM,
    maxWidth: '900px',
    ...shorthands.borderTop('1px', 'solid', tokens.colorNeutralStroke1),
  },
  childPageLink: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    padding: '6px 8px',
    borderRadius: '6px',
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    color: tokens.colorNeutralForeground1,
    fontSize: tokens.fontSizeBase300,
    textAlign: 'left',
    width: '100%',
    ':hover': {
      backgroundColor: tokens.colorSubtleBackgroundHover,
    },
  },
  childPageIcon: {
    fontSize: '16px',
    flexShrink: 0,
  },

  // Skeleton shown while the editor chunk downloads (cold start) or while the
  // initial page content is being read from disk. The horizontal padding here
  // (spacingHorizontalM) combines with the bodyInner wrapper's same padding
  // to match ContextEditor's total left offset of spacingHorizontalXXL, so
  // there is no horizontal layout shift when the editor replaces the skeleton.
  editorSkeleton: {
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalM,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  skelLine1: { width: '92%' },
  skelLine2: { width: '78%' },
  skelLine3: { width: '88%' },
  skelLine4: { width: '65%' },
  notebookBody: {
    flex: '1 1 0',
    minHeight: 0,
  },
});

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type PageViewProps = {
  pageId: PageId;
  projectId: ProjectId;
};

const navigateUpPageHierarchy = (pageId: PageId, projectId: ProjectId, pages: ReturnType<typeof $pages.get>) => {
  const page = pages[pageId];
  if (!page?.parentId) {
    ticketApi.goToProject(projectId);
    return;
  }

  const parent = pages[page.parentId];
  if (parent?.isRoot) {
    ticketApi.goToProject(projectId);
    return;
  }

  ticketApi.goToPage(page.parentId, projectId);
};

const DocPageView = memo(({ pageId, projectId }: PageViewProps) => {
  const styles = useStyles();
  const pages = useStore($pages);
  const page = pages[pageId];

  const handleBack = useCallback(() => {
    navigateUpPageHierarchy(pageId, projectId, pages);
  }, [pageId, projectId, pages]);

  const [state, dispatch] = useReducer(editorReducer, { kind: 'loading' } as EditorState);
  /** Key used to force the ContextEditor to remount with new content after an auto-reload or conflict resolution. */
  const [editorKey, setEditorKey] = useState(0);
  /** Brief "Saved" affordance visibility. */
  const [justSaved, setJustSaved] = useState(false);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Latest local content — mirrors state for use inside stable callbacks. */
  const latestLocal = useRef('');

  // Title editing state
  const [title, setTitle] = useState(page?.title ?? '');
  useEffect(() => {
    if (page) {
setTitle(page.title);
}
  }, [page]);

  // -------------------------------------------------------------------------
  // Subscribe to the page file on mount; unsubscribe on unmount.
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    // State stays in `loading` until the disk read completes. That means the
    // editor never mounts with transient empty content — it mounts exactly
    // once with the real content, no remount flash on first open.
    void pageApi.watch(pageId).then((content) => {
      if (cancelled) {
return;
}
      dispatch({ type: 'loaded', content });
      latestLocal.current = content;
    });

    const offChange = pageApi.onExternalChange(pageId, (content) => {
      dispatch({ type: 'external-change', content });
      // If we were clean, the reducer auto-reloads and we bump the editor key
      // so the ContextEditor picks up the new content. When dirty, we stay
      // dirty and show the banner; the editor key stays the same so the user
      // keeps their in-progress edits.
      setEditorKey((k) => k + 1);
    });

    const offDelete = pageApi.onExternalDelete(pageId, () => {
      dispatch({ type: 'external-delete' });
      setEditorKey((k) => k + 1);
    });

    return () => {
      cancelled = true;
      offChange();
      offDelete();
      // Flush any pending save before unsubscribing.
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        void pageApi.writeContent(pageId, latestLocal.current);
      }
      void pageApi.unwatch(pageId);
    };
  }, [pageId]);

  // -------------------------------------------------------------------------
  // Debounced save — fires whenever the editor becomes dirty.
  // -------------------------------------------------------------------------
  const scheduleSave = useCallback(
    (content: string) => {
      if (saveTimer.current) {
clearTimeout(saveTimer.current);
}
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        dispatch({ type: 'save-start' });
        void pageApi.writeContent(pageId, content).then(() => {
          dispatch({ type: 'save-done' });
          setJustSaved(true);
          if (savedTimer.current) {
clearTimeout(savedTimer.current);
}
          savedTimer.current = setTimeout(() => setJustSaved(false), SAVED_AFFORDANCE_MS);
        });
      }, SAVE_DEBOUNCE_MS);
    },
    [pageId]
  );

  const handleMarkdownChange = useCallback(
    (md: string) => {
      latestLocal.current = md;
      dispatch({ type: 'local-edit', content: md });
      scheduleSave(md);
    },
    [scheduleSave]
  );

  // Cleanup the "Saved" timer on unmount.
  useEffect(() => {
    return () => {
      if (savedTimer.current) {
clearTimeout(savedTimer.current);
}
    };
  }, []);

  // -------------------------------------------------------------------------
  // Title save — for root pages, also update the project label.
  // -------------------------------------------------------------------------
  const handleTitleBlur = useCallback(() => {
    const trimmed = title.trim();
    if (trimmed && page && trimmed !== page.title) {
      void pageApi.updatePage(pageId, { title: trimmed });
      if (page.isRoot) {
        void ticketApi.updateProject(projectId, { label: trimmed });
      }
    }
  }, [title, page, pageId, projectId]);

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
  // Conflict resolution
  // -------------------------------------------------------------------------
  const handleUseDisk = useCallback(() => {
    if (state.kind !== 'conflict') {
return;
}
    // Cancel any pending save — we're dropping the local copy.
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    latestLocal.current = state.diskContent;
    dispatch({ type: 'resolve-use-disk' });
    setEditorKey((k) => k + 1);
  }, [state]);

  const handleKeepLocal = useCallback(() => {
    if (state.kind !== 'conflict') {
return;
}
    dispatch({ type: 'resolve-keep-local' });
    // Schedule an immediate save so local wins on disk.
    scheduleSave(state.localContent);
  }, [state, scheduleSave]);

  // -------------------------------------------------------------------------
  // Child pages
  // -------------------------------------------------------------------------
  const childPages = useMemo(() => {
    return Object.values(pages)
      .filter((p) => p.parentId === pageId)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }, [pages, pageId]);

  const handleChildClick = useCallback(
    (childId: PageId) => {
      ticketApi.goToPage(childId, projectId);
    },
    [projectId]
  );

  if (!page) {
return null;
}

  const showConflict = state.kind === 'conflict';
  const editorContent = currentContent(state);
  const saveLabel =
    state.kind === 'dirty' && state.saving
      ? 'Saving…'
      : state.kind === 'dirty'
        ? 'Unsaved'
        : justSaved
          ? 'Saved'
          : '';

  return (
    <div className={styles.root}>
      {/* Header: Back + Breadcrumb + Title + save affordance */}
      <div className={styles.header}>
        {!page.isRoot && (
          <div className={styles.backRow}>
            <IconButton
              aria-label="Back"
              icon={<ArrowLeft20Regular />}
              size="sm"
              onClick={handleBack}
            />
            <PageBreadcrumb projectId={projectId} pageId={pageId} />
          </div>
        )}
        <div className={styles.titleRow}>
          <input
            className={page.isRoot ? styles.titleInputLarge : styles.titleInput}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={handleTitleBlur}
            onKeyDown={handleTitleKeyDown}
            placeholder="Untitled"
          />
          <span className={styles.saveIndicator} aria-live="polite">
            {saveLabel}
          </span>
        </div>
      </div>

      {/* External-change banner */}
      {showConflict && (
        <div className={styles.banner} role="status">
          <span className={styles.bannerText}>
            This page was updated somewhere else. Your changes haven’t been saved over it yet.
          </span>
          <div className={styles.bannerButtons}>
            <button type="button" className={styles.bannerButton} onClick={handleUseDisk}>
              Use the newer version
            </button>
            <button
              type="button"
              className={`${styles.bannerButton} ${styles.bannerButtonPrimary}`}
              onClick={handleKeepLocal}
            >
              Keep my version
            </button>
          </div>
        </div>
      )}

      {/* Editor body */}
      <div className={styles.body}>
        <div className={styles.bodyInner}>
          {state.kind === 'loading' ? (
            <EditorSkeleton />
          ) : (
            <Suspense fallback={<EditorSkeleton />}>
              <ContextEditor
                key={`${pageId}-${editorKey}`}
                initialMarkdown={editorContent}
                onChangeMarkdown={handleMarkdownChange}
              />
            </Suspense>
          )}
        </div>

        {/* Child pages list */}
        {childPages.length > 0 && (
          <div className={styles.childPages}>
            {childPages.map((child) => (
              <button
                key={child.id}
                type="button"
                className={styles.childPageLink}
                onClick={() => handleChildClick(child.id)}
              >
                <span className={styles.childPageIcon}>{child.icon ?? '📄'}</span>
                {child.title}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
DocPageView.displayName = 'DocPageView';

const NotebookPageView = memo(({ pageId, projectId }: PageViewProps) => {
  const styles = useStyles();
  const pages = useStore($pages);
  const page = pages[pageId];
  const [title, setTitle] = useState(page?.title ?? '');

  useEffect(() => {
    if (page) {
      setTitle(page.title);
    }
  }, [page]);

  const handleBack = useCallback(() => {
    navigateUpPageHierarchy(pageId, projectId, pages);
  }, [pageId, projectId, pages]);

  const handleTitleBlur = useCallback(() => {
    const trimmed = title.trim();
    if (trimmed && page && trimmed !== page.title) {
      void pageApi.updatePage(pageId, { title: trimmed });
      if (page.isRoot) {
        void ticketApi.updateProject(projectId, { label: trimmed });
      }
    }
  }, [title, page, pageId, projectId]);

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
    <div className={styles.root}>
      <div className={styles.header}>
        {!page.isRoot && (
          <div className={styles.backRow}>
            <IconButton aria-label="Back" icon={<ArrowLeft20Regular />} size="sm" onClick={handleBack} />
            <PageBreadcrumb projectId={projectId} pageId={pageId} />
          </div>
        )}
        <div className={styles.titleRow}>
          <input
            className={page.isRoot ? styles.titleInputLarge : styles.titleInput}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={handleTitleBlur}
            onKeyDown={handleTitleKeyDown}
            placeholder="Untitled"
          />
        </div>
      </div>
      <div className={styles.notebookBody}>
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
  const styles = useStyles();
  return (
    <div className={styles.editorSkeleton} aria-label="Loading editor" role="status">
      <Skeleton>
        <SkeletonItem size={16} className={styles.skelLine1} />
        <SkeletonItem size={16} className={styles.skelLine2} />
        <SkeletonItem size={16} className={styles.skelLine3} />
        <SkeletonItem size={16} className={styles.skelLine4} />
      </Skeleton>
    </div>
  );
});
EditorSkeleton.displayName = 'EditorSkeleton';
