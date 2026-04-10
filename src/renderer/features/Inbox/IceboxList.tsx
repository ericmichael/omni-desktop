import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect } from 'react';
import { PiArrowCounterClockwiseBold } from 'react-icons/pi';

import { Button, TopAppBar } from '@/renderer/ds';

import { $iceboxItems, inboxApi } from './state';

export const IceboxList = memo(({ onBack }: { onBack: () => void }) => {
  const iceboxMap = useStore($iceboxItems);
  const items = Object.values(iceboxMap).sort((a, b) => b.updatedAt - a.updatedAt);

  useEffect(() => {
    void inboxApi.fetchIceboxItems();
  }, []);

  const handleRestore = useCallback((id: string) => {
    void inboxApi.restoreFromIcebox(id);
  }, []);

  return (
    <div className="flex flex-col w-full h-full">
      <TopAppBar title="Icebox" onBack={onBack} />

      <div className="flex-1 min-h-0 overflow-y-auto px-2 sm:px-3 py-2">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 h-full px-4">
            <p className="text-fg-muted text-sm">Icebox is empty</p>
            <p className="text-fg-subtle text-xs">
              Items that sit in the inbox for 7 days without being shaped end up here.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {items.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-3 px-4 py-3 rounded-xl bg-surface-raised/30 border border-surface-border"
              >
                <div className="flex flex-col flex-1 min-w-0 gap-0.5">
                  <span className="text-sm text-fg truncate">{item.title}</span>
                  <span className="text-xs text-fg-subtle">
                    {new Date(item.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleRestore(item.id)}
                  aria-label="Restore to inbox"
                >
                  <PiArrowCounterClockwiseBold size={14} className="mr-1" />
                  Restore
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
IceboxList.displayName = 'IceboxList';
