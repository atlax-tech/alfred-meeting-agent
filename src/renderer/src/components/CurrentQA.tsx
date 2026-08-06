/**
 * Bubble 展开后的紧凑问答区。
 */

import { useEffect, useRef, useState } from 'react'
import { useInterviewStore } from '../store/interview'
import { AnswerFeedback } from './AnswerFeedback'
import { TranslationPanel } from './TranslationPanel'
import { MarkdownContent } from './MarkdownContent'
import { AnswerQualityBadge } from './AnswerQualityBadge'
import { chatQANoteSourceId } from '../services/meeting-notes'

const WORKING_LABEL = {
  extracting: '正在识别问题…',
  answering: '正在准备回答…',
  verifying: '正在独立复核答案…',
  translating: '正在生成翻译…',
  compressing: '正在压缩上下文…'
} as const

export function CurrentQA() {
  const partialText = useInterviewStore((state) => state.partialText)
  const currentQuestion = useInterviewStore((state) => state.currentQuestion)
  const currentAnswer = useInterviewStore((state) => state.currentAnswer)
  const currentAnswerConfidence = useInterviewStore(
    (state) => state.currentAnswerConfidence
  )
  const currentAnswerQualityNote = useInterviewStore(
    (state) => state.currentAnswerQualityNote
  )
  const currentAnswerVerified = useInterviewStore((state) => state.currentAnswerVerified)
  const currentAnswerCorrected = useInterviewStore((state) => state.currentAnswerCorrected)
  const currentTranslation = useInterviewStore((state) => state.currentTranslation)
  const currentDetectedLanguage = useInterviewStore((state) => state.currentDetectedLanguage)
  const currentReasoning = useInterviewStore((state) => state.currentReasoning)
  const isReasoning = useInterviewStore((state) => state.isReasoning)
  const isTranslating = useInterviewStore((state) => state.isTranslating)
  const mixedMode = useInterviewStore((state) => state.config.interview.region === 'mixed')
  const status = useInterviewStore((state) => state.status)
  const errorMessage = useInterviewStore((state) => state.errorMessage)
  const setSettingsOpen = useInterviewStore((state) => state.setSettingsOpen)
  const qaHistory = useInterviewStore((state) => state.qaHistory)
  const sessionId = useInterviewStore((state) => state.sessionId)
  const noteSelectionIds = useInterviewStore(
    (state) => state.meetingNoteSelectionIds
  )
  const toggleNoteSelection = useInterviewStore(
    (state) => state.toggleMeetingNoteSelection
  )
  const questionFontSize = useInterviewStore(
    (state) => state.config.display.questionFontSize
  )
  const answerFontSize = useInterviewStore(
    (state) => state.config.display.answerFontSize
  )

  const answerEndRef = useRef<HTMLSpanElement>(null)
  const [showReasoning, setShowReasoning] = useState(false)

  useEffect(() => {
    answerEndRef.current?.scrollIntoView({ block: 'nearest' })
  }, [currentAnswer, currentTranslation])

  useEffect(() => {
    setShowReasoning(false)
  }, [currentQuestion])

  const completedQA =
    qaHistory[0]?.question === currentQuestion && qaHistory[0]?.answer === currentAnswer
      ? qaHistory[0]
      : null
  const workingLabel =
    status in WORKING_LABEL
      ? WORKING_LABEL[status as keyof typeof WORKING_LABEL]
      : '正在处理…'
  const hasContent =
    currentQuestion ||
    currentAnswer ||
    currentReasoning ||
    currentTranslation ||
    isReasoning
  const completedSourceId = completedQA
    ? chatQANoteSourceId(completedQA.id)
    : ''
  if (
    !hasContent &&
    !partialText &&
    status !== 'error' &&
    !(status in WORKING_LABEL)
  ) {
    return null
  }

  return (
    <section className="space-y-2 p-3" aria-label="当前问答">
      {status === 'error' && errorMessage ? (
        <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5">
          <div className="flex items-start gap-2">
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium text-danger">操作失败</div>
              <div className="mt-1 break-words text-xs leading-5 text-slate-300">
                {errorMessage}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="shrink-0 rounded px-2 py-1 text-[10px] text-slate-400 hover:bg-bg-hover hover:text-white"
            >
              检查设置
            </button>
          </div>
        </div>
      ) : !hasContent ? (
        <div className="flex min-h-14 items-center gap-2 rounded-lg border border-bg-hover bg-bg-card px-3 py-2 text-xs text-slate-400">
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
          <span className="truncate">{partialText || workingLabel}</span>
        </div>
      ) : null}

      {currentQuestion ? (
        <article className="rounded-lg border-l-2 border-accent bg-bg-card px-3 py-2.5">
          <div className="mb-1 text-[10px] font-medium tracking-wide text-accent-glow">
            识别到的问题
          </div>
          <div
            className="break-words font-medium text-slate-50"
            style={{ fontSize: `${questionFontSize}px`, lineHeight: 1.5 }}
          >
            {currentQuestion}
          </div>
        </article>
      ) : null}

      {currentAnswer ? (
        <article className="rounded-lg bg-bg-card px-3 py-2.5">
          <div className="mb-1.5 flex items-center gap-2 text-[10px] font-medium tracking-wide text-slate-400">
            <span>AI 回答</span>
            {mixedMode && currentDetectedLanguage ? (
              <span className="rounded bg-bg-hover px-1.5 py-0.5 text-[9px] text-accent-glow">
                {currentDetectedLanguage.name}
              </span>
            ) : null}
            {status === 'answering' && !isReasoning ? (
              <span className="h-3 w-0.5 animate-pulse bg-accent" />
            ) : null}
            {status === 'verifying' ? (
              <span className="text-[9px] text-amber-300">正在独立复核</span>
            ) : (
              <AnswerQualityBadge
                confidence={currentAnswerConfidence}
                verified={currentAnswerVerified}
                corrected={currentAnswerCorrected}
                note={currentAnswerQualityNote}
              />
            )}
          </div>
          <div
            className="break-words text-slate-100"
            style={{ fontSize: `${answerFontSize}px`, lineHeight: 1.6 }}
          >
            <MarkdownContent content={currentAnswer} />
            <span ref={answerEndRef} />
          </div>
          {currentAnswerQualityNote && currentAnswerConfidence !== 'high' ? (
            <p className="mt-2 border-t border-slate-700/70 pt-2 text-[10px] leading-4 text-amber-200/80">
              可靠性提示：{currentAnswerQualityNote}
            </p>
          ) : null}
        </article>
      ) : null}

      {currentReasoning ? (
        <div className="overflow-hidden rounded-lg border border-warn/25 bg-bg-card">
          <button
            type="button"
            onClick={() => setShowReasoning((value) => !value)}
            aria-expanded={showReasoning}
            className="flex w-full items-center justify-between px-3 py-2 text-[11px] text-warn"
          >
            <span className="flex items-center gap-1.5">
              {isReasoning ? (
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warn" />
              ) : null}
              {isReasoning ? '思考中…' : '思考链'}
            </span>
            <span>{showReasoning ? '收起 ▲' : '展开 ▼'}</span>
          </button>
          {showReasoning ? (
            <div className="max-h-40 overflow-y-auto border-t border-warn/20 px-3 py-2 text-xs leading-relaxed text-slate-400">
              <MarkdownContent content={currentReasoning} compact />
            </div>
          ) : null}
        </div>
      ) : null}

      {isReasoning && !currentReasoning && !currentAnswer ? (
        <div className="flex items-center gap-1.5 px-1 py-2 text-xs text-warn">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warn" />
          正在思考…
        </div>
      ) : null}

      <TranslationPanel
        key={currentQuestion}
        translation={currentTranslation}
        isLoading={isTranslating}
        contentFontSize={answerFontSize}
      />

      {completedQA ? (
        <div className="flex items-center justify-between gap-2">
          <AnswerFeedback qa={completedQA} sessionId={sessionId} compact />
          <button
            type="button"
            onClick={() => toggleNoteSelection(completedSourceId)}
            className={`shrink-0 rounded px-2 py-1 text-[10px] transition ${
              noteSelectionIds.includes(completedSourceId)
                ? 'bg-ok/15 text-ok hover:bg-ok/20'
                : 'bg-accent/10 text-accent-glow hover:bg-accent/20'
            }`}
          >
            {noteSelectionIds.includes(completedSourceId)
              ? '✓ 已加入笔记'
              : '＋ 加入笔记'}
          </button>
        </div>
      ) : null}
    </section>
  )
}
