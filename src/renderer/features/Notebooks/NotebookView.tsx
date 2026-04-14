import { makeStyles, Spinner, tokens } from '@fluentui/react-components';
import { ErrorCircle20Regular, PuzzlePiece20Filled } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Webview, type WebviewHandle } from '@/renderer/common/Webview';
import { Button } from '@/renderer/ds';
import { emitter, ipc } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type { ExtensionInstanceState } from '@/shared/extensions';
import type { PageId } from '@/shared/types';

const MARIMO_EXTENSION_ID = 'marimo';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', width: '100%', height: '100%' },
  state: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalXL,
    color: tokens.colorNeutralForeground2,
  },
  title: { fontWeight: 600, fontSize: tokens.fontSizeBase400 },
  hint: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    textAlign: 'center',
    maxWidth: '480px',
  },
  errorIcon: { color: tokens.colorPaletteRedForeground1 },
  errorBox: {
    width: '100%',
    maxWidth: '640px',
    maxHeight: '240px',
    overflow: 'auto',
    padding: tokens.spacingHorizontalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase100,
    whiteSpace: 'pre-wrap',
  },
  webviewWrap: { flex: 1, minHeight: 0, position: 'relative' },
});

type Paths = { filePath: string; projectDir: string };

export const NotebookView = memo(({ pageId }: { pageId: PageId }) => {
  const styles = useStyles();
  const [paths, setPaths] = useState<Paths | null>(null);
  const [status, setStatus] = useState<ExtensionInstanceState>({ state: 'idle' });
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const cwdRef = useRef<string | null>(null);

  // Glass mode tracks the launcher's Code Deck background — when set, the
  // chrome goes transparent/blurred and we want marimo to follow suit.
  // Marimo styling is delivered via its own per-notebook `css_file` argument
  // (a sidecar file the main process writes/rewrites), not runtime DOM
  // injection — that path doesn't work for iframes (browser/server mode) and
  // marimo's HTML pipeline is more reliable anyway.
  const persisted = useStore(persistedStoreApi.$atom);
  const isGlass = !!persisted.codeDeckBackground;
  // Mirror isGlass into a ref so the ensure-instance effect can read the
  // current value without listing isGlass as a dep (which would unnecessarily
  // tear down marimo on every glass toggle).
  const isGlassRef = useRef(isGlass);
  useEffect(() => {
    isGlassRef.current = isGlass;
  }, [isGlass]);

  const webviewRef = useRef<WebviewHandle>(null);
  const lastAppliedGlassRef = useRef<boolean | null>(null);

  // When the launcher's glass mode toggles AFTER marimo is already running,
  // rewrite the CSS sidecar file and reload the webview so marimo re-inlines
  // the new content. Skipped on the first run for a given (paths, isGlass)
  // pair because `prepare-notebook` (below) already wrote the right content
  // before the webview ever loaded.
  useEffect(() => {
    if (!paths) {
return;
}
    if (status.state !== 'running') {
return;
}
    if (lastAppliedGlassRef.current === isGlass) {
return;
}

    // First time we observe the running state for this paths value, just
    // record the current isGlass without reloading — prepare-notebook already
    // primed the file.
    if (lastAppliedGlassRef.current === null) {
      lastAppliedGlassRef.current = isGlass;
      return;
    }

    lastAppliedGlassRef.current = isGlass;
    void (async () => {
      try {
        await emitter.invoke('page:set-notebook-glass', paths.projectDir, isGlass);
        webviewRef.current?.reload();
      } catch {
        // The status pane will surface marimo errors; CSS rewrite failures
        // are non-fatal — the notebook just keeps the previous glass state.
      }
    })();
  }, [isGlass, paths, status.state]);

  // Reset the "first apply" tracker when the open notebook changes.
  useEffect(() => {
    lastAppliedGlassRef.current = null;
  }, [paths]);

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
        // Prime the marimo glass CSS sidecar and migrate the notebook to
        // reference it. Idempotent — safe to call on every open.
        await emitter.invoke('page:prepare-notebook', pageId, isGlassRef.current);
        if (cancelled) {
          return;
        }
        // Pre-fetch current status so we render correctly even before the
        // first event. The `cancelled` guard is load-bearing: without it, a
        // late resolve from this effect's closure could clobber a newer
        // status update that arrived via `extension:status-changed` on the
        // next effect run (e.g. rapid notebook switches or glass toggles).
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
      <div className={styles.state}>
        <PuzzlePiece20Filled />
        <div className={styles.title}>Marimo extension is disabled</div>
        <div className={styles.hint}>
          Enable the Marimo Notebooks extension in Settings → Extensions to open this notebook.
        </div>
      </div>
    );
  }

  if (!paths || enabled === null || status.state === 'idle' || status.state === 'starting') {
    return (
      <div className={styles.state}>
        <Spinner size="medium" />
        <div className={styles.title}>Preparing notebook environment…</div>
        <div className={styles.hint}>
          First open of a notebook with new dependencies can take 10–30 seconds while uv resolves the environment.
        </div>
      </div>
    );
  }

  if (status.state === 'error') {
    return (
      <div className={styles.state}>
        <ErrorCircle20Regular className={styles.errorIcon} />
        <div className={styles.title}>Failed to start marimo</div>
        <div className={styles.hint}>{status.error}</div>
        {status.lastStderr && <pre className={styles.errorBox}>{status.lastStderr.slice(-2000)}</pre>}
        <Button onClick={onRetry}>Retry</Button>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.webviewWrap}>
        <Webview ref={webviewRef} src={webviewSrc} />
      </div>
    </div>
  );
});
NotebookView.displayName = 'NotebookView';
