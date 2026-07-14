import { useStore } from '@nanostores/react';
import { Fragment, memo, useCallback, useMemo } from 'react';

import { Breadcrumb, BreadcrumbButton, BreadcrumbDivider, BreadcrumbItem } from '@/renderer/ds';
import { ticketApi } from '@/renderer/features/Tickets/state';
import { persistedStoreApi } from '@/renderer/services/store';
import type { PageId, ProjectId } from '@/shared/types';

import { $pages } from './state';

type BreadcrumbProps = {
  projectId: ProjectId;
  pageId: PageId;
};

/**
 * Ancestors-only breadcrumb for a doc page: "{Project} › Docs › [parents…]".
 * Same Fluent Breadcrumb as every other sub-page header; the page's own
 * title renders big underneath (the editable title input).
 */
export const PageBreadcrumb = memo(({ projectId, pageId }: BreadcrumbProps) => {
  const pages = useStore($pages);
  const store = useStore(persistedStoreApi.$atom);

  const project = useMemo(() => store.projects.find((p) => p.id === projectId), [store.projects, projectId]);

  // Walk parentId chain to build the ancestor trail (excluding this page —
  // it titles itself below the crumb). Skip root pages: the Docs crumb
  // already represents them (root page title is kept in sync with
  // project.label, so including it would render the project name twice).
  const trail = useMemo(() => {
    const crumbs: { id: PageId; title: string }[] = [];
    const self = pages[pageId];
    let current = self?.parentId ? pages[self.parentId] : undefined;
    while (current) {
      if (!current.isRoot) {
        crumbs.unshift({ id: current.id, title: current.title });
      }
      current = current.parentId ? pages[current.parentId] : undefined;
    }
    return crumbs;
  }, [pages, pageId]);

  const handleProjectClick = useCallback(() => {
    ticketApi.goToProject(projectId, 'home');
  }, [projectId]);

  const handleDocsClick = useCallback(() => {
    ticketApi.goToProject(projectId, 'pages');
  }, [projectId]);

  const handleCrumbClick = useCallback(
    (id: PageId) => {
      ticketApi.goToPage(id, projectId);
    },
    [projectId]
  );

  if (!project) {
    return null;
  }

  return (
    <Breadcrumb size="small" aria-label="Location">
      <BreadcrumbItem>
        <BreadcrumbButton onClick={handleProjectClick}>{project.label}</BreadcrumbButton>
      </BreadcrumbItem>
      <BreadcrumbDivider />
      <BreadcrumbItem>
        <BreadcrumbButton onClick={handleDocsClick}>Docs</BreadcrumbButton>
      </BreadcrumbItem>
      {trail.map((crumb) => (
        <Fragment key={crumb.id}>
          <BreadcrumbDivider />
          <BreadcrumbItem>
            <BreadcrumbButton onClick={() => handleCrumbClick(crumb.id)}>{crumb.title}</BreadcrumbButton>
          </BreadcrumbItem>
        </Fragment>
      ))}
    </Breadcrumb>
  );
});
PageBreadcrumb.displayName = 'PageBreadcrumb';
