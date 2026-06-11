/**
 * Page context menu — the custom right-click menu that shows up over the
 * webview. Built on top of Electron's `context-menu` event; we re-implement
 * the menu in DOM rather than using Electron's native MenuPopup so styling
 * matches the rest of the browser chrome and the menu can't miss on
 * multi-monitor DPI edge cases.
 *
 * Positioning is best-effort: the event coordinates are relative to the
 * webview viewport. We clamp to the bounding container (passed as
 * `containerRect`) so the menu never flies off-screen.
 */
import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { ContextMenuParams } from '@/renderer/common/Webview';

const useStyles = makeStyles({
  root: {
    position: 'absolute',
    zIndex: 20,
    minWidth: '220px',
    maxWidth: '280px',
    padding: '4px',
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusMedium,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    boxShadow: tokens.shadow28,
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 10px',
    borderRadius: tokens.borderRadiusSmall,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground1,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    border: 'none',
    backgroundColor: 'transparent',
    width: '100%',
    textAlign: 'left',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
    ':disabled': { opacity: 0.4, cursor: 'not-allowed' },
  },
  divider: {
    height: '1px',
    margin: '4px 0',
    backgroundColor: tokens.colorNeutralStroke1,
  },
  shortcut: {
    marginLeft: 'auto',
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
  },
});

export type PageContextMenuActions = {
  back: () => void;
  forward: () => void;
  reload: () => void;
  navigate: (url: string) => void;
  openInNewTab: (url: string) => void;
  openExternal: (url: string) => void;
  copyText: (text: string) => void;
  viewSource: () => void;
  inspect: (x: number, y: number) => void;
};

export const PageContextMenu = memo(
  ({
    params,
    actions,
    onClose,
  }: {
    params: ContextMenuParams;
    actions: PageContextMenuActions;
    onClose: () => void;
  }) => {
    const styles = useStyles();
    const ref = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState({ left: params.x, top: params.y });

    // Clamp within the parent's content box so the menu doesn't bleed out.
    useLayoutEffect(() => {
      const el = ref.current;
      const parent = el?.offsetParent as HTMLElement | null;
      if (!el || !parent) {
return;
}
      const pr = parent.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      let left = params.x;
      let top = params.y;
      if (left + rect.width > pr.width - 8) {
left = Math.max(8, pr.width - rect.width - 8);
}
      if (top + rect.height > pr.height - 8) {
top = Math.max(8, pr.height - rect.height - 8);
}
      setPos({ left, top });
    }, [params.x, params.y]);

    // Close on outside click or Escape.
    useEffect(() => {
      const onDocDown = (e: MouseEvent) => {
        if (!ref.current) {
return;
}
        if (!ref.current.contains(e.target as Node)) {
onClose();
}
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
onClose();
}
      };
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('keydown', onKey);
      return () => {
        document.removeEventListener('mousedown', onDocDown, true);
        document.removeEventListener('keydown', onKey);
      };
    }, [onClose]);

    const run = useCallback(
      (fn: () => void) => () => {
        fn();
        onClose();
      },
      [onClose]
    );

    const hasLink = !!params.linkURL;
    const hasImage = !!(params.hasImageContents && params.srcURL);
    const hasSelection = !!(params.selectionText && params.selectionText.trim().length > 0);

    return (
      <div ref={ref} className={styles.root} style={{ left: pos.left, top: pos.top }} role="menu">
        {hasLink && (
          <>
            <button type="button" className={styles.item} onClick={run(() => actions.openInNewTab(params.linkURL!))}>
              Open link in new tab
            </button>
            <button type="button" className={styles.item} onClick={run(() => actions.openExternal(params.linkURL!))}>
              Open link in external browser
            </button>
            <button type="button" className={styles.item} onClick={run(() => actions.copyText(params.linkURL!))}>
              Copy link address
            </button>
            <div className={styles.divider} />
          </>
        )}
        {hasImage && (
          <>
            <button type="button" className={styles.item} onClick={run(() => actions.openInNewTab(params.srcURL!))}>
              Open image in new tab
            </button>
            <button type="button" className={styles.item} onClick={run(() => actions.copyText(params.srcURL!))}>
              Copy image address
            </button>
            <div className={styles.divider} />
          </>
        )}
        {hasSelection && (
          <>
            <button type="button" className={styles.item} onClick={run(() => actions.copyText(params.selectionText!))}>
              Copy
            </button>
            <button
              type="button"
              className={styles.item}
              onClick={run(() =>
                actions.navigate(`https://duckduckgo.com/?q=${encodeURIComponent(params.selectionText!)}`)
              )}
            >
              Search “{truncate(params.selectionText!, 24)}”
            </button>
            <div className={styles.divider} />
          </>
        )}
        <button type="button" className={styles.item} onClick={run(actions.back)}>
          Back
          <span className={styles.shortcut}>⌘[</span>
        </button>
        <button type="button" className={styles.item} onClick={run(actions.forward)}>
          Forward
          <span className={styles.shortcut}>⌘]</span>
        </button>
        <button type="button" className={styles.item} onClick={run(actions.reload)}>
          Reload
          <span className={styles.shortcut}>⌘R</span>
        </button>
        {params.pageURL && (
          <button type="button" className={styles.item} onClick={run(() => actions.copyText(params.pageURL!))}>
            Copy page URL
          </button>
        )}
        <div className={styles.divider} />
        <button type="button" className={styles.item} onClick={run(actions.viewSource)}>
          View page source
        </button>
        <button type="button" className={styles.item} onClick={run(() => actions.inspect(params.x, params.y))}>
          Inspect element
        </button>
      </div>
    );
  }
);
PageContextMenu.displayName = 'PageContextMenu';

function truncate(s: string, n: number): string {
  const trimmed = s.trim();
  return trimmed.length > n ? `${trimmed.slice(0, n)}…` : trimmed;
}
