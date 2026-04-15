import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Input } from './Input'

// @ts-expect-error global flag consumed by React
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // jsdom doesn't implement URL.createObjectURL
  if (!('createObjectURL' in URL)) {
    // @ts-expect-error test shim
    URL.createObjectURL = () => 'blob:stub'
  }
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

function getTextarea(): HTMLTextAreaElement {
  const ta = container.querySelector('textarea')
  if (!ta) {
throw new Error('textarea not found')
}
  return ta as HTMLTextAreaElement
}

describe('Input ArrowDown history', () => {
  it('ArrowDown with no history preserves draft text', () => {
    const onSubmit = vi.fn()
    act(() => {
      root.render(<Input onSubmit={onSubmit} />)
    })
    const ta = getTextarea()

    // Type draft text
    act(() => {
      ta.focus()
      // Use the native setter so React picks up the input event
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(ta, 'hello world')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(ta.value).toBe('hello world')

    // Move caret to end
    ta.selectionStart = ta.value.length
    ta.selectionEnd = ta.value.length

    // Press ArrowDown
    act(() => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })

    expect(getTextarea().value).toBe('hello world')
  })
})
