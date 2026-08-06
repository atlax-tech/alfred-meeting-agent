import { useState } from 'react'
import { MarkdownContent } from './MarkdownContent'

interface TranslationPanelProps {
  translation?: string
  isLoading?: boolean
  compact?: boolean
  contentFontSize?: number
}

/** 原语言回答下方的可折叠中文翻译,供当前回答和历史记录共用。 */
export function TranslationPanel({
  translation = '',
  isLoading = false,
  compact = false,
  contentFontSize
}: TranslationPanelProps) {
  const [expanded, setExpanded] = useState(false)

  if (!translation && !isLoading) return null

  if (compact) {
    return (
      <div className="border-t border-accent/20 pt-2">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="text-accent-glow hover:text-accent"
        >
          {expanded ? '▼ 中文翻译' : '▶ 中文翻译'}
        </button>
        {expanded && (
          <div className="mt-1 border-l border-accent/20 pl-2 text-slate-400 leading-relaxed">
            <MarkdownContent content={translation} compact />
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-accent/30 bg-bg-card shadow-sm">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between px-4 py-3 text-xs text-accent-glow"
      >
        <span className="flex items-center gap-2 font-medium">
          {isLoading && (
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          )}
          {isLoading ? '正在生成中文翻译...' : '中文翻译'}
        </span>
        <span>{expanded ? '收起 ▲' : '展开 ▼'}</span>
      </button>
      {expanded && (
        <div
          className="max-h-[40vh] overflow-y-auto border-t border-accent/20 px-4 py-3 text-slate-200"
          style={{
            fontSize: contentFontSize ? `${contentFontSize}px` : undefined,
            lineHeight: contentFontSize ? 1.75 : undefined
          }}
        >
          {translation ? (
            <MarkdownContent content={translation} compact />
          ) : (
            '翻译生成中...'
          )}
        </div>
      )}
    </div>
  )
}
