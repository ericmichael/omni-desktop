import React, { useCallback, useEffect, useRef, useState } from 'react'

type Props = {
  src: string
  alt: string
  onClose: () => void
}

export function ImageLightbox({ src, alt, onClose }: Props) {
  const [scale, setScale] = useState(1)
  const [translate, setTranslate] = useState({ x: 0, y: 0 })
  const dragging = useRef(false)
  const lastPos = useRef({ x: 0, y: 0 })

  const resetView = useCallback(() => {
    setScale(1)
    setTranslate({ x: 0, y: 0 })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
onClose()
}
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.stopPropagation()
    setScale((s) => Math.min(Math.max(0.25, s - e.deltaY * 0.001), 5))
  }, [])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (scale <= 1) {
return
}
    dragging.current = true
    lastPos.current = { x: e.clientX, y: e.clientY }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [scale])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) {
return
}
    const dx = e.clientX - lastPos.current.x
    const dy = e.clientY - lastPos.current.y
    lastPos.current = { x: e.clientX, y: e.clientY }
    setTranslate((t) => ({ x: t.x + dx, y: t.y + dy }))
  }, [])

  const onPointerUp = useCallback(() => {
    dragging.current = false
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
      onClick={onClose}
    >
      {/* Controls */}
      <div
        className="absolute top-4 right-4 z-10 flex gap-2"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="w-8 h-8 rounded bg-white/20 hover:bg-white/30 text-white text-sm"
          onClick={() => setScale((s) => Math.min(s + 0.5, 5))}
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          className="w-8 h-8 rounded bg-white/20 hover:bg-white/30 text-white text-sm"
          onClick={() => setScale((s) => Math.max(s - 0.5, 0.25))}
          aria-label="Zoom out"
        >
          −
        </button>
        <button
          className="h-8 px-2 rounded bg-white/20 hover:bg-white/30 text-white text-xs"
          onClick={resetView}
        >
          Reset
        </button>
        <button
          className="w-8 h-8 rounded bg-white/20 hover:bg-white/30 text-white text-sm"
          onClick={onClose}
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      {/* Image */}
      <img
        src={src}
        alt={alt}
        className="max-w-[90vw] max-h-[90vh] object-contain select-none"
        style={{
          transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
          cursor: scale > 1 ? 'grab' : 'zoom-in',
        }}
        draggable={false}
        onClick={(e) => {
          e.stopPropagation()
          if (scale <= 1) {
setScale(2)
}
        }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
    </div>
  )
}
