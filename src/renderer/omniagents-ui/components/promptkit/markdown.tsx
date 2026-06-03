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
    <div data-slot="markdown" className={['prose prose-invert prose-sm max-w-none min-w-0 overflow-hidden break-words', 'prose-p:whitespace-pre-wrap prose-p:break-words prose-li:break-words prose-headings:break-words prose-a:break-words prose-code:break-words', 'prose-code:font-mono prose-pre:bg-bgColumn prose-pre:border prose-pre:border-bgCardAlt prose-pre:overflow-x-auto prose-pre:whitespace-pre prose-pre:max-w-full', '[&_a]:[overflow-wrap:anywhere] [&_code]:[overflow-wrap:anywhere] [&_img]:max-w-full [&_svg]:max-w-full', '[&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:whitespace-nowrap [&_.katex-display]:max-w-full [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden', colorClass, className].filter(Boolean).join(' ')}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={rehypePlugins}>
        {normalized}
      </ReactMarkdown>
    </div>
  )
}

export default Markdown
