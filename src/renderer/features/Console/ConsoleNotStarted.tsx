import { useStore } from '@nanostores/react';
import { memo } from 'react';

import { Strong } from '@/renderer/common/Strong';
import { Button } from '@/renderer/ds';
import { useNewTerminal } from '@/renderer/features/Console/use-new-terminal';
import { persistedStoreApi } from '@/renderer/services/store';

export const ConsoleNotRunning = memo(() => {
  const store = useStore(persistedStoreApi.$atom);
  const newTerminal = useNewTerminal();
  return (
    <div className="relative flex flex-col w-full h-full items-center justify-center gap-4">
      <Button variant="link" onClick={newTerminal}>
        Start Dev Console
      </Button>
      {store.workspaceDir && (
        <span className="text-sm text-fg-muted">
          We&apos;ll open the console in <Strong>{store.workspaceDir}</Strong>.
        </span>
      )}
    </div>
  );
});
ConsoleNotRunning.displayName = 'ConsoleNotRunning';
