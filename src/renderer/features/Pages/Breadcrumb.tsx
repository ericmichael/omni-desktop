import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo } from 'react';
import { ChevronRight12Regular } from '@fluentui/react-icons';
import { makeStyles, tokens } from '@fluentui/react-components';

import { persistedStoreApi } from '@/renderer/services/store';
import { ticketApi } from '@/renderer/features/Tickets/state';
import type { PageId, ProjectId } from '@/shared/types';

import { $pages } from './state';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    flexWrap: 'wrap',
    paddingBottom: tokens.spacingVerticalXS,
  },
  crumb: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    cursor: 'pointer',
    border: 'none',
    backgroundColor: 'transparent',
    padding: '2px 4px',
    borderRadius: '4px',
    ':hover': {
      color: tokens.colorNeutralForeground2,
      backgroundColor: tokens.colorSubtleBackgroundHover,
    },
  },
  crumbCurrent: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground1,
    padding: '2px 4px',
    fontWeight: tokens.fontWeightMedium,
  },
  separator: {
    color: tokens.colorNeutralForeground4,
    flexShrink: 0,
  },
});

type BreadcrumbProps = {
  projectId: ProjectId;
  pageId: PageId;
};

export const PageBreadcrumb = memo(({ projectId, pageId }: BreadcrumbProps) => {
  const styles = useStyles();
  const pages = useStore($pages);
  const store = useStore(persistedStoreApi.$atom);

  const project = useMemo(() => store.projects.find((p) => p.id === projectId), [store.projects, projectId]);

  // Walk parentId chain to build breadcrumb trail
  const trail = useMemo(() => {
    const crumbs: { id: PageId; title: string }[] = [];
    let current = pages[pageId];
    while (current) {
      crumbs.unshift({ id: current.id, title: current.title });
      current = current.parentId ? pages[current.parentId] : undefined;
    }
    return crumbs;
  }, [pages, pageId]);

  const handleProjectClick = useCallback(() => {
    ticketApi.goToProject(projectId);
  }, [projectId]);

  const handleCrumbClick = useCallback(
    (id: PageId) => {
      ticketApi.goToPage(id, projectId);
    },
    [projectId]
  );

  if (!project) return null;

  return (
    <nav className={styles.root}>
      <button type="button" className={styles.crumb} onClick={handleProjectClick}>
        {project.label}
      </button>
      {trail.map((crumb, i) => {
        const isLast = i === trail.length - 1;
        return (
          <span key={crumb.id} style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
            <ChevronRight12Regular className={styles.separator} />
            {isLast ? (
              <span className={styles.crumbCurrent}>{crumb.title}</span>
            ) : (
              <button type="button" className={styles.crumb} onClick={() => handleCrumbClick(crumb.id)}>
                {crumb.title}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
});
PageBreadcrumb.displayName = 'PageBreadcrumb';
