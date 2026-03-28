import React, { useEffect, useState } from 'react'
import clsx from 'clsx'

export function Avatar({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={clsx('relative inline-flex h-8 w-8 shrink-0 rounded-full overflow-hidden bg-bgCardAlt text-textPrimary items-center justify-center', className)} {...props}>
      {children}
    </div>
  )
}

export function AvatarImage({ className, src, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) {
  return <img src={src} alt={alt} className={clsx('absolute inset-0 h-full w-full object-cover', className)} {...props} />
}

type FallbackProps = React.HTMLAttributes<HTMLDivElement> & { delayMs?: number }

export function AvatarFallback({ className, delayMs, children, ...props }: FallbackProps) {
  const [show, setShow] = useState(!delayMs)
  useEffect(() => {
    if (delayMs) {
      const t = setTimeout(() => setShow(true), delayMs)
      return () => clearTimeout(t)
    }
  }, [delayMs])
  if (!show) return null
  return (
    <div className={clsx('relative z-0 flex h-full w-full items-center justify-center text-sm', className)} {...props}>
      {children}
    </div>
  )
}

