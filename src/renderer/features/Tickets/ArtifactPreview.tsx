import { memo, useCallback, useEffect, useState } from 'react';
import { PiArrowSquareOutBold } from 'react-icons/pi';

import { isTextMime } from '@/lib/mime-types';
import { Button } from '@/renderer/ds';
import type { ArtifactFileContent, ArtifactFileEntry, TicketId } from '@/shared/types';

import { ticketApi } from './state';

const MAX_TEXT_PREVIEW_SIZE = 100_000;

type ArtifactPreviewProps = {
  ticketId: TicketId;
  selectedFile: ArtifactFileEntry | null;
};

export const ArtifactPreview = memo(({ ticketId, selectedFile }: ArtifactPreviewProps) => {
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
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-fg-muted">Select a file to preview</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-fg-muted">Loading...</p>
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
      <div className="flex flex-col h-full">
        <PreviewHeader name={selectedFile.name} onOpenExternal={handleOpenExternal} />
        <div className="flex-1 min-h-0 flex items-center justify-center p-4 overflow-auto">
          <img src={artifactUrl} alt={selectedFile.name} className="max-w-full max-h-full object-contain" />
        </div>
      </div>
    );
  }

  // HTML preview
  if (content.mimeType === 'text/html') {
    return (
      <div className="flex flex-col h-full">
        <PreviewHeader name={selectedFile.name} onOpenExternal={handleOpenExternal} />
        <div className="flex-1 min-h-0">
          <iframe
            src={artifactUrl}
            title={selectedFile.name}
            className="w-full h-full border-0 bg-white"
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
      <div className="flex flex-col h-full">
        <PreviewHeader name={selectedFile.name} onOpenExternal={handleOpenExternal} />
        <div className="flex-1 min-h-0 overflow-auto">
          <pre className="p-4 text-xs text-fg font-mono whitespace-pre-wrap break-words">{displayText}</pre>
          {isTruncated && (
            <div className="px-4 pb-4">
              <p className="text-xs text-fg-muted">
                File truncated ({formatBytes(content.size)}).{' '}
                <button type="button" onClick={handleOpenExternal} className="text-accent-400 hover:underline cursor-pointer">
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
    <div className="flex flex-col h-full">
      <PreviewHeader name={selectedFile.name} onOpenExternal={handleOpenExternal} />
      <div className="flex-1 flex flex-col items-center justify-center gap-3">
        <p className="text-sm text-fg-muted">{content.mimeType}</p>
        <p className="text-xs text-fg-subtle">{formatBytes(content.size)}</p>
        <Button size="sm" onClick={handleOpenExternal}>
          <PiArrowSquareOutBold size={14} className="mr-1" />
          Open Externally
        </Button>
      </div>
    </div>
  );
});
ArtifactPreview.displayName = 'ArtifactPreview';

// --- Sub-components ---

const PreviewHeader = memo(({ name, onOpenExternal }: { name: string; onOpenExternal: () => void }) => {
  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-surface-border shrink-0">
      <span className="text-sm text-fg font-medium truncate flex-1">{name}</span>
      <button
        type="button"
        onClick={onOpenExternal}
        className="text-fg-muted hover:text-fg transition-colors cursor-pointer"
        title="Open externally"
      >
        <PiArrowSquareOutBold size={14} />
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
