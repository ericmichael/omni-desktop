import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { PiArrowUpBold, PiFolderBold, PiHouseBold } from 'react-icons/pi';

import { AnimatedDialog, Button, DialogBody, DialogContent, DialogFooter, DialogHeader, Spinner } from '@/renderer/ds';
import { emitter } from '@/renderer/services/ipc';

type DirectoryEntry = { name: string; path: string; isDirectory: boolean };

type DirectoryRowProps = {
  entry: DirectoryEntry;
  onNavigate: (path: string) => void;
};

const DirectoryRow = memo(({ entry, onNavigate }: DirectoryRowProps) => {
  const handleClick = useCallback(() => {
    onNavigate(entry.path);
  }, [entry.path, onNavigate]);

  return (
    <button
      type="button"
      onClick={handleClick}
      className="flex items-center gap-2 w-full text-left py-1.5 px-3 text-sm hover:bg-surface-raised cursor-pointer transition-colors text-fg"
    >
      <PiFolderBold size={14} className="shrink-0 text-yellow-400" />
      <span className="truncate">{entry.name}</span>
    </button>
  );
});
DirectoryRow.displayName = 'DirectoryRow';

type DirectoryBrowserDialogProps = {
  open: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
  initialPath?: string;
};

export const DirectoryBrowserDialog = memo(({ open, onClose, onSelect, initialPath }: DirectoryBrowserDialogProps) => {
  const [currentPath, setCurrentPath] = useState('');
  const [pathInput, setPathInput] = useState('');
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const initialized = useRef(false);

  const loadDirectory = useCallback(async (dirPath: string) => {
    setLoading(true);
    try {
      const result = await emitter.invoke('util:list-directory', dirPath);
      setEntries(result);
      setCurrentPath(dirPath);
      setPathInput(dirPath);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      initialized.current = false;
      return;
    }
    if (initialized.current) {
      return;
    }
    initialized.current = true;
    if (initialPath) {
      void loadDirectory(initialPath);
    } else {
      void emitter.invoke('util:get-home-directory').then((home) => loadDirectory(home));
    }
  }, [open, initialPath, loadDirectory]);

  const handleNavigate = useCallback(
    (path: string) => {
      void loadDirectory(path);
    },
    [loadDirectory]
  );

  const handleUp = useCallback(() => {
    const parent = currentPath.replace(/\/[^/]+\/?$/, '') || '/';
    void loadDirectory(parent);
  }, [currentPath, loadDirectory]);

  const handleHome = useCallback(async () => {
    const home = await emitter.invoke('util:get-home-directory');
    void loadDirectory(home);
  }, [loadDirectory]);

  const handlePathInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setPathInput(e.target.value);
  }, []);

  const handlePathInputKeyDown = useCallback(
    async (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        const isDir = await emitter.invoke('util:get-is-directory', pathInput);
        if (isDir) {
          void loadDirectory(pathInput);
        }
      }
    },
    [pathInput, loadDirectory]
  );

  const handleConfirm = useCallback(() => {
    onSelect(currentPath);
    onClose();
  }, [currentPath, onSelect, onClose]);

  return (
    <AnimatedDialog open={open} onClose={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>Select Directory</DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          {/* Path bar */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleHome}
              className="shrink-0 rounded p-1.5 text-fg-muted hover:bg-surface-raised hover:text-fg transition-colors"
              title="Home"
            >
              <PiHouseBold size={14} />
            </button>
            <button
              type="button"
              onClick={handleUp}
              className="shrink-0 rounded p-1.5 text-fg-muted hover:bg-surface-raised hover:text-fg transition-colors"
              title="Parent directory"
            >
              <PiArrowUpBold size={14} />
            </button>
            <input
              type="text"
              value={pathInput}
              onChange={handlePathInputChange}
              onKeyDown={handlePathInputKeyDown}
              className="flex-1 rounded-lg border border-surface-border bg-surface px-3 py-1.5 text-sm text-fg placeholder:text-fg-muted/50 focus:outline-none focus:border-accent-500"
            />
          </div>

          {/* Directory listing */}
          <div className="h-64 overflow-y-auto rounded-lg border border-surface-border bg-surface">
            {loading ? (
              <div className="flex items-center justify-center h-full">
                <Spinner size="sm" />
              </div>
            ) : entries.length === 0 ? (
              <div className="flex items-center justify-center h-full text-sm text-fg-muted">No subdirectories</div>
            ) : (
              <div className="flex flex-col py-1">
                {entries.map((entry) => (
                  <DirectoryRow key={entry.path} entry={entry} onNavigate={handleNavigate} />
                ))}
              </div>
            )}
          </div>
        </DialogBody>
        <DialogFooter className="gap-2 justify-end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} isDisabled={!currentPath}>
            Select
          </Button>
        </DialogFooter>
      </DialogContent>
    </AnimatedDialog>
  );
});
DirectoryBrowserDialog.displayName = 'DirectoryBrowserDialog';
