import { memo, useDeferredValue } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarkdownContentProps {
  content: string
  className?: string
  compact?: boolean
}

const REMARK_PLUGINS = [remarkGfm]

const MARKDOWN_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => (
    <a {...props} target="_blank" rel="noreferrer noopener" />
  ),
  img: ({ node: _node, ...props }) => (
    <img {...props} loading="lazy" referrerPolicy="no-referrer" />
  )
}

export const MarkdownContent = memo(function MarkdownContent({
  content,
  className = '',
  compact = false
}: MarkdownContentProps) {
  const deferredContent = useDeferredValue(content)

  return (
    <div
      className={`markdown-content min-w-0 break-words ${className}`}
      data-compact={compact || undefined}
    >
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        components={MARKDOWN_COMPONENTS}
        skipHtml
      >
        {deferredContent}
      </ReactMarkdown>
    </div>
  )
})
