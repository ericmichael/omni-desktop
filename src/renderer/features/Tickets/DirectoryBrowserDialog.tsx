import { ArrowUp, Folder, Home } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/renderer/ds/ui/dialog';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '@/renderer/ds/ui/empty';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/renderer/ds/ui/input-group';
import { Item, ItemContent, ItemGroup, ItemMedia, ItemTitle } from '@/renderer/ds/ui/item';
import { ScrollArea } from '@/renderer/ds/ui/scroll-area';
import { Skeleton } from '@/renderer/ds/ui/skeleton';
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
    <Item asChild size="sm" className="w-full cursor-pointer hover:bg-accent">
      <button type="button" onClick={handleClick}>
        <ItemMedia>
          <Folder className={`size-4 ${'shrink-0 text-chart-4'}`} />
        </ItemMedia>
        <ItemContent>
          <ItemTitle className="overflow-hidden text-ellipsis whitespace-nowrap">{entry.name}</ItemTitle>
        </ItemContent>
      </button>
    </Item>
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
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Select Directory</DialogTitle>
        </DialogHeader>
        <div className={cn('min-h-0 overflow-y-auto', 'flex flex-col gap-4')}>
          {/* Path bar */}
          <InputGroup>
            <InputGroupAddon>
              <InputGroupButton size="icon-xs" onClick={handleHome} aria-label="Home" title="Home">
                <Home />
              </InputGroupButton>
              <InputGroupButton
                size="icon-xs"
                onClick={handleUp}
                aria-label="Parent directory"
                title="Parent directory"
              >
                <ArrowUp />
              </InputGroupButton>
            </InputGroupAddon>
            <InputGroupInput
              type="text"
              value={pathInput}
              onChange={handlePathInputChange}
              onKeyDown={handlePathInputKeyDown}
            />
          </InputGroup>

          {/* Directory listing */}
          <ScrollArea className="h-64 rounded-xl border bg-background">
            {loading ? (
              <div className="flex w-full flex-col gap-3 p-4">
                {Array.from({ length: 6 }, (_, index) => (
                  <div key={index} className="flex items-center gap-3">
                    <Skeleton className="size-8 rounded-full" />
                    <div className="flex flex-1 flex-col gap-1.5">
                      <Skeleton className={`h-4 ${['w-3/5', 'w-3/4', 'w-11/12'][index % 3]}`} />
                      <Skeleton className={`h-3 ${['w-2/5', 'w-3/5'][index % 2]}`} />
                    </div>
                  </div>
                ))}
              </div>
            ) : entries.length === 0 ? (
              <Empty className="h-full border-0 p-6">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Folder />
                  </EmptyMedia>
                  <EmptyTitle>No subdirectories</EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : (
              <ItemGroup className="p-1">
                {entries.map((entry) => (
                  <DirectoryRow key={entry.path} entry={entry} onNavigate={handleNavigate} />
                ))}
              </ItemGroup>
            )}
          </ScrollArea>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!currentPath}>
            Select
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});
DirectoryBrowserDialog.displayName = 'DirectoryBrowserDialog';
