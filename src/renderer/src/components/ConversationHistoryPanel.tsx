import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import type {
  ConversationSession,
  MeetingQARecord,
  QARecord
} from '@shared/types'
import { useInterviewStore } from '../store/interview'
import { TranslationPanel } from './TranslationPanel'
import { QuestionTranslation } from './QuestionTranslation'
import { AnswerFeedback } from './AnswerFeedback'
import { SessionFeedback } from './SessionFeedback'
import { MarkdownContent } from './MarkdownContent'
import { AnswerQualityBadge } from './AnswerQualityBadge'

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

function ReviewItem({ qa, sessionId, defaultOpen }: { qa: QARecord; sessionId: string; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <article
      className="rounded-lg border border-bg-hover bg-bg-card p-3"
      style={{ contentVisibility: 'auto', containIntrinsicSize: '120px' }}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="w-full text-left"
        aria-expanded={open}
      >
        <div className="mb-1 flex items-center justify-between gap-3 text-[10px] text-slate-500">
          <span className="flex items-center gap-1.5">
            {formatDate(qa.timestamp)}
            <AnswerQualityBadge
              confidence={qa.answerConfidence}
              verified={qa.answerVerified}
              corrected={qa.answerCorrected}
              note={qa.answerQualityNote}
            />
          </span>
          <span>{open ? '收起 ▲' : '展开 ▼'}</span>
        </div>
        <div className="text-sm leading-relaxed text-slate-100">{qa.question}</div>
        <QuestionTranslation translation={qa.questionTranslation} compact />
      </button>

      {open ? (
        <div className="mt-3 space-y-2 border-t border-bg-hover pt-3">
          <MarkdownContent className="text-sm leading-7 text-slate-300" content={qa.answer} compact />
          <TranslationPanel translation={qa.translation} compact />
          <AnswerFeedback qa={qa} sessionId={sessionId} compact />
        </div>
      ) : null}
    </article>
  )
}

function ReviewMeetingQAItem({ qa }: { qa: MeetingQARecord }) {
  const [open, setOpen] = useState(false)
  return (
    <article className="rounded-lg border border-ok/20 bg-bg-card p-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="w-full text-left"
        aria-expanded={open}
      >
        <div className="mb-1 flex items-center justify-between gap-3 text-[10px]">
          <span className="text-ok">{formatDate(qa.completedAt)} · QA 环节</span>
          <span className="text-slate-500">{open ? '收起 ▲' : '展开 ▼'}</span>
        </div>
        <div className="text-sm leading-relaxed text-slate-100">{qa.question}</div>
      </button>
      {open ? (
        <div className="mt-3 whitespace-pre-wrap border-t border-bg-hover pt-3 text-sm leading-7 text-slate-300">
          {qa.answer}
        </div>
      ) : null}
    </article>
  )
}

export function ConversationHistoryPanel() {
  const open = useInterviewStore((state) => state.historyPanelOpen)
  const setOpen = useInterviewStore((state) => state.setHistoryPanelOpen)
  const sessionId = useInterviewStore((state) => state.sessionId)
  const sessionStartedAt = useInterviewStore((state) => state.sessionStartedAt)
  const qaHistory = useInterviewStore((state) => state.qaHistory)
  const dialogHistory = useInterviewStore((state) => state.dialogHistory)
  const meetingQAs = useInterviewStore((state) => state.meetingQAs)
  const meetingNoteSelectionIds = useInterviewStore(
    (state) => state.meetingNoteSelectionIds
  )
  const contextSummary = useInterviewStore((state) => state.contextSummary)
  const sessionFeedback = useInterviewStore((state) => state.sessionFeedback)
  const sessionFeedbackUpdatedAt = useInterviewStore((state) => state.sessionFeedbackUpdatedAt)
  const archivedSessions = useInterviewStore((state) => state.archivedSessions)
  const [selectedId, setSelectedId] = useState(sessionId)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase())

  const currentSession = useMemo<ConversationSession>(() => ({
    id: sessionId,
    title: qaHistory[qaHistory.length - 1]?.question.slice(0, 42) || '当前对话',
    startedAt: sessionStartedAt,
    updatedAt: qaHistory[0]?.timestamp ?? sessionStartedAt,
    qaHistory,
    dialogHistory,
    meetingQAs,
    meetingNoteSelectionIds,
    overallFeedback: sessionFeedback || undefined,
    overallFeedbackUpdatedAt: sessionFeedbackUpdatedAt || undefined,
    contextSummary: contextSummary || undefined
  }), [contextSummary, dialogHistory, meetingNoteSelectionIds, meetingQAs, qaHistory, sessionFeedback, sessionFeedbackUpdatedAt, sessionId, sessionStartedAt])

  const sessions = useMemo(
    () => [currentSession, ...archivedSessions].filter(
      (session, index) =>
        index === 0 || session.qaHistory.length > 0 || session.dialogHistory.length > 0 || Boolean(session.meetingQAs?.length) || Boolean(session.overallFeedback)
    ),
    [archivedSessions, currentSession]
  )

  const selected = sessions.find((session) => session.id === selectedId) ?? sessions[0]
  const filteredQA = useMemo(() => {
    if (!selected) return []
    if (!deferredQuery) return selected.qaHistory
    return selected.qaHistory.filter((qa) =>
      `${qa.question}\n${qa.questionTranslation ?? ''}\n${qa.answer}\n${qa.translation ?? ''}\n${qa.feedback ?? ''}`
        .toLocaleLowerCase()
        .includes(deferredQuery)
    )
  }, [deferredQuery, selected])
  const filteredMeetingQAs = useMemo(() => {
    if (!selected) return []
    const records = selected.meetingQAs ?? []
    if (!deferredQuery) return records
    return records.filter((qa) =>
      `${qa.question}\n${qa.answer}`.toLocaleLowerCase().includes(deferredQuery)
    )
  }, [deferredQuery, selected])

  useEffect(() => {
    if (open) setSelectedId(sessionId)
  }, [open, sessionId])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-40 flex bg-black/15 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="历史对话">
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        onClick={() => setOpen(false)}
        aria-label="关闭历史对话"
      />

      <div className="relative ml-auto flex h-full w-[92vw] max-w-4xl flex-col border-l border-bg-card bg-bg-panel shadow-2xl">
        <header className="flex items-center justify-between border-b border-bg-card px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">历史对话</h2>
            <p className="mt-0.5 text-[11px] text-slate-500">记录保存在本机，新对话和压缩上下文都不会删除这里的内容</p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded px-2 py-1 text-lg text-slate-400 hover:bg-bg-hover hover:text-white"
            aria-label="关闭"
          >
            ×
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          <aside className="w-56 shrink-0 overflow-y-auto border-r border-bg-card p-2">
            {sessions.length === 0 ? (
              <div className="px-3 py-8 text-center text-xs text-slate-600">暂无历史对话</div>
            ) : sessions.map((session, index) => (
              <button
                type="button"
                key={session.id}
                onClick={() => setSelectedId(session.id)}
                className={`mb-1 w-full rounded-md px-3 py-2 text-left transition ${
                  selected?.id === session.id ? 'bg-accent/20 text-white' : 'text-slate-400 hover:bg-bg-hover'
                }`}
              >
                <div className="truncate text-xs font-medium">{index === 0 ? '当前 · ' : ''}{session.title}</div>
                <div className="mt-1 flex justify-between text-[10px] text-slate-600">
                  <span>{formatDate(session.startedAt)}</span>
                  <span>{session.qaHistory.length + (session.meetingQAs?.length ?? 0)} 条</span>
                </div>
                {session.overallFeedback ? (
                  <div className="mt-1 text-[10px] text-ok">已有整轮反馈</div>
                ) : null}
              </button>
            ))}
          </aside>

          <section className="flex min-w-0 flex-1 flex-col">
            <div className="border-b border-bg-card px-4 py-3">
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索问题、回答、翻译或单条反馈"
                className="w-full rounded-md border border-bg-hover bg-bg px-3 py-2 text-xs text-slate-200 outline-none focus:border-accent"
              />
              {selected?.contextSummary ? (
                <div className="mt-2 text-[10px] text-accent-glow">本轮已压缩上下文，完整问答仍保留</div>
              ) : null}
            </div>

            <div className="flex-1 space-y-2 overflow-y-auto p-4">
              {selected ? <SessionFeedback session={selected} /> : null}
              {filteredQA.length === 0 && filteredMeetingQAs.length === 0 ? (
                <div className="py-12 text-center text-xs text-slate-600">
                  {deferredQuery ? '没有匹配的历史问答' : '这轮对话还没有问答记录'}
                </div>
              ) : (
                <>
                  {filteredMeetingQAs.map((qa) => (
                    <ReviewMeetingQAItem key={qa.id} qa={qa} />
                  ))}
                  {filteredQA.map((qa, index) => (
                    <ReviewItem
                      key={qa.id}
                      qa={qa}
                      sessionId={selected.id}
                      defaultOpen={index === 0 && filteredQA.length <= 3}
                    />
                  ))}
                </>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
