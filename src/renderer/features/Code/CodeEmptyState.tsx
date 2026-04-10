import { makeStyles, tokens, shorthands } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useState } from 'react';
import { FolderOpen20Regular, Add20Regular } from '@fluentui/react-icons';

import { Button, Heading } from '@/renderer/ds';
import { ProjectForm } from '@/renderer/features/Projects/ProjectForm';
import { persistedStoreApi } from '@/renderer/services/store';
import type { CodeTabId, Project } from '@/shared/types';

import { codeApi } from './state';

const useStyles = makeStyles({
  projectCard: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusLarge,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground1,
    padding: tokens.spacingHorizontalL,
    textAlign: 'left',
    transitionProperty: 'border-color, background-color',
    transitionDuration: '150ms',
    cursor: 'pointer',
    ':hover': { ...shorthands.borderColor(tokens.colorBrandStroke1), backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  projectIcon: { color: tokens.colorNeutralForeground2, flexShrink: 0 },
  projectContent: { minWidth: 0 },
  projectLabel: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightMedium,
    color: tokens.colorNeutralForeground1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  projectDir: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  rootEmbedded: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: tokens.spacingVerticalXXL,
    width: '100%',
  },
  rootFull: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    width: '100%',
    gap: tokens.spacingVerticalXXL,
    padding: '32px',
  },
  description: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    textAlign: 'center',
    maxWidth: '448px',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: '1fr',
    gap: tokens.spacingVerticalM,
    maxWidth: '512px',
    width: '100%',
    maxHeight: '400px',
    overflowY: 'auto',
    '@media (min-width: 640px)': { gridTemplateColumns: '1fr 1fr' },
  },
  newProjectIcon: { marginRight: '6px' },
});

type CodeEmptyStateProps = {
  tabId: CodeTabId;
  embedded?: boolean;
};

const ProjectCard = memo(
  ({ project, onSelect }: { project: Project; onSelect: (project: Project) => void }) => {
    const styles = useStyles();
    const handleClick = useCallback(() => {
      onSelect(project);
    }, [project, onSelect]);

    return (
      <button
        onClick={handleClick}
        className={styles.projectCard}
      >
        <FolderOpen20Regular className={styles.projectIcon} />
        <div className={styles.projectContent}>
          <div className={styles.projectLabel}>{project.label}</div>
          <div className={styles.projectDir}>{project.workspaceDir}</div>
        </div>
      </button>
    );
  }
);
ProjectCard.displayName = 'ProjectCard';

export const CodeEmptyState = memo(({ tabId, embedded = false }: CodeEmptyStateProps) => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const [showNewProject, setShowNewProject] = useState(false);

  const projects = store.projects;

  const handleSelectProject = useCallback(
    (project: Project) => {
      codeApi.setTabProject(tabId, project.id);
    },
    [tabId]
  );

  const handleOpenNewProject = useCallback(() => {
    setShowNewProject(true);
  }, []);

  const handleCloseNewProject = useCallback(() => {
    setShowNewProject(false);
  }, []);

  return (
    <div className={embedded ? styles.rootEmbedded : styles.rootFull}>
      {!embedded && <Heading size="md">Select a Project</Heading>}
      {!embedded && (
        <p className={styles.description}>
          Choose an existing project to open in this tab, or create a new one.
        </p>
      )}

      <div className={styles.grid}>
        {projects.map((project) => (
          <ProjectCard key={project.id} project={project} onSelect={handleSelectProject} />
        ))}
      </div>

      <Button variant="ghost" onClick={handleOpenNewProject}>
        <Add20Regular className={styles.newProjectIcon} style={{ width: 14, height: 14 }} />
        Create new project
      </Button>

      <ProjectForm open={showNewProject} onClose={handleCloseNewProject} />
    </div>
  );
});
CodeEmptyState.displayName = 'CodeEmptyState';
