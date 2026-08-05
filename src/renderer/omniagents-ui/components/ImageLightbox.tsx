import { Minus, Plus, RotateCcw, X } from 'lucide-react';
import React, { useCallback, useRef, useState } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/renderer/ds/ui/dialog';

type Props = {
  src: string;
  alt: string;
  onClose: () => void;
};

export function ImageLightbox({ src, alt, onClose }: Props) {
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const dragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  const resetView = useCallback(() => {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
  }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.stopPropagation();
    setScale((s) => Math.min(Math.max(0.25, s - e.deltaY * 0.001), 5));
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (scale <= 1) {
        return;
      }
      dragging.current = true;
      lastPos.current = { x: e.clientX, y: e.clientY };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [scale]
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) {
      return;
    }
    const dx = e.clientX - lastPos.current.x;
    const dy = e.clientY - lastPos.current.y;
    lastPos.current = { x: e.clientX, y: e.clientY };
    setTranslate((t) => ({ x: t.x + dx, y: t.y + dy }));
  }, []);

  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="inset-0 top-0 left-0 flex h-screen w-screen max-w-none translate-x-0 translate-y-0 items-center justify-center rounded-none border-0 bg-background/90 p-0"
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        {/* Controls */}
        <div className="absolute top-4 right-4 z-10 flex gap-2" onClick={(e) => e.stopPropagation()}>
          <Button
            type="button"
            variant="secondary"
            size="icon"
            onClick={() => setScale((s) => Math.min(s + 0.5, 5))}
            aria-label="Zoom in"
          >
            <Plus />
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="icon"
            onClick={() => setScale((s) => Math.max(s - 0.5, 0.25))}
            aria-label="Zoom out"
          >
            <Minus />
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={resetView}>
            <RotateCcw />
            Reset
          </Button>
          <Button type="button" variant="secondary" size="icon" onClick={onClose} aria-label="Close">
            <X />
          </Button>
        </div>

        {/* Image */}
        <img
          src={src}
          alt={alt}
          className={`image-lightbox-media select-none object-contain ${scale > 1 ? 'cursor-grab' : 'cursor-zoom-in'}`}
          style={{
            transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
          }}
          draggable={false}
          onClick={(e) => {
            e.stopPropagation();
            if (scale <= 1) {
              setScale(2);
            }
          }}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
      </DialogContent>
    </Dialog>
  );
}
