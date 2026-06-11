import '@excalidraw/excalidraw/index.css';

import { Excalidraw, serializeAsJSON } from '@excalidraw/excalidraw';
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, BinaryFiles, ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types';
import { useCallback, useMemo, useRef } from 'react';

/**
 * Excalidraw editor surface for a drawing page. Thin wrapper, mirroring how
 * ContextEditor wraps Yoopta: it owns the `<Excalidraw>` mount and translates
 * canvas edits into a serialized `.excalidraw` JSON string the caller persists.
 *
 * Mounted lazily by PageView (the heavy Excalidraw chunk loads on demand) and
 * re-keyed on the page-editor machine's `revision`, so a fresh instance reads
 * `initialScene` on every load / external-reload / conflict-resolve.
 */
export type ExcalidrawCanvasProps = {
  /** Serialized `.excalidraw` JSON scene (the page body). Empty string = blank. */
  initialScene: string;
  /** Called with a fresh serialized scene whenever the drawing meaningfully changes. */
  onChangeScene: (scene: string) => void;
};

/** Debounce before serializing + emitting an edit (the canvas fires onChange rapidly). */
const CHANGE_DEBOUNCE_MS = 300;

function parseScene(raw: string): ExcalidrawInitialDataState | null {
  if (!raw.trim()) {
    return null;
  }
  try {
    const data = JSON.parse(raw) as ExcalidrawInitialDataState;
    return {
      elements: data.elements ?? [],
      appState: data.appState ?? {},
      files: data.files ?? {},
    };
  } catch {
    // Corrupt body — start from a blank canvas rather than crashing the view.
    return null;
  }
}

/**
 * Signature capturing only *content* changes (element edits, additions,
 * deletions, attached files) — not viewport pans/zooms or cursor moves. Excalidraw
 * bumps each element's `version` on every mutation, so summing ids+versions is a
 * cheap, reliable change detector that keeps a pan from marking the page dirty.
 */
function contentSignature(elements: readonly OrderedExcalidrawElement[], files: BinaryFiles): string {
  const els = elements.map((e) => `${e.id}:${e.version}`).join(',');
  const fileIds = Object.keys(files).sort().join(',');
  return `${els}|${fileIds}`;
}

export function ExcalidrawCanvas({ initialScene, onChangeScene }: ExcalidrawCanvasProps) {
  const initialData = useMemo(() => parseScene(initialScene), [initialScene]);

  // Seed the last-emitted signature from the initial scene so the onChange that
  // Excalidraw fires right after mount (echoing the loaded elements) doesn't get
  // mistaken for a user edit and written straight back.
  const lastSig = useRef<string>(
    contentSignature(
      (initialData?.elements ?? []) as readonly OrderedExcalidrawElement[],
      (initialData?.files ?? {}) as BinaryFiles
    )
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleChange = useCallback(
    (elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      const sig = contentSignature(elements, files);
      if (sig === lastSig.current) {
        return; // viewport/selection-only change — nothing to persist
      }
      lastSig.current = sig;
      if (timer.current) {
        clearTimeout(timer.current);
      }
      timer.current = setTimeout(() => {
        onChangeScene(serializeAsJSON(elements, appState, files, 'database'));
      }, CHANGE_DEBOUNCE_MS);
    },
    [onChangeScene]
  );

  return (
    <div style={{ height: '100%', width: '100%', position: 'relative' }}>
      <Excalidraw initialData={initialData} onChange={handleChange} />
    </div>
  );
}
