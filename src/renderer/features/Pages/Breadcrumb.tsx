import { useStore } from '@nanostores/react';
import { Fragment, memo, useCallback, useMemo } from 'react';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from '@/renderer/ds/ui/breadcrumb';
import { ticketApi } from '@/renderer/features/Tickets/state';
import type { PageId, ProjectId } from '@/shared/types';

import { $pages } from './state';

type BreadcrumbProps = {
  projectId: ProjectId;
  pageId: PageId;
};

/**
 * Ancestors-only breadcrumb for a project page: "Pages › [parents…]".
 * Same breadcrumb treatment as every other sub-page header; the page's own
 * title renders big underneath (the editable title input).
 */
export const PageBreadcrumb = memo(({ projectId, pageId }: BreadcrumbProps) => {
  const pages = useStore($pages);

  // Walk parentId chain to build the ancestor trail (excluding this page —
  // it titles itself below the crumb). Skip root pages: the Pages crumb
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

  const handleDocsClick = useCallback(() => {
    ticketApi.goToProject(projectId, 'pages');
  }, [projectId]);

  const handleCrumbClick = useCallback(
    (id: PageId) => {
      ticketApi.goToPage(id, projectId);
    },
    [projectId]
  );

  return (
    <Breadcrumb aria-label="Location">
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <button type="button" onClick={handleDocsClick}>
              Pages
            </button>
          </BreadcrumbLink>
        </BreadcrumbItem>
        {trail.map((crumb) => (
          <Fragment key={crumb.id}>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <button type="button" onClick={() => handleCrumbClick(crumb.id)}>
                  {crumb.title}
                </button>
              </BreadcrumbLink>
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
});
PageBreadcrumb.displayName = 'PageBreadcrumb';
