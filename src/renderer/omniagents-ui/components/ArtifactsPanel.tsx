import { CodeIcon, FileTextIcon, GlobeIcon, ImageIcon, XIcon } from 'lucide-react';
import React, { useMemo } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import { Item, ItemContent, ItemMedia, ItemTitle } from '@/renderer/ds/ui/item';
import { ScrollArea } from '@/renderer/ds/ui/scroll-area';
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from '@/renderer/ds/ui/sheet';
import type { ArtifactItem } from '@/shared/chat-types';
export type { ArtifactItem } from '@/shared/chat-types';

const MODE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  markdown: FileTextIcon,
  html: GlobeIcon,
  image: ImageIcon,
  pdf: FileTextIcon,
  code: CodeIcon,
};

function ArtifactRow({ item, onScrollTo }: { item: ArtifactItem; onScrollTo?: (artifactId: string) => void }) {
  const Icon = MODE_ICON[item.mode || 'markdown'] || FileTextIcon;
  return (
    <Item asChild size="sm" className="w-full cursor-pointer hover:bg-accent">
      <button type="button" onClick={() => item.artifact_id && onScrollTo?.(item.artifact_id)}>
        <ItemMedia>
          <Icon className="text-muted-foreground" />
        </ItemMedia>
        <ItemContent>
          <ItemTitle className="truncate">{item.title || 'Artifact'}</ItemTitle>
        </ItemContent>
      </button>
    </Item>
  );
}

export function ArtifactsPanel({
  artifacts,
  onClose,
  onScrollTo,
  asOverlay = false,
}: {
  artifacts: ArtifactItem[];
  onClose?: () => void;
  onScrollTo?: (artifactId: string) => void;
  asOverlay?: boolean;
}) {
  const items = useMemo(() => {
    const copy = artifacts.slice();
    copy.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
    return copy;
  }, [artifacts]);

  if (!items.length) {
    return null;
  }

  const list = (
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-0.5 p-2">
        {items.map((a, idx) => (
          <ArtifactRow key={a.artifact_id || idx} item={a} onScrollTo={onScrollTo} />
        ))}
      </div>
    </ScrollArea>
  );

  if (asOverlay) {
    return (
      <Sheet open onOpenChange={(open) => !open && onClose?.()}>
        <SheetContent side="right" showCloseButton={false} className="w-full max-w-11/12 gap-0 p-0 sm:max-w-xs">
          <SheetHeader className="flex-row items-center justify-between border-b px-4 py-3 text-left">
            <SheetTitle className="text-sm">Artifacts</SheetTitle>
            <SheetClose asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Close">
                <XIcon />
              </Button>
            </SheetClose>
          </SheetHeader>
          {list}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between flex-shrink-0">
        <div className="text-sm font-semibold text-foreground">Artifacts</div>
        <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close panel">
          <XIcon />
        </Button>
      </div>
      {list}
    </div>
  );
}
