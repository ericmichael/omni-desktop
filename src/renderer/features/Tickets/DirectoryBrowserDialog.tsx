import { makeStyles, shorthands,tokens } from '@fluentui/react-components';
import { ArrowUp20Regular, Folder20Regular, Home20Regular } from '@fluentui/react-icons';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { AnimatedDialog, Button, DialogBody, DialogContent, DialogFooter, DialogHeader, Input, ListSkeleton } from '@/renderer/ds';
import { emitter } from '@/renderer/services/ipc';

const useStyles = makeStyles({
  directoryRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    width: '100%',
    textAlign: 'left',
    paddingTop: '10px',
    paddingBottom: '10px',
    paddingLeft: '14px',
    paddingRight: '14px',
    fontSize: tokens.fontSizeBase300,
    cursor: 'pointer',
    transitionProperty: 'background-color',
    transitionDuration: '150ms',
    color: tokens.colorNeutralForeground1,
    backgroundColor: 'transparent',
    border: 'none',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground2,
    },
    ':active': {
      backgroundColor: tokens.colorNeutralBackground2,
    },
  },
  folderIcon: {
    flexShrink: 0,
    color: tokens.colorPaletteYellowForeground1,
  },
  truncate: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  pathBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  navButton: {
    flexShrink: 0,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalS,
    color: tokens.colorNeutralForeground2,
    transitionProperty: 'color, background-color',
    transitionDuration: '150ms',
    backgroundColor: 'transparent',
    border: 'none',
    cursor: 'pointer',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground2,
      color: tokens.colorNeutralForeground1,
    },
  },
  pathInput: {
    flex: '1 1 0',
    minWidth: 0,
  },
  listing: {
    height: '256px',
    overflowY: 'auto',
    borderRadius: tokens.borderRadiusXLarge,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground1,
  },
  emptyMessage: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
  },
  entriesColumn: {
    display: 'flex',
    flexDirection: 'column',
    paddingTop: '4px',
    paddingBottom: '4px',
  },
});

type DirectoryEntry = { name: string; path: string; isDirectory: boolean };

type DirectoryRowProps = {
  entry: DirectoryEntry;
  onNavigate: (path: string) => void;
};

const DirectoryRow = memo(({ entry, onNavigate }: DirectoryRowProps) => {
  const styles = useStyles();
  const handleClick = useCallback(() => {
    onNavigate(entry.path);
  }, [entry.path, onNavigate]);

  return (
    <button
      type="button"
      onClick={handleClick}
      className={styles.directoryRow}
    >
      <Folder20Regular style={{ width: 14, height: 14 }} className={styles.folderIcon} />
      <span className={styles.truncate}>{entry.name}</span>
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
  const styles = useStyles();
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
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>Select Directory</DialogHeader>
        <DialogBody className={styles.body}>
          {/* Path bar */}
          <div className={styles.pathBar}>
            <button
              type="button"
              onClick={handleHome}
              className={styles.navButton}
              title="Home"
            >
              <Home20Regular style={{ width: 16, height: 16 }} />
            </button>
            <button
              type="button"
              onClick={handleUp}
              className={styles.navButton}
              title="Parent directory"
            >
              <ArrowUp20Regular style={{ width: 16, height: 16 }} />
            </button>
            <Input
              type="text"
              value={pathInput}
              onChange={handlePathInputChange}
              onKeyDown={handlePathInputKeyDown}
              className={styles.pathInput}
            />
          </div>

          {/* Directory listing */}
          <div className={styles.listing}>
            {loading ? (
              <ListSkeleton rows={6} />
            ) : entries.length === 0 ? (
              <div className={styles.emptyMessage}>No subdirectories</div>
            ) : (
              <div className={styles.entriesColumn}>
                {entries.map((entry) => (
                  <DirectoryRow key={entry.path} entry={entry} onNavigate={handleNavigate} />
                ))}
              </div>
            )}
          </div>
        </DialogBody>
        <DialogFooter className="flex-col sm:flex-row gap-2 sm:justify-end">
          <Button onClick={handleConfirm} isDisabled={!currentPath} className="w-full sm:w-auto justify-center">
            Select
          </Button>
          <Button variant="ghost" onClick={onClose} className="w-full sm:w-auto justify-center">
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </AnimatedDialog>
  );
});
DirectoryBrowserDialog.displayName = 'DirectoryBrowserDialog';
