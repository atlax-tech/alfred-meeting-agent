interface QuestionTranslationProps {
  translation?: string
  isLoading?: boolean
  compact?: boolean
  contentFontSize?: number
}

/** 非中文问题下方的中文题意，当前问答与历史记录共用。 */
export function QuestionTranslation({
  translation = '',
  isLoading = false,
  compact = false,
  contentFontSize
}: QuestionTranslationProps) {
  if (!translation && !isLoading) return null

  return (
    <div className={`${compact ? 'mt-2' : 'mt-2.5'} border-t border-accent/20 pt-2`}>
      <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium tracking-wide text-accent-glow">
        {isLoading ? (
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
        ) : null}
        <span>{isLoading ? '正在翻译问题…' : '问题中文翻译'}</span>
      </div>
      <div
        className="break-words text-slate-300"
        style={{
          fontSize: contentFontSize ? `${contentFontSize}px` : undefined,
          lineHeight: contentFontSize ? 1.5 : undefined
        }}
      >
        {translation || '翻译生成中…'}
      </div>
    </div>
  )
}
