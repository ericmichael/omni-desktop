import 'katex/dist/katex.min.css'

import React from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

type Props = {
  className?: string
  children: string
  highlight?: boolean
  inheritTextColor?: boolean
}

export function Markdown({ className, children, highlight = true, inheritTextColor = false }: Props) {
  const rehypePlugins: any[] = [[rehypeKatex, { strict: false }]]
  if (highlight) {
rehypePlugins.push(rehypeHighlight)
}
  const colorClass = inheritTextColor ? '' : 'text-textPrimary'

  // Convert LaTeX-style math delimiters to KaTeX format
  // \( \) -> $ $ (inline math)
  // \[ \] -> $$ $$ (block math)
  const normalized = React.useMemo(() =>
    children
      .replace(/\\\(/g, '$')
      .replace(/\\\)/g, '$')
      .replace(/\\\[/g, '$$')
      .replace(/\\\]/g, '$$'),
  [children])

  return (
    <div className={['prose prose-invert prose-sm max-w-none', 'prose-p:whitespace-pre-wrap prose-p:break-words', 'prose-code:font-mono prose-pre:bg-bgColumn prose-pre:border prose-pre:border-bgCardAlt', colorClass, className].filter(Boolean).join(' ')}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={rehypePlugins}>
        {normalized}
      </ReactMarkdown>
    </div>
  )
}

export default Markdown
