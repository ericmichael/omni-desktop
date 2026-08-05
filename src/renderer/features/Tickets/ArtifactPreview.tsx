import { ExternalLink } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';

import { isTextMime } from '@/lib/mime-types';
import { Button } from '@/renderer/ds/ui/button';
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
        <p className="text-sm text-muted-foreground">Select a file to preview</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!content) {
    return null;
  }

  const encodedPath = selectedFile.relativePath.split('/').map(encodeURIComponent).join('/');
  const artifactUrl = `artifact://file/${ticketId}/${encodedPath}`;

  // Image preview
  if (content.mimeType.startsWith('image/')) {
    return (
      <div className="flex flex-col h-full">
        <PreviewHeader name={selectedFile.name} onOpenExternal={handleOpenExternal} />
        <div className="flex-1 min-h-0 flex items-center justify-center p-5 overflow-y-auto">
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
            className="w-full h-full border-0 bg-background"
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
        <div className="flex-1 min-h-0 overflow-y-auto">
          <pre className="p-5 text-xs text-foreground font-mono whitespace-pre-wrap break-words">{displayText}</pre>
          {isTruncated && (
            <div className="pl-5 pr-5 pb-5">
              <p className="text-xs text-muted-foreground">
                File truncated ({formatBytes(content.size)}).{' '}
                <Button
                  variant="link"
                  size="xs"
                  onClick={handleOpenExternal}
                  className="text-primary cursor-pointer bg-transparent border-0 hover:underline"
                >
                  Open externally
                </Button>
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
      <div className="flex-1 flex flex-col items-center justify-center gap-4">
        <p className="text-sm text-muted-foreground">{content.mimeType}</p>
        <p className="text-xs text-muted-foreground">{formatBytes(content.size)}</p>
        <Button size="sm" onClick={handleOpenExternal}>
          <ExternalLink className={`size-4 ${'mr-1'}`} />
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
    <div className="flex items-center gap-2 pl-4 pr-4 pt-2 pb-2 border-b border-border shrink-0">
      <span className="text-sm text-foreground font-medium overflow-hidden text-ellipsis whitespace-nowrap flex-1">
        {name}
      </span>
      <Button variant="ghost" size="icon-sm" onClick={onOpenExternal} aria-label="Open externally">
        <ExternalLink className="size-4" />
      </Button>
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
