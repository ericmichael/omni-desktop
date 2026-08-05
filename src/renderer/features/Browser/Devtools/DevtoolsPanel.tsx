/**
 * Bottom-docked Devtools panel for the browser surface.
 *
 * Lives inside a BrowserView's body as an absolutely-positioned overlay so it
 * scopes to the active webview (each tabset/tab has its own panel instance).
 * Tabs: Network, Console, Storage, Elements. Resizable via a top-edge drag
 * handle. Closed by default; toggled with `Cmd+Alt+I` from BrowserView.
 */
import { X } from 'lucide-react';
import { memo, useState } from 'react';

import type { ConsoleMessage } from '@/renderer/common/Webview';
import { Button } from '@/renderer/ds/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/renderer/ds/ui/resizable';
import { Tabs, TabsList, TabsTrigger } from '@/renderer/ds/ui/tabs';
import { ConsoleTab } from '@/renderer/features/Browser/Devtools/ConsoleTab';
import { ElementsTab } from '@/renderer/features/Browser/Devtools/ElementsTab';
import { NetworkTab } from '@/renderer/features/Browser/Devtools/NetworkTab';
import { StorageTab } from '@/renderer/features/Browser/Devtools/StorageTab';
import type { AppHandleId } from '@/shared/app-control-types';

export type DevtoolsTab = 'network' | 'console' | 'storage' | 'elements';

export const DevtoolsPanel = memo(
  ({
    handleId,
    activeOrigin,
    consoleLog,
    onClear,
    onClose,
  }: {
    handleId: AppHandleId;
    activeOrigin: string | null;
    consoleLog: Array<ConsoleMessage & { timestamp: number }>;
    onClear: () => void;
    onClose: () => void;
  }) => {
    const [tab, setTab] = useState<DevtoolsTab>('network');

    return (
      <ResizablePanelGroup orientation="vertical" className="pointer-events-none absolute inset-0 z-15">
        <ResizablePanel minSize={0} />
        <ResizableHandle className="pointer-events-auto" />
        <ResizablePanel defaultSize={280} minSize={140} maxSize={600} groupResizeBehavior="preserve-pixel-size">
          <Tabs
            value={tab}
            onValueChange={(value) => setTab(value as DevtoolsTab)}
            className="pointer-events-auto flex h-full flex-col border-t bg-background shadow-lg"
          >
            <div className="flex items-center h-7.5 pl-4 pr-2 border-b border-border bg-card gap-0.5 select-none select-none">
              <TabsList className="h-7 bg-transparent p-0">
                {(['network', 'console', 'storage', 'elements'] as const).map((value) => (
                  <TabsTrigger key={value} value={value} className="h-6 px-2 text-xs capitalize">
                    {value}
                  </TabsTrigger>
                ))}
              </TabsList>
              <div className="flex-1" />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Close devtools"
                title="Close (Cmd+Alt+I)"
                onClick={onClose}
              >
                <X />
              </Button>
            </div>
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
              {tab === 'network' && <NetworkTab handleId={handleId} />}
              {tab === 'console' && <ConsoleTab entries={consoleLog} onClear={onClear} />}
              {tab === 'storage' && <StorageTab handleId={handleId} activeOrigin={activeOrigin} />}
              {tab === 'elements' && <ElementsTab handleId={handleId} />}
            </div>
          </Tabs>
        </ResizablePanel>
      </ResizablePanelGroup>
    );
  }
);
DevtoolsPanel.displayName = 'DevtoolsPanel';
