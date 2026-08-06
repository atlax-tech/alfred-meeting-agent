/**
 * 历史问答列表(右侧边栏)
 */

import { useState } from 'react'
import { useInterviewStore } from '../store/interview'
import type { MeetingQARecord, QARecord } from '@shared/types'
import { TranslationPanel } from './TranslationPanel'
import { AnswerFeedback } from './AnswerFeedback'
import { MarkdownContent } from './MarkdownContent'
import { AnswerQualityBadge } from './AnswerQualityBadge'
import {
  chatQANoteSourceId,
  meetingQANoteSourceId
} from '../services/meeting-notes'

const MODE_LABEL: Record<string, string> = {
  normal: '普通',
  concise: '精简',
  algorithm: '算法',
  'system-design': '系统设计',
  detailed: '详细'
}

function MeetingQAItem({ qa }: { qa: MeetingQARecord }) {
  const [expanded, setExpanded] = useState(false)
  const selectionIds = useInterviewStore((state) => state.meetingNoteSelectionIds)
  const toggleSelection = useInterviewStore(
    (state) => state.toggleMeetingNoteSelection
  )
  const sourceId = meetingQANoteSourceId(qa.id)
  const selected = selectionIds.includes(sourceId)
  const time = new Date(qa.completedAt).toLocaleTimeString('zh-CN', {
    hour12: false
  })

  return (
    <div className="rounded-md border border-ok/20 bg-bg-card p-2.5 text-xs">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="w-full text-left"
      >
        <div className="mb-1 flex items-center justify-between">
          <span className="text-ok">{time} · QA 环节</span>
          <span className="text-[10px] text-slate-500">
            {expanded ? '收起 ▲' : '展开 ▼'}
          </span>
        </div>
        <div className="leading-5 text-slate-200">
          <span className="text-slate-500">我的提问：</span>{qa.question}
        </div>
      </button>
      {expanded ? (
        <div className="mt-2 space-y-2 border-t border-bg-hover pt-2">
          <div className="whitespace-pre-wrap leading-5 text-slate-300">
            <span className="text-slate-500">发言者：</span>{qa.answer}
          </div>
          <button
            type="button"
            onClick={() => toggleSelection(sourceId)}
            className={`rounded px-2 py-1 text-[10px] ${
              selected
                ? 'bg-ok/15 text-ok'
                : 'bg-accent/10 text-accent-glow hover:bg-accent/20'
            }`}
          >
            {selected ? '✓ 已加入笔记' : '＋ 加入笔记'}
          </button>
        </div>
      ) : null}
    </div>
  )
}

function QAItem({ qa, sessionId }: { qa: QARecord; sessionId: string }) {
  const [expanded, setExpanded] = useState(false)
  const [showReasoning, setShowReasoning] = useState(false)
  const time = new Date(qa.timestamp).toLocaleTimeString('zh-CN', { hour12: false })
  const selectionIds = useInterviewStore((state) => state.meetingNoteSelectionIds)
  const toggleSelection = useInterviewStore(
    (state) => state.toggleMeetingNoteSelection
  )
  const noteSourceId = chatQANoteSourceId(qa.id)

  return (
    <div
      className="bg-bg-card rounded-md p-2.5 text-xs"
      style={{ contentVisibility: 'auto', containIntrinsicSize: '72px' }}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-accent-glow">{time}</span>
        <span className="flex items-center gap-1">
          {qa.detectedLanguage && (
            <span className="px-1.5 py-0.5 rounded bg-accent/10 text-accent-glow">
              {qa.detectedLanguage.name}
            </span>
          )}
          <span className="px-1.5 py-0.5 rounded bg-bg-hover text-slate-400">
            {MODE_LABEL[qa.mode] ?? qa.mode}
          </span>
          <AnswerQualityBadge
            confidence={qa.answerConfidence}
            verified={qa.answerVerified}
            corrected={qa.answerCorrected}
            note={qa.answerQualityNote}
          />
        </span>
      </div>
      <div
        className="text-slate-200 cursor-pointer hover:text-white"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="text-slate-500">Q:</span> {qa.question}
      </div>
      {expanded && (
        <div className="mt-1.5 pt-1.5 border-t border-bg-hover space-y-2">
          {qa.reasoning && (
            <div>
              <button
                onClick={() => setShowReasoning((v) => !v)}
                className="text-warn hover:text-warn/80"
              >
                {showReasoning ? '▼ 思维链' : '▶ 思维链'}
              </button>
              {showReasoning && (
                <div className="mt-1 border-l border-warn/20 pl-2 text-slate-500 leading-relaxed">
                  <MarkdownContent content={qa.reasoning} compact />
                </div>
              )}
            </div>
          )}
          <MarkdownContent className="text-slate-300 leading-relaxed" content={qa.answer} compact />
          <TranslationPanel translation={qa.translation} compact />
          <div className="flex items-center justify-between gap-2">
            <AnswerFeedback qa={qa} sessionId={sessionId} compact />
            <button
              type="button"
              onClick={() => toggleSelection(noteSourceId)}
              className={`shrink-0 rounded px-2 py-1 text-[10px] ${
                selectionIds.includes(noteSourceId)
                  ? 'bg-ok/15 text-ok'
                  : 'bg-accent/10 text-accent-glow hover:bg-accent/20'
              }`}
            >
              {selectionIds.includes(noteSourceId) ? '✓ 已加入笔记' : '＋ 加入笔记'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function HistoryList() {
  const qaHistory = useInterviewStore((s) => s.qaHistory)
  const meetingQAs = useInterviewStore((s) => s.meetingQAs)
  const contextCompressed = useInterviewStore((s) => Boolean(s.contextSummary))
  const sessionId = useInterviewStore((s) => s.sessionId)

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-2.5 border-b border-bg-card bg-bg-panel">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs text-slate-400 font-medium">
            本轮记录 ({qaHistory.length + meetingQAs.length})
          </div>
          {contextCompressed ? (
            <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent-glow">上下文已压缩</span>
          ) : null}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
        {qaHistory.length === 0 && meetingQAs.length === 0 ? (
          <div className="text-center text-xs text-slate-600 py-8">暂无历史问答</div>
        ) : (
          <>
            {meetingQAs.map((qa) => <MeetingQAItem key={qa.id} qa={qa} />)}
            {qaHistory.map((qa) => <QAItem key={qa.id} qa={qa} sessionId={sessionId} />)}
          </>
        )}
      </div>
    </div>
  )
}
