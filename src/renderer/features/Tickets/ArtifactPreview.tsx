import { memo, useCallback, useEffect, useState } from 'react';
import { Open20Regular } from '@fluentui/react-icons';
import { makeStyles, tokens, shorthands } from '@fluentui/react-components';

import { isTextMime } from '@/lib/mime-types';
import { Button } from '@/renderer/ds';
import type { ArtifactFileContent, ArtifactFileEntry, TicketId } from '@/shared/types';

import { ticketApi } from './state';

const MAX_TEXT_PREVIEW_SIZE = 100_000;

const useStyles = makeStyles({
  centerMessage: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
  },
  centerText: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
  },
  columnFull: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
  },
  imageContainer: {
    flex: '1 1 0',
    minHeight: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: tokens.spacingVerticalL,
    overflowY: 'auto',
  },
  image: {
    maxWidth: '100%',
    maxHeight: '100%',
    objectFit: 'contain',
  },
  iframeContainer: {
    flex: '1 1 0',
    minHeight: 0,
  },
  iframe: {
    width: '100%',
    height: '100%',
    border: 'none',
    backgroundColor: 'white',
  },
  textContainer: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
  },
  preBlock: {
    padding: tokens.spacingVerticalL,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground1,
    fontFamily: 'monospace',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  truncateNote: {
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingBottom: tokens.spacingVerticalL,
  },
  truncateText: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
  },
  openLink: {
    color: tokens.colorBrandForeground1,
    cursor: 'pointer',
    backgroundColor: 'transparent',
    border: 'none',
    ':hover': {
      textDecoration: 'underline',
    },
  },
  binaryCenter: {
    flex: '1 1 0',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingVerticalM,
  },
  mimeText: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
  },
  sizeText: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  openIcon: {
    marginRight: '4px',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    flexShrink: 0,
  },
  headerName: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
    fontWeight: tokens.fontWeightMedium,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: '1 1 0',
  },
  headerBtn: {
    color: tokens.colorNeutralForeground2,
    transitionProperty: 'color',
    transitionDuration: '150ms',
    cursor: 'pointer',
    backgroundColor: 'transparent',
    border: 'none',
    ':hover': {
      color: tokens.colorNeutralForeground1,
    },
  },
});

type ArtifactPreviewProps = {
  ticketId: TicketId;
  selectedFile: ArtifactFileEntry | null;
};

export const ArtifactPreview = memo(({ ticketId, selectedFile }: ArtifactPreviewProps) => {
  const styles = useStyles();
  const [content, setContent] = useState<ArtifactFileContent | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selectedFile || selectedFile.isDirectory) {
      setContent(null);
      return;
    }

    setLoading(true);
    void ticketApi.readArtifact(ticketId, selectedFile.relativePath).then((result) => {
      setContent(result);
      setLoading(false);
    });
  }, [ticketId, selectedFile]);

  const handleOpenExternal = useCallback(() => {
    if (selectedFile) {
      void ticketApi.openArtifactExternal(ticketId, selectedFile.relativePath);
    }
  }, [ticketId, selectedFile]);

  if (!selectedFile) {
    return (
      <div className={styles.centerMessage}>
        <p className={styles.centerText}>Select a file to preview</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={styles.centerMessage}>
        <p className={styles.centerText}>Loading...</p>
      </div>
    );
  }

  if (!content) {
    return null;
  }

  const encodedPath = selectedFile.relativePath
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  const artifactUrl = `artifact://file/${ticketId}/${encodedPath}`;

  // Image preview
  if (content.mimeType.startsWith('image/')) {
    return (
      <div className={styles.columnFull}>
        <PreviewHeader name={selectedFile.name} onOpenExternal={handleOpenExternal} />
        <div className={styles.imageContainer}>
          <img src={artifactUrl} alt={selectedFile.name} className={styles.image} />
        </div>
      </div>
    );
  }

  // HTML preview
  if (content.mimeType === 'text/html') {
    return (
      <div className={styles.columnFull}>
        <PreviewHeader name={selectedFile.name} onOpenExternal={handleOpenExternal} />
        <div className={styles.iframeContainer}>
          <iframe
            src={artifactUrl}
            title={selectedFile.name}
            className={styles.iframe}
            sandbox="allow-same-origin allow-scripts"
          />
        </div>
      </div>
    );
  }

  // Text/code preview
  if (isTextMime(content.mimeType) && content.textContent !== null) {
    const isTruncated = content.size > MAX_TEXT_PREVIEW_SIZE;
    const displayText = isTruncated ? content.textContent.slice(0, MAX_TEXT_PREVIEW_SIZE) : content.textContent;

    return (
      <div className={styles.columnFull}>
        <PreviewHeader name={selectedFile.name} onOpenExternal={handleOpenExternal} />
        <div className={styles.textContainer}>
          <pre className={styles.preBlock}>{displayText}</pre>
          {isTruncated && (
            <div className={styles.truncateNote}>
              <p className={styles.truncateText}>
                File truncated ({formatBytes(content.size)}).{' '}
                <button type="button" onClick={handleOpenExternal} className={styles.openLink}>
                  Open externally
                </button>
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Binary / unknown fallback
  return (
    <div className={styles.columnFull}>
      <PreviewHeader name={selectedFile.name} onOpenExternal={handleOpenExternal} />
      <div className={styles.binaryCenter}>
        <p className={styles.mimeText}>{content.mimeType}</p>
        <p className={styles.sizeText}>{formatBytes(content.size)}</p>
        <Button size="sm" onClick={handleOpenExternal}>
          <Open20Regular style={{ width: 14, height: 14 }} className={styles.openIcon} />
          Open Externally
        </Button>
      </div>
    </div>
  );
});
ArtifactPreview.displayName = 'ArtifactPreview';

// --- Sub-components ---

const PreviewHeader = memo(({ name, onOpenExternal }: { name: string; onOpenExternal: () => void }) => {
  const styles = useStyles();
  return (
    <div className={styles.header}>
      <span className={styles.headerName}>{name}</span>
      <button
        type="button"
        onClick={onOpenExternal}
        className={styles.headerBtn}
        title="Open externally"
      >
        <Open20Regular style={{ width: 14, height: 14 }} />
      </button>
    </div>
  );
});
PreviewHeader.displayName = 'PreviewHeader';

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
