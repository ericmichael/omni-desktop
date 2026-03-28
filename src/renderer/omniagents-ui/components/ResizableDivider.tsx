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

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      setDragging(true)
      startX.current = e.clientX
      startWidth.current = currentWidth
      document.body.classList.add('resizing')
    },
    [currentWidth],
  )

  const onMouseMove = useCallback(
    (e: MouseEvent) => {
      const delta = startX.current - e.clientX
      const next = Math.min(maxWidth, Math.max(minWidth, startWidth.current + delta))
      onResize(next)
    },
    [minWidth, maxWidth, onResize],
  )

  const onMouseUp = useCallback(() => {
    setDragging(false)
    document.body.classList.remove('resizing')
  }, [])

  useEffect(() => {
    if (!dragging) return
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [dragging, onMouseMove, onMouseUp])

  return (
    <div
      className={[
        'w-1.5 flex-shrink-0 cursor-col-resize transition-colors group relative',
        dragging ? 'bg-tweetBlue/50' : 'bg-bgCardAlt hover:bg-tweetBlue/30',
      ].join(' ')}
      onMouseDown={onMouseDown}
    >
      <div className="absolute inset-y-0 -left-1 -right-1" />
    </div>
  )
}
