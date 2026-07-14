import { useStore } from '@nanostores/react';
import { Fragment, memo, useCallback } from 'react';

import { Breadcrumb, BreadcrumbButton, BreadcrumbDivider, BreadcrumbItem } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';
import type { ProjectId } from '@/shared/types';

import { ticketApi } from './state';

type Crumb = { label: string; onClick: () => void };

type ProjectCrumbProps = {
  projectId: ProjectId;
  /** Ancestors between the project and the current page (e.g. Tasks). */
  middle?: Crumb[];
  /** Omit to render ancestors only — the page below carries its own title. */
  current?: string;
};

/**
 * Breadcrumb for project sub-pages (Tasks / Docs / Settings / details):
 * "{Project} › [middle…]". There is no project tab bar — the project crumb
 * is the way back to the project home. The current page is NOT a crumb; it
 * renders as the page's real title underneath (see ProjectPageHeader).
 */
export const ProjectCrumb = memo(({ projectId, middle, current }: ProjectCrumbProps) => {
  const store = useStore(persistedStoreApi.$atom);
  const project = store.projects.find((p) => p.id === projectId);

  const handleHome = useCallback(() => ticketApi.goToProject(projectId, 'home'), [projectId]);

  return (
    <Breadcrumb size="small" aria-label="Location">
      <BreadcrumbItem>
        <BreadcrumbButton onClick={handleHome}>{project?.label ?? 'Project'}</BreadcrumbButton>
      </BreadcrumbItem>
      {(middle ?? []).map((crumb) => (
        <Fragment key={crumb.label}>
          <BreadcrumbDivider />
          <BreadcrumbItem>
            <BreadcrumbButton onClick={crumb.onClick}>{crumb.label}</BreadcrumbButton>
          </BreadcrumbItem>
        </Fragment>
      ))}
      {current !== undefined && (
        <>
          <BreadcrumbDivider />
          <BreadcrumbItem>
            <BreadcrumbButton current>{current}</BreadcrumbButton>
          </BreadcrumbItem>
        </>
      )}
    </Breadcrumb>
  );
});
ProjectCrumb.displayName = 'ProjectCrumb';
