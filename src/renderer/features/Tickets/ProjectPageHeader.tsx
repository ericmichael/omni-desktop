import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { ReactNode } from 'react';
import { memo } from 'react';

import { Title3 } from '@/renderer/ds';
import type { ProjectId } from '@/shared/types';

import { ProjectCrumb } from './ProjectCrumb';

type Crumb = { label: string; onClick: () => void };

type ProjectPageHeaderProps = {
  projectId: ProjectId;
  /** Ancestors between the project crumb and this page (e.g. Tasks). */
  middle?: Crumb[];
  /** The page's real title. Strings render at the standard page-title scale;
   *  pass a node for editable titles (tickets). */
  title: ReactNode;
  /** Right-aligned controls on the title row (filters, actions, menus). */
  actions?: ReactNode;
  /** Caption line under the title (e.g. milestone metadata). */
  meta?: ReactNode;
  className?: string;
};

/**
 * The standard header for every project sub-page: a small ancestors-only
 * breadcrumb above a real page title (one scale everywhere), with actions
 * right-aligned on the title row. The page itself is never a crumb — that's
 * what made headers read as a jumble of tiny links with no title.
 */
const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalL,
    paddingBottom: tokens.spacingVerticalS,
    flexShrink: 0,
  },
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
  },
  titleText: {
    flex: '0 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  spacer: {
    flex: '1 1 0',
  },
  meta: {
    color: tokens.colorNeutralForeground3,
  },
});

export const ProjectPageHeader = memo(
  ({ projectId, middle, title, actions, meta, className }: ProjectPageHeaderProps) => {
    const styles = useStyles();
    return (
      <div className={mergeClasses(styles.root, className)} data-slot="project-page-header">
        <ProjectCrumb projectId={projectId} middle={middle} />
        <div className={styles.titleRow}>
          {typeof title === 'string' ? <Title3 className={styles.titleText}>{title}</Title3> : title}
          <div className={styles.spacer} />
          {actions}
        </div>
        {meta && <div className={styles.meta}>{meta}</div>}
      </div>
    );
  }
);
ProjectPageHeader.displayName = 'ProjectPageHeader';
