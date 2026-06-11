import 'katex/dist/katex.min.css'

import React, { useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

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
    <div className={['prose prose-sm max-w-none min-w-0 overflow-hidden break-words', 'prose-p:whitespace-pre-wrap prose-p:break-words prose-li:break-words prose-headings:break-words prose-a:break-words prose-code:break-words', 'prose-code:font-mono prose-pre:bg-bgColumn prose-pre:border prose-pre:border-bgCardAlt prose-pre:overflow-x-auto prose-pre:max-w-full', '[&_a]:[overflow-wrap:anywhere] [&_code]:[overflow-wrap:anywhere] [&_img]:max-w-full [&_svg]:max-w-full', '[&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:whitespace-nowrap [&_.katex-display]:max-w-full [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden', 'text-textPrimary', variantClass, className].filter(Boolean).join(' ')}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { strict: false }], rehypeHighlight]}>
        {normalized}
      </ReactMarkdown>
    </div>
  )
}
