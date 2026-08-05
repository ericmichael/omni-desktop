import './QuickCapture.css';

import { useStore } from '@nanostores/react';
import { ArrowUp, Inbox } from 'lucide-react';
import { atom } from 'nanostores';
import { memo, useCallback, useRef, useState } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';

import { useIsDesktop } from '@/renderer/common/use-is-desktop';
import { Button } from '@/renderer/ds/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/renderer/ds/ui/dialog';
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/renderer/ds/ui/drawer';
import { Input } from '@/renderer/ds/ui/input';
import { Kbd } from '@/renderer/ds/ui/kbd';
import { inboxApi } from '@/renderer/features/Inbox/state';

/** Whether the global quick-capture overlay is open. */
export const $quickCaptureOpen = atom(false);

const hotkeyOptions = { enableOnFormTags: true } as const;

/**
 * Global quick capture using the shadcn responsive-dialog pattern:
 * Dialog on desktop and a swipe-dismissable Drawer on mobile.
 */
export const QuickCapture = memo(() => {
  const open = useStore($quickCaptureOpen);
  const isDesktop = useIsDesktop();
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const toggle = useCallback(() => {
    const willOpen = !$quickCaptureOpen.get();
    if (willOpen) {
      setValue('');
      setSaved(false);
    }
    $quickCaptureOpen.set(willOpen);
  }, []);

  const close = useCallback(() => {
    $quickCaptureOpen.set(false);
    setSaved(false);
  }, []);

  useHotkeys('ctrl+i', toggle, hotkeyOptions);

  const submit = useCallback(async () => {
    const title = value.trim();
    if (!title) {
      return;
    }

    await inboxApi.add({ title });
    setSaved(true);
    setValue('');
    setTimeout(close, 350);
  }, [close, value]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void submit();
      }
    },
    [submit]
  );

  const captureInput = (
    <Input
      ref={inputRef}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={handleKeyDown}
      autoFocus
      placeholder="What needs capturing?"
      aria-label="Quick capture"
      className="border-0 bg-transparent shadow-none focus-visible:ring-0"
    />
  );

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && close()}>
        <DialogContent
          className={saved ? 'gap-0 border-success/50 bg-success/10 p-0 sm:max-w-lg' : 'gap-0 p-0 sm:max-w-lg'}
          showCloseButton={false}
        >
          <DialogHeader className="flex-row items-center gap-2 border-b px-4 py-3 text-left">
            <Inbox className="size-4 text-primary" />
            <DialogTitle className="flex-1 text-sm">Quick Capture</DialogTitle>
            <DialogDescription className="sr-only">Add a new item to your inbox.</DialogDescription>
            <Kbd>Esc</Kbd>
          </DialogHeader>
          <div className="px-2 py-2">{captureInput}</div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Drawer open={open} onOpenChange={(nextOpen) => !nextOpen && close()} direction="bottom">
      <DrawerContent className={saved ? 'border-success/50 bg-success/10' : undefined}>
        <DrawerHeader className="flex-row items-center gap-2 pb-2 text-left">
          <Inbox className="size-4 text-primary" />
          <DrawerTitle className="text-sm">Quick Capture</DrawerTitle>
          <DrawerDescription className="sr-only">Add a new item to your inbox.</DrawerDescription>
        </DrawerHeader>
        <div className="omni-quick-capture-actions flex items-center gap-2 px-4">
          <div className="min-w-0 flex-1 rounded-md border bg-background">{captureInput}</div>
          <Button
            size="sm"
            aria-label="Submit"
            disabled={!value.trim()}
            onClick={() => void submit()}
            className="size-9 px-0"
          >
            <ArrowUp />
          </Button>
        </div>
      </DrawerContent>
    </Drawer>
  );
});

QuickCapture.displayName = 'QuickCapture';
