import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  Add16Regular,
  DocumentText16Regular,
  MoreHorizontal16Regular,
  Notebook20Regular,
  TextDescription20Regular,
} from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';

import { flattenPageTree } from '@/lib/page-list';
import {
  Badge,
  Button,
  Caption1,
  IconButton,
  Input,
  Menu,
  MenuDivider,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
} from '@/renderer/ds';
import { $pages, pageApi } from '@/renderer/features/Pages/state';
import type { Page, ProjectId } from '@/shared/types';

import { ProjectPageHeader } from './ProjectPageHeader';
import { ticketApi } from './state';

const useStyles = makeStyles({
  root: {
    height: '100%',
    overflowY: 'auto',
  },
  container: {
    maxWidth: '720px',
    marginLeft: 'auto',
    marginRight: 'auto',
    paddingLeft: '16px',
    paddingRight: '16px',
    paddingTop: '24px',
    paddingBottom: '48px',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  /* The container already pads horizontally — zero the header's own padding
     so the title aligns with the page rows. */
  pageHeader: {
    paddingLeft: 0,
    paddingRight: 0,
    paddingTop: 0,
    paddingBottom: '8px',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingRight: '4px',
    paddingTop: '6px',
    paddingBottom: '6px',
    borderRadius: tokens.borderRadiusMedium,
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
    ':hover .page-row-actions': { opacity: 1 },
  },
  rowBtn: {
    flex: '1 1 0',
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    border: 'none',
    backgroundColor: 'transparent',
    padding: 0,
    cursor: 'pointer',
    textAlign: 'left',
    color: tokens.colorNeutralForeground1,
  },
  rowIcon: { flexShrink: 0, color: tokens.colorNeutralForeground3, display: 'inline-flex' },
  rowTitle: {
    flex: '0 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase300,
  },
  rowActions: {
    flexShrink: 0,
    opacity: 0,
    transitionProperty: 'opacity',
    transitionDuration: tokens.durationFaster,
  },
  emojiIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '16px',
    height: '16px',
    fontSize: '0.8125rem',
    lineHeight: 1,
    flexShrink: 0,
  },
  renameInput: {
    flex: '1 1 0',
    minWidth: 0,
  },
  empty: {
    paddingTop: '16px',
    color: tokens.colorNeutralForeground3,
    fontStyle: 'italic',
    fontSize: tokens.fontSizeBase300,
  },
});

type PageRowItemProps = {
  page: Page;
  depth: number;
  projectId: ProjectId;
  isContext?: boolean;
  renamingId: string | null;
  renameValue: string;
  onRenameValueChange: (value: string) => void;
  onStartRename: (page: Page) => void;
  onFinishRename: (pageId: string) => void;
  onCancelRename: () => void;
};

const PageRowItem = memo(
  ({
    page,
    depth,
    projectId,
    isContext = false,
    renamingId,
    renameValue,
    onRenameValueChange,
    onStartRename,
    onFinishRename,
    onCancelRename,
  }: PageRowItemProps) => {
    const styles = useStyles();
    const isRenaming = renamingId === page.id;

    const handleOpen = useCallback(() => ticketApi.goToPage(page.id, projectId), [page.id, projectId]);
    const handleStartRename = useCallback(() => onStartRename(page), [onStartRename, page]);
    const handleDelete = useCallback(() => void pageApi.removePage(page.id), [page.id]);
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

    const icon = isContext ? (
      <TextDescription20Regular style={{ width: 16, height: 16 }} />
    ) : page.icon ? (
      <span className={styles.emojiIcon}>{page.icon}</span>
    ) : (
      <DocumentText16Regular />
    );

    return (
      <div className={styles.row} style={{ paddingLeft: 8 + depth * 20 }}>
        {isRenaming ? (
          <Input
            value={renameValue}
            onChange={handleRenameChange}
            onKeyDown={handleRenameKeyDown}
            onBlur={handleRenameBlur}
            className={styles.renameInput}
            size="sm"
            autoFocus
          />
        ) : (
          <button type="button" className={styles.rowBtn} onClick={handleOpen}>
            <span className={styles.rowIcon}>{icon}</span>
            <span className={styles.rowTitle}>{page.title || 'Untitled'}</span>
            {isContext && <Badge color="blue">Context</Badge>}
            {page.kind === 'notebook' && <Caption1>notebook</Caption1>}
          </button>
        )}
        {!isContext && !isRenaming && (
          <span className={mergeClasses('page-row-actions', styles.rowActions)}>
            <Menu positioning={{ position: 'below', align: 'end' }}>
              <MenuTrigger>
                <IconButton aria-label="Page actions" icon={<MoreHorizontal16Regular />} size="sm" />
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  <MenuItem onClick={handleStartRename}>Rename</MenuItem>
                  <MenuDivider />
                  <MenuItem onClick={handleDelete}>Delete</MenuItem>
                </MenuList>
              </MenuPopover>
            </Menu>
          </span>
        )}
      </div>
    );
  }
);
PageRowItem.displayName = 'PageRowItem';

/**
 * The shell's Pages tab: the full page hierarchy as an indented flat list.
 * The root/context page is pinned first with a "Context" badge; everything
 * else renders depth-indented in `sortOrder` order.
 */
export const ProjectPagesTab = memo(({ projectId }: { projectId: ProjectId }) => {
  const styles = useStyles();
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

  return (
    <div className={styles.root} data-slot="project-pages-tab">
      <div className={styles.container}>
        <ProjectPageHeader
          projectId={projectId}
          title="Docs"
          actions={
            <>
              <Button size="sm" variant="ghost" leftIcon={<Add16Regular />} onClick={handleNewPage}>
                New page
              </Button>
              <Button
                size="sm"
                variant="ghost"
                leftIcon={<Notebook20Regular style={{ width: 16, height: 16 }} />}
                onClick={handleNewNotebook}
              >
                New notebook
              </Button>
            </>
          }
          className={styles.pageHeader}
        />

        {rootPage && (
          <PageRowItem
            page={rootPage}
            depth={0}
            projectId={projectId}
            isContext
            renamingId={renamingId}
            renameValue={renameValue}
            onRenameValueChange={setRenameValue}
            onStartRename={handleStartRename}
            onFinishRename={handleFinishRename}
            onCancelRename={handleCancelRename}
          />
        )}
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
        {entries.length === 0 && !rootPage && <div className={styles.empty}>No pages yet.</div>}
      </div>
    </div>
  );
});
ProjectPagesTab.displayName = 'ProjectPagesTab';
