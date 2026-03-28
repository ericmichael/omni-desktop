import React from 'react'
import clsx from 'clsx'

export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

export function Tooltip({ children, className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={clsx('relative inline-block', className)} {...props}>
      {children}
    </div>
  )
}

type TriggerProps = React.HTMLAttributes<HTMLSpanElement> & { asChild?: boolean; disabled?: boolean }

export function TooltipTrigger({ asChild, disabled, children, className, ...props }: TriggerProps) {
  return (
    <span className={clsx('group inline-flex', className)} aria-disabled={disabled} {...props}>
      {children}
    </span>
  )
}

type ContentProps = React.HTMLAttributes<HTMLDivElement> & { side?: 'top' | 'bottom' | 'left' | 'right' }

export function TooltipContent({ side = 'top', className, children, ...props }: ContentProps) {
  const pos = side === 'top'
    ? 'bottom-full left-1/2 -translate-x-1/2 mb-1'
    : side === 'bottom'
      ? 'top-full left-1/2 -translate-x-1/2 mt-1'
      : side === 'left'
        ? 'right-full top-1/2 -translate-y-1/2 mr-1'
        : 'left-full top-1/2 -translate-y-1/2 ml-1'
  return (
    <div className={clsx('pointer-events-none absolute hidden rounded bg-bgCardAlt px-2 py-1 text-xs text-textPrimary shadow-sm group-hover:block', pos, className)} {...props}>
      {children}
    </div>
  )
}

