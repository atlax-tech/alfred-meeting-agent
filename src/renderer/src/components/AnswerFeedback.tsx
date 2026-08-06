import { useEffect, useRef, useState } from 'react'
import type {
  FeedbackDimension,
  FeedbackScope,
  QAFeedbackDetail,
  QARecord
} from '@shared/types'
import { useInterviewStore } from '../store/interview'

interface AnswerFeedbackProps {
  qa: QARecord
  sessionId: string
  compact?: boolean
}

const DIMENSION_OPTIONS: Array<{ value: FeedbackDimension; label: string }> = [
  { value: 'thinking', label: '思路不像我' },
  { value: 'speaking', label: '说法不像我' },
  { value: 'accuracy', label: '内容有误' },
  { value: 'length', label: '长短不合适' },
  { value: 'tone', label: '语气不合适' },
  { value: 'example', label: '例子不合适' },
  { value: 'other', label: '其他' }
]

export function AnswerFeedback({ qa, sessionId, compact = false }: AnswerFeedbackProps) {
  const updateQAFeedback = useInterviewStore((state) => state.updateQAFeedback)
  const historyPanelOpen = useInterviewStore((state) => state.historyPanelOpen)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(qa.feedback ?? '')
  const [dimensions, setDimensions] = useState<FeedbackDimension[]>(
    qa.feedbackDetail?.dimensions ?? []
  )
  const [scope, setScope] = useState<FeedbackScope>(
    qa.feedbackDetail?.scope ?? 'general'
  )
  const [approved, setApproved] = useState(
    qa.feedbackDetail?.approved ?? false
  )
  const [preferredAnswer, setPreferredAnswer] = useState(
    qa.feedbackDetail?.preferredAnswer ?? ''
  )
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    setDraft(qa.feedback ?? '')
    setDimensions(qa.feedbackDetail?.dimensions ?? [])
    setScope(qa.feedbackDetail?.scope ?? 'general')
    setApproved(qa.feedbackDetail?.approved ?? false)
    setPreferredAnswer(qa.feedbackDetail?.preferredAnswer ?? '')
    setEditing(false)
  }, [qa.id, qa.feedback, qa.feedbackDetail])

  useEffect(() => {
    if (!editing) return

    let cancelled = false
    let ownsFocusLease = false
    const prepareInput = async () => {
      if (!historyPanelOpen) {
        const acquired = await window.inview.inputFocusAcquire().catch(() => false)
        if (cancelled) {
          if (acquired) window.inview.inputFocusRelease().catch(() => {})
          return
        }
        ownsFocusLease = acquired
      }
      requestAnimationFrame(() => textareaRef.current?.focus())
    }
    void prepareInput()

    return () => {
      cancelled = true
      if (ownsFocusLease) {
        window.inview.inputFocusRelease().catch(() => {})
      }
    }
  }, [editing, historyPanelOpen])

  const save = () => {
    const detail: QAFeedbackDetail = {
      dimensions,
      scope,
      approved,
      preferredAnswer: preferredAnswer.trim() || undefined,
      languageCode:
        qa.answerLanguageCode ?? qa.detectedLanguage?.code ?? undefined
    }
    updateQAFeedback(sessionId, qa.id, draft, detail)
    setEditing(false)
  }

  const toggleDimension = (dimension: FeedbackDimension) => {
    setDimensions((current) =>
      current.includes(dimension)
        ? current.filter((item) => item !== dimension)
        : [...current, dimension]
    )
  }

  const resetDraft = () => {
    setDraft(qa.feedback ?? '')
    setDimensions(qa.feedbackDetail?.dimensions ?? [])
    setScope(qa.feedbackDetail?.scope ?? 'general')
    setApproved(qa.feedbackDetail?.approved ?? false)
    setPreferredAnswer(qa.feedbackDetail?.preferredAnswer ?? '')
    setEditing(false)
  }

  if (editing) {
    return (
      <div className={`rounded-lg border border-accent/30 bg-accent/5 ${compact ? 'p-2' : 'p-3'}`}>
        <label htmlFor={`feedback-${qa.id}`} className="mb-1.5 block text-[11px] text-accent-glow">
          这条回答和你的习惯有什么差距？
        </label>
        <div className="mb-2 flex flex-wrap gap-1">
          {DIMENSION_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => toggleDimension(option.value)}
              className={`rounded border px-2 py-1 text-[10px] transition ${
                dimensions.includes(option.value)
                  ? 'border-accent bg-accent/20 text-accent-glow'
                  : 'border-bg-hover text-slate-500 hover:text-slate-300'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <textarea
          ref={textareaRef}
          id={`feedback-${qa.id}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value.slice(0, 2000))}
          placeholder="例如：例子太泛；先说结论；少用术语；英文句子再短一点"
          rows={compact ? 3 : 4}
          className="w-full resize-none rounded-md border border-bg-hover bg-bg px-2.5 py-2 text-xs leading-5 text-slate-200 outline-none placeholder:text-slate-600 focus:border-accent"
        />
        <label
          htmlFor={`preferred-answer-${qa.id}`}
          className="mb-1 mt-2 block text-[10px] text-slate-500"
        >
          你会怎么回答？亲自改写的证据权重最高（可选）
        </label>
        <textarea
          id={`preferred-answer-${qa.id}`}
          value={preferredAnswer}
          onChange={(event) => setPreferredAnswer(event.target.value.slice(0, 6000))}
          placeholder="不用改得完整，只写出你更自然的说法也可以"
          rows={compact ? 3 : 4}
          className="w-full resize-none rounded-md border border-bg-hover bg-bg px-2.5 py-2 text-xs leading-5 text-slate-200 outline-none placeholder:text-slate-600 focus:border-accent"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setApproved((value) => !value)}
            className={`rounded border px-2 py-1 text-[10px] ${
              approved
                ? 'border-ok/50 bg-ok/10 text-ok'
                : 'border-bg-hover text-slate-500'
            }`}
          >
            {approved ? '✓ 这版已经像我' : '这版已经像我'}
          </button>
          <select
            value={scope}
            onChange={(event) => setScope(event.target.value as FeedbackScope)}
            aria-label="反馈适用范围"
            className="rounded border border-bg-hover bg-bg px-2 py-1 text-[10px] text-slate-400 outline-none"
          >
            <option value="general">作为通用规律</option>
            <option value="similar-situations">只用于相似场景</option>
            <option value="current-language">只用于当前语言</option>
          </select>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[10px] text-slate-600">
            保存后立即生效，并进入持续蒸馏证据账本
          </span>
          <div className="flex shrink-0 gap-1.5">
            <button
              type="button"
              onClick={resetDraft}
              className="rounded px-2 py-1 text-[11px] text-slate-400 hover:bg-bg-hover hover:text-white"
            >
              取消
            </button>
            <button
              type="button"
              onClick={save}
              disabled={
                !draft.trim() &&
                !preferredAnswer.trim() &&
                !approved &&
                dimensions.length === 0 &&
                !qa.feedback &&
                !qa.feedbackDetail
              }
              className="rounded bg-accent px-2.5 py-1 text-[11px] text-white hover:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {qa.feedback || qa.feedbackDetail ? '保存修改' : '保存并应用'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (qa.feedback || qa.feedbackDetail) {
    return (
      <div className={`rounded-lg border border-ok/20 bg-ok/5 ${compact ? 'p-2' : 'p-3'}`}>
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-[11px] text-ok">✓ 已进入持续蒸馏</span>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-[10px] text-slate-500 hover:text-white"
          >
            修改
          </button>
        </div>
        {qa.feedback ? (
          <div className="whitespace-pre-wrap break-words text-xs leading-5 text-slate-400">
            {qa.feedback}
          </div>
        ) : null}
        {qa.feedbackDetail?.dimensions.length ? (
          <div className="mt-1 text-[10px] text-slate-500">
            {qa.feedbackDetail.dimensions
              .map(
                (dimension) =>
                  DIMENSION_OPTIONS.find((item) => item.value === dimension)?.label
              )
              .filter(Boolean)
              .join(' · ')}
          </div>
        ) : null}
        {qa.feedbackDetail?.approved ? (
          <div className="mt-1 text-[10px] text-ok">这版已确认为正向样本</div>
        ) : null}
        {qa.feedbackDetail?.preferredAnswer ? (
          <div className="mt-2 border-l-2 border-accent/30 pl-2 text-xs leading-5 text-slate-400">
            {qa.feedbackDetail.preferredAnswer}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="rounded-md border border-dashed border-bg-hover px-2.5 py-1.5 text-[11px] text-slate-500 transition hover:border-accent/50 hover:bg-accent/5 hover:text-accent-glow"
    >
      ＋ 给这条回答写反馈
    </button>
  )
}
