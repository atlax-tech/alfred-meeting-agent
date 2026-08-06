import { useEffect, useMemo, useState } from 'react'
import type {
  MeetingNoteEntry,
  MeetingNoteSaveResult
} from '@shared/types'
import { useInterviewStore } from '../store/interview'
import {
  chatQANoteSourceId,
  meetingQANoteSourceId,
  transcriptNoteSourceId
} from '../services/meeting-notes'
import { hasSessionPreset } from '../services/session-preset'

interface MeetingNotesPanelProps {
  open: boolean
  onClose: () => void
}

interface NoteCandidate {
  sourceId: string
  entry: MeetingNoteEntry
  label: string
  preview: string
  detail: string
}

function defaultTitle(topic: string, timestamp: number): string {
  const date = new Date(timestamp).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
  return topic.trim() || `${date} 会议记录`
}

function roleLabel(role: MeetingNoteEntry['speaker']): string {
  if (role === 'self') return '我 · 麦克风'
  if (role === 'interviewer') return '发言者 · 系统音频'
  if (role === 'candidate') return '回答者'
  return '未识别说话者'
}

export function MeetingNotesPanel({ open, onClose }: MeetingNotesPanelProps) {
  const sessionId = useInterviewStore((state) => state.sessionId)
  const sessionStartedAt = useInterviewStore((state) => state.sessionStartedAt)
  const preset = useInterviewStore((state) => state.sessionPreset)
  const meetingQAs = useInterviewStore((state) => state.meetingQAs)
  const qaHistory = useInterviewStore((state) => state.qaHistory)
  const dialogHistory = useInterviewStore((state) => state.dialogHistory)
  const selectionIds = useInterviewStore(
    (state) => state.meetingNoteSelectionIds
  )
  const toggleSelection = useInterviewStore(
    (state) => state.toggleMeetingNoteSelection
  )
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<MeetingNoteSaveResult | null>(null)

  const candidates = useMemo<NoteCandidate[]>(() => {
    const meetingItems = meetingQAs.map((qa) => ({
      sourceId: meetingQANoteSourceId(qa.id),
      entry: {
        id: qa.id,
        type: 'qa-session' as const,
        timestamp: qa.completedAt,
        question: qa.question,
        answer: qa.answer,
        preparedQuestionId: qa.preparedQuestionId
      },
      label: 'QA 环节',
      preview: qa.question,
      detail: qa.answer
    }))
    const chatItems = qaHistory.map((qa) => ({
      sourceId: chatQANoteSourceId(qa.id),
      entry: {
        id: qa.id,
        type: 'chat-qa' as const,
        timestamp: qa.timestamp,
        question: qa.question,
        answer: qa.answer
      },
      label: '聊天问答',
      preview: qa.question,
      detail: qa.answer
    }))
    const transcriptItems = [...dialogHistory].reverse().map((turn) => ({
      sourceId: transcriptNoteSourceId(turn.id),
      entry: {
        id: turn.id,
        type: 'transcript' as const,
        timestamp: turn.timestamp,
        content: turn.text,
        speaker: turn.role
      },
      label: '会议转写',
      preview: roleLabel(turn.role),
      detail: turn.text
    }))
    return [...meetingItems, ...chatItems, ...transcriptItems]
  }, [dialogHistory, meetingQAs, qaHistory])

  const selectedEntries = useMemo(() => {
    const selected = new Set(selectionIds)
    return candidates
      .filter((candidate) => selected.has(candidate.sourceId))
      .map((candidate) => candidate.entry)
      .sort((a, b) => a.timestamp - b.timestamp)
  }, [candidates, selectionIds])

  useEffect(() => {
    if (!open) return
    setTitle((current) => current || defaultTitle(preset.topic, sessionStartedAt))
    setError('')
    void window.inview.inputFocusAcquire().catch(() => {})
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      void window.inview.inputFocusRelease().catch(() => {})
    }
  }, [onClose, open, preset.topic, saving, sessionStartedAt])

  useEffect(() => {
    setTitle(defaultTitle(preset.topic, sessionStartedAt))
    setResult(null)
    setError('')
  }, [sessionId, preset.topic, sessionStartedAt])

  if (!open) return null

  const handleSave = async () => {
    if (selectedEntries.length === 0 || saving) return
    setSaving(true)
    setError('')
    setResult(null)
    try {
      const saved = await window.inview.saveMeetingNote({
        title: title.trim() || defaultTitle(preset.topic, sessionStartedAt),
        sessionId,
        sessionStartedAt,
        exportedAt: Date.now(),
        entries: selectedEntries,
        sessionPreset: hasSessionPreset(preset) ? preset : undefined
      })
      setResult(saved)
    } catch (saveError) {
      setError((saveError as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const handleRetryMaintenance = async () => {
    if (!result || saving) return
    setSaving(true)
    setError('')
    try {
      const maintenance = await window.inview.retryMeetingKnowledgeMaintenance(
        result.notePath
      )
      setResult({ ...result, maintenance })
    } catch (maintenanceError) {
      setError((maintenanceError as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex flex-col bg-bg-panel text-slate-100"
      role="dialog"
      aria-modal="true"
      aria-label="会议笔记"
    >
      <header className="bubble-drag flex h-12 shrink-0 items-center justify-between border-b border-bg-card px-4">
        <div>
          <div className="text-sm font-semibold">会议笔记</div>
          <div className="mt-0.5 text-[10px] text-slate-500">
            只落库你勾选的记录 · 已选 {selectedEntries.length} 条
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="bubble-no-drag flex h-7 w-7 items-center justify-center rounded-md text-lg text-slate-400 hover:bg-bg-hover hover:text-white disabled:opacity-40"
          aria-label="关闭会议笔记"
        >
          ×
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <section className="space-y-2">
          <label className="block space-y-1">
            <span className="text-[11px] text-slate-400">落库标题</span>
            <input
              type="text"
              value={title}
              maxLength={120}
              onChange={(event) => setTitle(event.target.value)}
              className="w-full rounded-md border border-bg-hover bg-bg px-3 py-2 text-xs text-slate-200 outline-none focus:border-accent"
            />
          </label>
          <div className="rounded-md border border-bg-hover bg-bg/40 px-3 py-2 text-[10px] leading-4 text-slate-500">
            目标：外置赛博大脑 / 20-工作与项目 / 会议 / 年 / 月 / 日 / 时间戳.md
          </div>
          {hasSessionPreset(preset) ? (
            <div className="rounded-md border border-accent/20 bg-accent/5 px-3 py-2 text-[10px] leading-4 text-accent-glow">
              本轮使用了会前预置。落库时会附带完整主题、背景、我的预置提问、可能问答和参考资料。
            </div>
          ) : null}
        </section>

        <section className="space-y-2" aria-labelledby="note-candidates-title">
          <div className="flex items-center justify-between">
            <h2 id="note-candidates-title" className="text-xs font-medium text-slate-200">
              可加入的会议记录
            </h2>
            <span className="text-[10px] text-slate-600">{candidates.length} 条</span>
          </div>
          {candidates.length === 0 ? (
            <div className="rounded-lg border border-dashed border-bg-hover px-3 py-10 text-center text-xs text-slate-600">
              暂无可记录内容。完成一次 QA，或开始监听会议后再来这里选择。
            </div>
          ) : (
            candidates.map((candidate) => {
              const selected = selectionIds.includes(candidate.sourceId)
              return (
                <label
                  key={candidate.sourceId}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition ${
                    selected
                      ? 'border-accent/50 bg-accent/10'
                      : 'border-bg-hover bg-bg-card hover:bg-bg-hover'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => toggleSelection(candidate.sourceId)}
                    className="mt-1 accent-accent"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-medium text-accent-glow">
                        {candidate.label}
                      </span>
                      <span className="text-[9px] text-slate-600">
                        {new Date(candidate.entry.timestamp).toLocaleTimeString('zh-CN', {
                          hour12: false
                        })}
                      </span>
                    </span>
                    <span className="mt-1 block text-xs font-medium leading-5 text-slate-200">
                      {candidate.preview}
                    </span>
                    <span className="mt-1 block max-h-16 overflow-hidden whitespace-pre-wrap text-[10px] leading-4 text-slate-500">
                      {candidate.detail}
                    </span>
                  </span>
                </label>
              )
            })
          )}
        </section>

        {result ? (
          <section
            className={`rounded-lg border px-3 py-3 text-[10px] leading-4 ${
              result.maintenance.success
                ? 'border-ok/30 bg-ok/5 text-ok'
                : 'border-warn/30 bg-warn/5 text-warn'
            }`}
          >
            <div className="font-medium">
              {result.maintenance.success ? '落库与维护完成' : '内容已落库，维护需要重试'}
            </div>
            <div className="mt-1 break-all text-slate-400">{result.notePath}</div>
            <div className="mt-1">{result.maintenance.message}</div>
            {!result.maintenance.success ? (
              <button
                type="button"
                onClick={() => void handleRetryMaintenance()}
                disabled={saving}
                className="mt-2 rounded bg-warn/15 px-3 py-1.5 text-[11px] text-warn hover:bg-warn/25 disabled:opacity-40"
              >
                重新维护知识库
              </button>
            ) : null}
          </section>
        ) : null}
        {error ? (
          <div className="rounded border border-danger/25 bg-danger/5 px-3 py-2 text-[10px] leading-4 text-danger">
            {error}
          </div>
        ) : null}
      </div>

      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-bg-card bg-bg-panel px-4 py-3">
        <span className="text-[10px] text-slate-600">
          不勾选不落库；落库后自动按知识库规则维护索引与知识图谱。
        </span>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={selectedEntries.length === 0 || saving}
          className="shrink-0 rounded bg-accent px-4 py-1.5 text-xs font-medium text-white hover:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-35"
        >
          {saving ? '正在落库并维护…' : `确认落库（${selectedEntries.length}）`}
        </button>
      </footer>
    </div>
  )
}
