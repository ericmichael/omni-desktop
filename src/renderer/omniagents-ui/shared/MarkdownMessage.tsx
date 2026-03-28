import React, { useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import 'katex/dist/katex.min.css'

type Variant = 'assistant' | 'user' | 'system'

interface Props {
  content: string
  variant?: Variant
  className?: string
}

export function MarkdownMessage({ content, variant = 'assistant', className }: Props) {
  const normalized = useMemo(() =>
    content
      .replace(/\\\(/g, '$')
      .replace(/\\\)/g, '$')
      .replace(/\\\[/g, '$$')
      .replace(/\\\]/g, '$$'),
  [content])

  const variantClass = variant === 'user'
    ? 'prose-invert'
    : variant === 'system'
      ? 'prose-invert'
      : 'prose-invert'

  return (
    <div className={['prose prose-sm max-w-none', 'prose-p:whitespace-pre-wrap prose-p:break-words', 'prose-code:font-mono prose-pre:bg-bgColumn prose-pre:border prose-pre:border-bgCardAlt', 'text-textPrimary', variantClass, className].filter(Boolean).join(' ')}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { strict: false }], rehypeHighlight]}>
        {normalized}
      </ReactMarkdown>
    </div>
  )
}
