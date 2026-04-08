import React, { useCallback, useEffect, useRef, useState } from 'react'

export function ResizableDivider({
  onResize,
  currentWidth,
  minWidth = 320,
  maxWidth = 800,
}: {
  onResize: (width: number) => void
  currentWidth: number
  minWidth?: number
  maxWidth?: number
}) {
  const [dragging, setDragging] = useState(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  const beginDrag = useCallback(
    (clientX: number) => {
      setDragging(true)
      startX.current = clientX
      startWidth.current = currentWidth
      document.body.classList.add('resizing')
    },
    [currentWidth],
  )

  const updateDrag = useCallback(
    (clientX: number) => {
      const delta = startX.current - clientX
      const next = Math.min(maxWidth, Math.max(minWidth, startWidth.current + delta))
      onResize(next)
    },
    [minWidth, maxWidth, onResize],
  )

  const endDrag = useCallback(() => {
    setDragging(false)
    document.body.classList.remove('resizing')
  }, [])

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      beginDrag(e.clientX)
    },
    [beginDrag],
  )

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0]
      if (!touch) return
      beginDrag(touch.clientX)
    },
    [beginDrag],
  )

  useEffect(() => {
    if (!dragging) return

    const handleMouseMove = (e: MouseEvent) => updateDrag(e.clientX)
    const handleTouchMove = (e: TouchEvent) => {
      const touch = e.touches[0]
      if (touch) updateDrag(touch.clientX)
    }
    const handleEnd = () => endDrag()

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleEnd)
    document.addEventListener('touchmove', handleTouchMove)
    document.addEventListener('touchend', handleEnd)
    document.addEventListener('touchcancel', handleEnd)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleEnd)
      document.removeEventListener('touchmove', handleTouchMove)
      document.removeEventListener('touchend', handleEnd)
      document.removeEventListener('touchcancel', handleEnd)
    }
  }, [dragging, updateDrag, endDrag])

  return (
    <div
      className={[
        'w-1.5 flex-shrink-0 cursor-col-resize transition-colors group relative touch-none',
        dragging ? 'bg-tweetBlue/50' : 'bg-bgCardAlt hover:bg-tweetBlue/30',
      ].join(' ')}
      onMouseDown={onMouseDown}
      onTouchStart={onTouchStart}
    >
      <div className="absolute inset-y-0 -left-1 -right-1" />
    </div>
  )
}
