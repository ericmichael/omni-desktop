import clsx from 'clsx'
import React, { createContext, useContext, useEffect, useRef, useState } from 'react'

type PromptInputContextType = {
  isLoading: boolean
  value: string
  setValue: (value: string) => void
  maxHeight: number | string
  onSubmit?: () => void
  disabled?: boolean
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}

const PromptInputContext = createContext<PromptInputContextType>({
  isLoading: false,
  value: '',
  setValue: () => {},
  maxHeight: 240,
  onSubmit: undefined,
  disabled: false,
  textareaRef: React.createRef<HTMLTextAreaElement>(),
})

function usePromptInput() {
  const context = useContext(PromptInputContext)
  if (!context) {
throw new Error('usePromptInput must be used within a PromptInput')
}
  return context
}

type PromptInputProps = {
  isLoading?: boolean
  value?: string
  onValueChange?: (value: string) => void
  maxHeight?: number | string
  onSubmit?: () => void
  disabled?: boolean
  children: React.ReactNode
  className?: string
}

export function PromptInput({ className, isLoading = false, maxHeight = 240, value, onValueChange, onSubmit, disabled = false, children }: PromptInputProps) {
  const [internalValue, setInternalValue] = useState(value || '')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleChange = (newValue: string) => {
    setInternalValue(newValue)
    onValueChange?.(newValue)
  }

  return (
    <PromptInputContext.Provider
      value={{
        isLoading,
        value: value ?? internalValue,
        setValue: onValueChange ?? handleChange,
        maxHeight,
        onSubmit,
        disabled,
        textareaRef,
      }}
    >
      <div
        className={clsx('relative rounded-[24px] border border-bgCardAlt bg-bgCardAlt p-2 shadow-sm', className)}
        onClick={() => textareaRef.current?.focus()}
      >
        {children}
      </div>
    </PromptInputContext.Provider>
  )
}

export type PromptInputTextareaProps = {
  disableAutosize?: boolean
} & React.TextareaHTMLAttributes<HTMLTextAreaElement>

export function PromptInputTextarea({ className, onKeyDown, disableAutosize = false, ...props }: PromptInputTextareaProps) {
  const { value, setValue, maxHeight, onSubmit, disabled, textareaRef } = usePromptInput()

  useEffect(() => {
    if (disableAutosize) {
return
}
    if (!textareaRef.current) {
return
}
    if (textareaRef.current.scrollTop === 0) {
textareaRef.current.style.height = 'auto'
}
    textareaRef.current.style.height =
      typeof maxHeight === 'number'
        ? `${Math.min(textareaRef.current.scrollHeight, maxHeight)}px`
        : `min(${textareaRef.current.scrollHeight}px, ${maxHeight})`
  }, [value, maxHeight, disableAutosize, textareaRef])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(e)
    if (e.defaultPrevented) {
return
}
    if (
      e.key === 'Enter' &&
      !e.shiftKey &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey
    ) {
      e.preventDefault()
      onSubmit?.()
    }
  }

  return (
    <textarea
      ref={textareaRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={handleKeyDown}
      className={clsx(
        'min-h-[44px] w-full resize-none border-none bg-transparent px-4 py-3 text-base sm:text-sm text-textHeading placeholder:text-textSubtle outline-none focus:ring-0',
        className,
      )}
      rows={1}
      disabled={disabled}
      {...props}
    />
  )
}

type PromptInputActionsProps = React.HTMLAttributes<HTMLDivElement>

export function PromptInputActions({ children, className, ...props }: PromptInputActionsProps) {
  return (
    <div className={clsx('flex items-center gap-2', className)} {...props}>
      {children}
    </div>
  )
}

type PromptInputActionProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  tooltip?: React.ReactNode
}

export function PromptInputAction({ className, tooltip, ...props }: PromptInputActionProps) {
  return (
    <button className={clsx(className)} {...props} />
  )
}
