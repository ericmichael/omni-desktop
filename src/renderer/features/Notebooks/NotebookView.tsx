import { CircleX, Puzzle } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Webview } from '@/renderer/common/Webview';
import { Button } from '@/renderer/ds/ui/button';
import { Spinner } from '@/renderer/ds/ui/spinner';
import { emitter, ipc } from '@/renderer/services/ipc';
import type { ExtensionInstanceState } from '@/shared/extensions';
import type { PageId } from '@/shared/types';

const MARIMO_EXTENSION_ID = 'marimo';

type Paths = { filePath: string; projectDir: string };

export const NotebookView = memo(({ pageId }: { pageId: PageId }) => {
  const [paths, setPaths] = useState<Paths | null>(null);
  const [status, setStatus] = useState<ExtensionInstanceState>({ state: 'idle' });
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const cwdRef = useRef<string | null>(null);

  // Resolve on-disk paths whenever the pageId changes.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await emitter.invoke('page:get-notebook-paths', pageId);
      if (!cancelled) {
        setPaths(result);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pageId]);

  // Check whether marimo is enabled (controls whether we even try to start).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await emitter.invoke('extension:list-descriptors');
      const marimo = list.find((d) => d.id === MARIMO_EXTENSION_ID);
      if (!cancelled) {
        setEnabled(marimo?.enabled ?? false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Reset status whenever the open notebook changes. Without this, `status`
  // continues to reflect the previous notebook's running state until a fresh
  // `extension:status-changed` event arrives — which means `webviewSrc`
  // briefly composes the old marimo URL with the new file path, flashing
  // the wrong notebook in the iframe. Clearing to `idle` shows the
  // "Preparing…" spinner instead, which is honest: we genuinely don't know
  // this notebook's state yet.
  useEffect(() => {
    setStatus({ state: 'idle' });
  }, [paths]);

  // Subscribe to live status updates for this instance.
  useEffect(() => {
    if (!paths) {
      return;
    }
    const cwd = paths.projectDir;
    const off = ipc.on('extension:status-changed', (id, eventCwd, next) => {
      if (id === MARIMO_EXTENSION_ID && eventCwd === cwd) {
        setStatus(next);
      }
    });
    return off;
  }, [paths]);

  // Ensure the instance once we know the cwd and marimo is enabled.
  useEffect(() => {
    if (!paths || !enabled) {
      return;
    }
    const cwd = paths.projectDir;
    cwdRef.current = cwd;
    let cancelled = false;
    let released = false;

    void (async () => {
      try {
        // Prime the notebook's marimo AI configuration before launch.
        await emitter.invoke('page:prepare-notebook', pageId);
        if (cancelled) {
          return;
        }
        // Pre-fetch current status so we render correctly even before the
        // first event. The `cancelled` guard is load-bearing: without it, a
        // late resolve from this effect's closure could clobber a newer
        // status update that arrived via `extension:status-changed` on the
        // next effect run (for example, during rapid notebook switches).
        const current = await emitter.invoke('extension:get-instance-status', MARIMO_EXTENSION_ID, cwd);
        if (cancelled) {
          return;
        }
        setStatus(current);
        await emitter.invoke('extension:ensure-instance', MARIMO_EXTENSION_ID, cwd);
      } catch {
        // The status event will reflect the error; nothing more to do here.
      }
    })();

    return () => {
      cancelled = true;
      if (released) {
        return;
      }
      released = true;
      void emitter.invoke('extension:release-instance', MARIMO_EXTENSION_ID, cwd);
    };
  }, [paths, enabled, pageId]);

  const onRetry = useCallback(() => {
    const cwd = cwdRef.current;
    if (!cwd) {
      return;
    }
    void emitter.invoke('extension:ensure-instance', MARIMO_EXTENSION_ID, cwd);
  }, []);

  const webviewSrc = useMemo(() => {
    if (status.state !== 'running' || !paths) {
      return undefined;
    }
    return `${status.url}/?file=${encodeURIComponent(paths.filePath)}`;
  }, [status, paths]);

  if (enabled === false) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6 text-muted-foreground">
        <Puzzle className="size-8" />
        <div className="font-semibold text-base">Marimo extension is disabled</div>
        <div className="text-xs text-muted-foreground text-center max-w-lg">
          Enable the Marimo Notebooks extension in Settings → Extensions to open this notebook.
        </div>
      </div>
    );
  }

  if (!paths || enabled === null || status.state === 'idle' || status.state === 'starting') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6 text-muted-foreground">
        <Spinner />
        <div className="font-semibold text-base">Preparing notebook environment…</div>
        <div className="text-xs text-muted-foreground text-center max-w-lg">
          First open of a notebook with new dependencies can take 10–30 seconds while uv resolves the environment.
        </div>
      </div>
    );
  }

  if (status.state === 'error') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6 text-muted-foreground">
        <CircleX className={`size-6 ${'text-destructive'}`} />
        <div className="font-semibold text-base">Failed to start marimo</div>
        <div className="text-xs text-muted-foreground text-center max-w-lg">{status.error}</div>
        {status.lastStderr && (
          <pre className="w-full max-w-2xl max-h-60 overflow-auto p-4 border border-border rounded-lg bg-card font-mono text-xs whitespace-pre-wrap">
            {status.lastStderr.slice(-2000)}
          </pre>
        )}
        <Button onClick={onRetry}>Retry</Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col w-full h-full">
      <div className="flex-1 min-h-0 relative">
        <Webview src={webviewSrc} />
      </div>
    </div>
  );
});
NotebookView.displayName = 'NotebookView';
