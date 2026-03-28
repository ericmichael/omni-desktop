import React from 'react'
import clsx from 'clsx'

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={clsx('min-h-[44px] w-full resize-none border-none bg-transparent px-4 py-3 text-sm text-textHeading placeholder:text-textSubtle outline-none focus:ring-0', className)}
      {...props}
    />
  )
})

export default Textarea

