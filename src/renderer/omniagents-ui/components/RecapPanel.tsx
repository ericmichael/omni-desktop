import React from 'react';

import { Button } from '@/renderer/ds/ui/button';
import { Card } from '@/renderer/ds/ui/card';
import { ScrollArea } from '@/renderer/ds/ui/scroll-area';

export type RecapInfo = {
  text: string;
  timestamp: number;
};

type Props = {
  recap: RecapInfo | null;
  onDismiss: () => void;
};

// Docked session-recap panel. Shows the most recent /recap output (or a
// programmatically-triggered recap) until dismissed. Styled like the
// Notifications panel (same semantic card + primary accent) but sized for
// a ~400-word block: scrollable, whitespace-preserving prose.
export function RecapPanel({ recap, onDismiss }: Props) {
  if (!recap) {
    return null;
  }

  return (
    <div className="px-3 pt-2">
      <Card className="gap-0 rounded-md border-accent bg-accent/60 p-2.5 shadow-none">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Session recap</span>
          <Button variant="ghost" size="xs" onClick={onDismiss} className="ml-auto" title="Dismiss recap">
            dismiss
          </Button>
        </div>
        <ScrollArea className="mt-1.5 max-h-64 whitespace-pre-wrap text-xs leading-5 text-foreground">
          {recap.text}
        </ScrollArea>
      </Card>
    </div>
  );
}
