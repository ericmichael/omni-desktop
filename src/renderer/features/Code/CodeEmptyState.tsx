import { Badge, makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { Add20Regular, Cube20Regular, FolderOpen20Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { Button, Heading } from '@/renderer/ds';
import { ProjectForm } from '@/renderer/features/Projects/ProjectForm';
import { getAvailableProfileNames, getProfileMenuLabel } from '@/renderer/features/SandboxProfile/profile-list';
import { SandboxPicker } from '@/renderer/features/SandboxProfile/SandboxPicker';
import { emitter } from '@/renderer/services/ipc';
import { $machines } from '@/renderer/services/machines';
import { persistedStoreApi } from '@/renderer/services/store';
import type { CodeTab, CodeTabId, Project } from '@/shared/types';
import { firstSource } from '@/shared/types';

import { codeApi, resolveCodeTabProfileName } from './state';

const useStyles = makeStyles({
  projectCard: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusLarge,
    ...shorthands.border('1px', 'solid', `color-mix(in srgb, ${tokens.colorNeutralStroke1} 50%, transparent)`),
    backgroundColor: 'transparent',
    padding: tokens.spacingHorizontalL,
    textAlign: 'left',
    transitionProperty: 'border-color, background-color',
    transitionDuration: '150ms',
    cursor: 'pointer',
    ':hover': {
      ...shorthands.borderColor(`color-mix(in srgb, ${tokens.colorBrandStroke1} 70%, transparent)`),
      backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralForeground1} 6%, transparent)`,
    },
  },
  projectIcon: { color: tokens.colorNeutralForeground2, flexShrink: 0 },
  projectContent: { minWidth: 0, flex: '1 1 auto' },
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
  sandboxPanel: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
    width: '100%',
    maxWidth: '512px',
    borderRadius: tokens.borderRadiusXLarge,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground1,
    padding: tokens.spacingHorizontalL,
    '@media (max-width: 520px)': { alignItems: 'flex-start', flexDirection: 'column' },
  },
  sandboxTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    fontWeight: tokens.fontWeightSemibold,
  },
  sandboxHint: { color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase200, marginTop: '2px' },
  projectMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    marginTop: tokens.spacingVerticalXS,
    flexWrap: 'wrap',
  },
  unavailable: { color: tokens.colorPaletteRedForeground1 },
  newProjectIcon: { marginRight: '6px' },
});

type SandboxResolution = {
  profileName: string;
  source: 'oneOff' | 'project' | 'default' | 'fallback';
  available: boolean;
};

const resolveSandboxForProject = (
  project: Project,
  explicitProfileName: string | null,
  availableProfiles: string[],
  defaultProfileName: string
): SandboxResolution => {
  const requested = explicitProfileName ?? project.sandboxProfile ?? defaultProfileName;
  const source = explicitProfileName ? 'oneOff' : project.sandboxProfile ? 'project' : 'default';
  if (availableProfiles.length === 0) {
    return { profileName: requested, source, available: true };
  }
  if (availableProfiles.includes(requested)) {
    return { profileName: requested, source, available: true };
  }
  return { profileName: availableProfiles[0] ?? 'host', source: 'fallback', available: false };
};

type CodeEmptyStateProps = {
  tabId: CodeTabId;
  embedded?: boolean;
};

const ProjectCard = memo(
  ({
    project,
    resolution,
    onSelect,
  }: {
    project: Project;
    resolution: SandboxResolution;
    onSelect: (project: Project) => void;
  }) => {
    const styles = useStyles();
    const machines = useStore($machines);
    const handleClick = useCallback(() => {
      onSelect(project);
    }, [project, onSelect]);

    const sourceLabel =
      resolution.source === 'oneOff'
        ? 'One-off'
        : resolution.source === 'project'
          ? 'Project'
          : resolution.source === 'fallback'
            ? 'Fallback'
            : 'Default';

    return (
      <button onClick={handleClick} className={styles.projectCard}>
        <FolderOpen20Regular className={styles.projectIcon} />
        <div className={styles.projectContent}>
          <div className={styles.projectLabel}>{project.label}</div>
          <div className={styles.projectDir}>
            {(() => {
              const s = firstSource(project);
              if (s?.kind === 'local') {
                return s.workspaceDir;
              }
              if (s?.kind === 'git-remote') {
                return s.repoUrl;
              }
              return '';
            })()}
          </div>
          <div className={styles.projectMeta}>
            <Badge size="small" appearance="outline" color={resolution.available ? 'informative' : 'danger'}>
              {sourceLabel} · {getProfileMenuLabel(resolution.profileName, machines)}
            </Badge>
          </div>
        </div>
      </button>
    );
  }
);
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
  const defaultProfileName = store.defaultProfileName ?? 'host';
  const selectedProfileName = tab?.profileName ?? resolveCodeTabProfileName(null);
  const explicitProfileName = tab?.profileNameExplicit ? selectedProfileName : null;
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
      {!embedded && <Heading size="md">Select a Project</Heading>}
      {!embedded && (
        <p className={styles.description}>Choose an existing project to open in this tab, or create a new one.</p>
      )}

      <div className={styles.sandboxPanel}>
        <div>
          <div className={styles.sandboxTitle}>
            <Cube20Regular /> Sandbox for this session
          </div>
          <div
            className={selectedProfileAvailable ? styles.sandboxHint : `${styles.sandboxHint} ${styles.unavailable}`}
          >
            {tab?.profileNameExplicit
              ? 'One-off override for this Agent Session.'
              : 'Defaults update when you choose a project.'}
            {!selectedProfileAvailable
              ? ' Selected profile is unavailable; project launch will use a safe fallback.'
              : ''}
          </div>
        </div>
        {availableProfiles.length > 0 ? (
          <SandboxPicker
            value={selectedProfileAvailable ? selectedProfileName : (availableProfiles[0] ?? 'host')}
            onChange={handleSandboxChange}
            context={{ isEnterprise, available: store.availableSandboxProfiles, machines }}
          />
        ) : (
          <Badge appearance="outline">No sandbox profiles</Badge>
        )}
      </div>

      <div className={styles.grid}>
        {projects.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            resolution={resolveSandboxForProject(project, explicitProfileName, availableProfiles, defaultProfileName)}
            onSelect={handleSelectProject}
          />
        ))}
      </div>

      <Button variant="ghost" onClick={handleOpenNewProject}>
        <Add20Regular className={styles.newProjectIcon} style={{ width: 14, height: 14 }} />
        Create new project
      </Button>

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
