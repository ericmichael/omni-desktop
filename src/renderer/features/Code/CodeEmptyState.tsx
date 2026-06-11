import { Badge, makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { Add20Regular, FolderOpen20Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { Button, Heading, ListItem } from '@/renderer/ds';
import { ProjectForm } from '@/renderer/features/Projects/ProjectForm';
import { getAvailableProfileNames } from '@/renderer/features/SandboxProfile/profile-list';
import { SandboxPicker } from '@/renderer/features/SandboxProfile/SandboxPicker';
import { emitter } from '@/renderer/services/ipc';
import { $machines } from '@/renderer/services/machines';
import { persistedStoreApi } from '@/renderer/services/store';
import type { CodeTab, CodeTabId, Project } from '@/shared/types';
import { firstSource } from '@/shared/types';

import { CliInstallCard } from './CliInstallCard';
import { codeApi, resolveCodeTabProfileName } from './state';

const useStyles = makeStyles({
  rootEmbedded: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    width: '100%',
    height: '100%',
    minHeight: 0,
  },
  rootFull: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    width: '100%',
    padding: tokens.spacingHorizontalXL,
    overflow: 'auto',
  },
  launchSurface: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    width: '100%',
    minHeight: 0,
    maxWidth: '860px',
    padding: tokens.spacingHorizontalM,
  },
  launchSurfaceFull: {
    borderRadius: tokens.borderRadiusXLarge,
    ...shorthands.border('1px', 'solid', `color-mix(in srgb, ${tokens.colorNeutralStroke1} 72%, transparent)`),
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 86%, transparent)`,
    boxShadow: tokens.shadow8,
    '@media (min-width: 760px)': {
      gridTemplateColumns: 'minmax(0, 1fr) 260px',
      alignItems: 'start',
      padding: tokens.spacingHorizontalXXL,
    },
  },
  primaryColumn: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    minWidth: 0,
    minHeight: 0,
  },
  sideColumn: {
    display: 'none',
  },
  launchHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'nowrap',
  },
  launchActions: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: tokens.spacingHorizontalXS,
    flex: '0 1 auto',
    minWidth: 0,
    flexWrap: 'nowrap',
  },
  sandboxAction: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    minWidth: 0,
  },
  sandboxActionLabel: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightMedium,
  },
  launchTitle: {
    fontFamily: 'var(--font-display)',
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
  launchTitleBlock: { flex: '1 1 auto', minWidth: 0 },
  intro: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  kicker: {
    fontFamily: 'var(--font-display)',
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorBrandForeground1,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  description: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    maxWidth: '560px',
    margin: 0,
  },
  sectionTitle: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: '1fr',
    gap: 0,
    width: '100%',
    maxHeight: 'none',
    overflowY: 'auto',
    overflowX: 'hidden',
    borderRadius: tokens.borderRadiusLarge,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground1,
  },
  projectRow: {
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    ':last-child': { borderBottom: 'none' },
  },
  sandboxPanel: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
    width: '100%',
    borderRadius: tokens.borderRadiusLarge,
    ...shorthands.border('1px', 'solid', `color-mix(in srgb, ${tokens.colorNeutralStroke1} 58%, transparent)`),
    backgroundColor: 'transparent',
    padding: tokens.spacingHorizontalM,
  },
  sandboxTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    fontWeight: tokens.fontWeightSemibold,
  },
  sandboxHint: { color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase200, marginTop: '2px' },
  sandboxControl: { alignSelf: 'flex-start' },
  unavailable: { color: tokens.colorPaletteRedForeground1 },
  emptyProjects: {
    borderRadius: tokens.borderRadiusLarge,
    ...shorthands.border('1px', 'dashed', tokens.colorNeutralStroke1),
    color: tokens.colorNeutralForeground2,
    padding: tokens.spacingHorizontalL,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  newProjectIcon: { marginRight: '6px' },
});

type CodeEmptyStateProps = {
  tabId: CodeTabId;
  embedded?: boolean;
};

const ProjectCard = memo(({ project, onSelect }: { project: Project; onSelect: (project: Project) => void }) => {
  const styles = useStyles();
  const handleClick = useCallback(() => {
    onSelect(project);
  }, [project, onSelect]);

  const projectSourceLabel = (() => {
    const source = firstSource(project);
    if (source?.kind === 'local') {
      const parts = source.workspaceDir.split('/').filter(Boolean);
      return `Local · ${parts.at(-1) ?? source.workspaceDir}`;
    }
    if (source?.kind === 'git-remote') {
      const match = source.repoUrl.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
      return `Git · ${match?.[1] ?? source.repoUrl}`;
    }
    return '';
  })();

  return (
    <ListItem
      icon={<FolderOpen20Regular />}
      label={project.label}
      detail={projectSourceLabel}
      onClick={handleClick}
      className={styles.projectRow}
    />
  );
});
ProjectCard.displayName = 'ProjectCard';

export const CodeEmptyState = memo(({ tabId, embedded = false }: CodeEmptyStateProps) => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const tab = store.codeTabs.find((t) => t.id === tabId) as CodeTab | undefined;
  const [showNewProject, setShowNewProject] = useState(false);
  const [isEnterprise, setIsEnterprise] = useState(false);
  const machines = useStore($machines);

  useEffect(() => {
    emitter.invoke('platform:is-enterprise').then(setIsEnterprise);
  }, []);

  const projects = store.projects;
  const availableProfiles = useMemo(
    () => getAvailableProfileNames({ isEnterprise, available: store.availableSandboxProfiles, machines }),
    [isEnterprise, store.availableSandboxProfiles, machines]
  );
  const selectedProfileName = tab?.profileName ?? resolveCodeTabProfileName(null);
  const selectedProfileAvailable = availableProfiles.length === 0 || availableProfiles.includes(selectedProfileName);

  const handleSelectProject = useCallback(
    (project: Project) => {
      codeApi.setTabProject(tabId, project.id);
    },
    [tabId]
  );

  const handleSandboxChange = useCallback(
    (profileName: string) => {
      void codeApi.setTabProfile(tabId, profileName);
    },
    [tabId]
  );

  const handleCreatedProject = useCallback(
    (project: Project) => {
      void codeApi.setTabProject(tabId, project.id);
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
      <div className={embedded ? styles.launchSurface : `${styles.launchSurface} ${styles.launchSurfaceFull}`}>
        <div className={styles.primaryColumn}>
          <div className={styles.launchHeader}>
            <div className={styles.launchTitleBlock}>
              {!embedded && <div className={styles.kicker}>Code Deck</div>}
              {embedded ? (
                <div className={styles.launchTitle}>Projects</div>
              ) : (
                <Heading size="md">Start a session</Heading>
              )}
              {!embedded && <p className={styles.description}>Choose a project. Change sandbox only if needed.</p>}
            </div>
            <div className={styles.launchActions}>
              <div className={styles.sandboxAction}>
                <span className={styles.sandboxActionLabel}>Run in</span>
                {availableProfiles.length > 0 ? (
                  <SandboxPicker
                    value={selectedProfileAvailable ? selectedProfileName : (availableProfiles[0] ?? 'host')}
                    onChange={handleSandboxChange}
                    context={{ isEnterprise, available: store.availableSandboxProfiles, machines }}
                    compact
                  />
                ) : (
                  <Badge appearance="outline">No sandboxes</Badge>
                )}
              </div>
              <Button variant="ghost" size="sm" onClick={handleOpenNewProject}>
                <Add20Regular className={styles.newProjectIcon} style={{ width: 14, height: 14 }} />
                New
              </Button>
            </div>
          </div>

          <div className={styles.grid}>
            {projects.length > 0 ? (
              projects.map((project) => (
                <ProjectCard key={project.id} project={project} onSelect={handleSelectProject} />
              ))
            ) : (
              <div className={styles.emptyProjects}>Create your first project to start.</div>
            )}
          </div>
        </div>
        <div className={styles.sideColumn} />
      </div>

      {!embedded && <CliInstallCard />}

      <ProjectForm
        open={showNewProject}
        onClose={handleCloseNewProject}
        showSandboxForCreate
        submitLabel="Create and launch"
        onCreated={handleCreatedProject}
      />
    </div>
  );
});
CodeEmptyState.displayName = 'CodeEmptyState';
