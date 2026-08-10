import { useSelector } from '@xstate/react';
import { XIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { memo } from 'react';

import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';
import type { FileEditorLease } from '@/shared/machines/file-editor-registry';

/**
 * The Files app's open-file tab strip. Each tab reads its editor actor
 * directly so unsaved changes are visible (the warning dot) for every open
 * file, not just the selected one.
 */

export type OpenFileTab = { path: string; lease: FileEditorLease };

const FileTab = memo(
  ({
    path,
    lease,
    selected,
    onSelect,
    onClose,
  }: {
    path: string;
    lease: FileEditorLease;
    selected: boolean;
    onSelect: (path: string) => void;
    onClose: (path: string) => void;
  }) => {
    const dirty = useSelector(
      lease.actor,
      (snapshot) => snapshot.matches('dirty') || snapshot.matches('saveError') || snapshot.matches('conflict')
    );
    const name = path.split('/').pop() ?? path;
    return (
      <div
        className={cn(
          'flex max-w-48 shrink-0 items-center border-r border-border',
          selected ? 'bg-background text-foreground' : 'text-muted-foreground hover:bg-accent/50'
        )}
      >
        <button
          type="button"
          role="tab"
          aria-selected={selected}
          title={path}
          className="flex min-w-0 items-center gap-1.5 py-1.5 pl-2.5 pr-1 text-xs"
          onClick={() => onSelect(path)}
        >
          <span className="min-w-0 truncate">{name}</span>
          {dirty ? (
            <span
              className="size-1.5 shrink-0 rounded-full bg-warning"
              title="Unsaved changes"
              aria-label={`${name} has unsaved changes`}
              role="status"
            />
          ) : null}
        </button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="mr-0.5 size-4 shrink-0 text-muted-foreground opacity-60 hover:opacity-100"
          aria-label={`Close ${path}`}
          onClick={() => onClose(path)}
        >
          <XIcon className="size-3" />
        </Button>
      </div>
    );
  }
);
FileTab.displayName = 'FileTab';

export const FileTabs = memo(
  ({
    files,
    selectedPath,
    onSelect,
    onClose,
    leading,
  }: {
    files: OpenFileTab[];
    selectedPath: string | null;
    onSelect: (path: string) => void;
    onClose: (path: string) => void;
    /** Leading toolbar content (the sidebar toggle). */
    leading?: ReactNode;
  }) => (
    <div className="flex min-h-9 shrink-0 items-center border-b border-border bg-card">
      {leading}
      <div
        className="flex min-w-0 flex-1 items-stretch self-stretch overflow-x-auto [&::-webkit-scrollbar]:hidden"
        role="tablist"
        aria-label="Open files"
      >
        {files.map((file) => (
          <FileTab
            key={file.path}
            path={file.path}
            lease={file.lease}
            selected={selectedPath === file.path}
            onSelect={onSelect}
            onClose={onClose}
          />
        ))}
      </div>
    </div>
  )
);
FileTabs.displayName = 'FileTabs';
