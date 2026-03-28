import React from 'react'
import clsx from 'clsx'

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'secondary' | 'ghost'
  size?: 'default' | 'sm' | 'icon'
}

export function Button({ variant = 'default', size = 'default', className, ...props }: ButtonProps) {
  const base = 'inline-flex items-center justify-center font-medium transition-colors focus:outline-none disabled:pointer-events-none'
  const variants = {
    default: 'bg-tweetBlue text-white hover:brightness-110 disabled:bg-bgCardAlt disabled:text-textSubtle',
    secondary: 'bg-bgCard text-textHeading hover:brightness-110',
    ghost: 'bg-transparent text-textPrimary hover:bg-bgCardAlt',
  } as const
  const sizes = {
    default: 'h-9 px-3 rounded-md text-sm',
    sm: 'h-8 px-2 rounded-md text-sm',
    icon: 'h-9 w-9 rounded-md',
  } as const
  return (
    <button className={clsx(base, variants[variant], sizes[size], className)} {...props} />
  )
}

export default Button

