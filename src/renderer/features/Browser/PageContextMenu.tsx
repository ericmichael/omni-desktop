/**
 * Page context menu for Electron webview context-menu events.
 *
 * Electron supplies coordinates outside Radix's normal pointer-event path, so
 * an invisible positioned trigger bridges those coordinates into the stock
 * shadcn DropdownMenu. Radix owns focus, keyboard navigation, dismissal and
 * collision handling.
 */
import { memo } from 'react';

import type { ContextMenuParams } from '@/renderer/common/Webview';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/renderer/ds/ui/dropdown-menu';

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
    const hasLink = !!params.linkURL;
    const hasImage = !!(params.hasImageContents && params.srcURL);
    const hasSelection = !!(params.selectionText && params.selectionText.trim().length > 0);

    return (
      <DropdownMenu open onOpenChange={(open) => !open && onClose()}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none absolute size-px opacity-0"
            style={{ left: params.x, top: params.y }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="right"
          sideOffset={0}
          className="min-w-56 max-w-72"
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {hasLink && (
            <>
              <DropdownMenuItem onSelect={() => actions.openInNewTab(params.linkURL!)}>
                Open link in new tab
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => actions.openExternal(params.linkURL!)}>
                Open link in external browser
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => actions.copyText(params.linkURL!)}>Copy link address</DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {hasImage && (
            <>
              <DropdownMenuItem onSelect={() => actions.openInNewTab(params.srcURL!)}>
                Open image in new tab
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => actions.copyText(params.srcURL!)}>Copy image address</DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {hasSelection && (
            <>
              <DropdownMenuItem onSelect={() => actions.copyText(params.selectionText!)}>Copy</DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  actions.navigate(`https://duckduckgo.com/?q=${encodeURIComponent(params.selectionText!)}`)
                }
              >
                Search “{truncate(params.selectionText!, 24)}”
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onSelect={actions.back}>
            Back
            <DropdownMenuShortcut>⌘[</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={actions.forward}>
            Forward
            <DropdownMenuShortcut>⌘]</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={actions.reload}>
            Reload
            <DropdownMenuShortcut>⌘R</DropdownMenuShortcut>
          </DropdownMenuItem>
          {params.pageURL && (
            <DropdownMenuItem onSelect={() => actions.copyText(params.pageURL!)}>Copy page URL</DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={actions.viewSource}>View page source</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => actions.inspect(params.x, params.y)}>Inspect element</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
);
PageContextMenu.displayName = 'PageContextMenu';

function truncate(value: string, length: number): string {
  const trimmed = value.trim();
  return trimmed.length > length ? `${trimmed.slice(0, length)}…` : trimmed;
}
