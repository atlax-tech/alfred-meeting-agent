import type { AnswerConfidence } from '@shared/types'

interface AnswerQualityBadgeProps {
  confidence?: AnswerConfidence
  verified?: boolean
  corrected?: boolean
  note?: string
}

const CONFIDENCE_META: Record<AnswerConfidence, { label: string; className: string }> = {
  high: {
    label: '高置信度',
    className: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300'
  },
  medium: {
    label: '中置信度',
    className: 'border-amber-500/25 bg-amber-500/10 text-amber-200'
  },
  low: {
    label: '低置信度',
    className: 'border-red-500/25 bg-red-500/10 text-red-300'
  },
  unverified: {
    label: '未复核',
    className: 'border-slate-600 bg-slate-800/80 text-slate-400'
  }
}

export function AnswerQualityBadge({
  confidence,
  verified = false,
  corrected = false,
  note
}: AnswerQualityBadgeProps) {
  if (!confidence) return null

  const meta = CONFIDENCE_META[confidence]
  const label = corrected
    ? `已修正 · ${meta.label}`
    : verified
      ? `已复核 · ${meta.label}`
      : meta.label

  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[9px] font-medium normal-case tracking-normal ${meta.className}`}
      title={note || label}
    >
      {label}
    </span>
  )
}
