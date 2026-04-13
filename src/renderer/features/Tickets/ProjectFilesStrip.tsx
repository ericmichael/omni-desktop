import { memo, useEffect, useState } from 'react';
import { Document20Regular, Folder20Regular } from '@fluentui/react-icons';
import { makeStyles, tokens } from '@fluentui/react-components';

import { Caption1 } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';
import type { ArtifactFileEntry, ProjectId } from '@/shared/types';

import { ticketApi } from './state';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    alignItems: 'stretch',
    gap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    overflowX: 'auto',
    flexWrap: 'nowrap',
    height: '80px',
    flexShrink: 0,
  },
  fileCard: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '4px',
    minWidth: '100px',
    maxWidth: '100px',
    padding: tokens.spacingHorizontalS,
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
    border: 'none',
    color: tokens.colorNeutralForeground2,
    transitionProperty: 'background-color',
    transitionDuration: tokens.durationFaster,
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground3Hover,
    },
  },
  fileName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    width: '100%',
    textAlign: 'center',
    color: tokens.colorNeutralForeground2,
  },
  size: {
    color: tokens.colorNeutralForeground3,
  },
  emptyHint: {
    display: 'flex',
    alignItems: 'center',
    color: tokens.colorNeutralForeground3,
    fontStyle: 'italic',
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'nowrap',
  },
});

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const ProjectFilesStrip = memo(({ projectId }: { projectId: ProjectId }) => {
  const styles = useStyles();
  const [files, setFiles] = useState<ArtifactFileEntry[]>([]);

  useEffect(() => {
    void ticketApi.listProjectFiles(projectId).then(setFiles);
  }, [projectId]);

  const project = persistedStoreApi.$atom.get().projects.find((p) => p.id === projectId);
  const slug = project?.slug ?? '';

  if (files.length === 0) {
    return (
      <div className={styles.root}>
        <span className={styles.emptyHint}>
          Add files to ~/Omni/Workspace/Projects/{slug}/
        </span>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      {files.map((entry) => (
        <button
          key={entry.relativePath}
          type="button"
          className={styles.fileCard}
          onClick={() => void ticketApi.openProjectFile(projectId, entry.relativePath)}
        >
          {entry.isDirectory ? (
            <Folder20Regular style={{ width: 20, height: 20 }} />
          ) : (
            <Document20Regular style={{ width: 20, height: 20 }} />
          )}
          <Caption1 className={styles.fileName}>{entry.name}</Caption1>
          {!entry.isDirectory && (
            <Caption1 className={styles.size}>{formatSize(entry.size)}</Caption1>
          )}
        </button>
      ))}
    </div>
  );
});
ProjectFilesStrip.displayName = 'ProjectFilesStrip';
