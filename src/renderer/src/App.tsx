import { useCallback, useEffect, useRef, useState } from 'react'
import type { Region, RunStatus } from '@shared/types'
import { ConversationHistoryPanel } from './components/ConversationHistoryPanel'
import { CurrentQA } from './components/CurrentQA'
import { HistoryList } from './components/HistoryList'
import { MentorOverlay, MentorPanel } from './components/MentorOverlay'
import { MeetingNotesPanel } from './components/MeetingNotesPanel'
import { MeetingQAPanel } from './components/MeetingQAPanel'
import { QuickControlsPanel } from './components/QuickControlsPanel'
import { SessionPresetPanel } from './components/SessionPresetPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { useInterviewStore } from './store/interview'

const isMentorSelectionWindow = window.location.hash === '#mentor'
const BAR_HEIGHT = 40
const MAX_CONTENT_HEIGHT = 660
const MAX_WINDOW_HEIGHT = BAR_HEIGHT + MAX_CONTENT_HEIGHT

const STATUS_META: Record<RunStatus, { label: string; color: string }> = {
  idle: { label: '待机', color: 'bg-slate-500' },
  listening: { label: '监听中', color: 'bg-ok' },
  extracting: { label: '识别问题', color: 'bg-warn' },
  answering: { label: '生成答案', color: 'bg-accent' },
  verifying: { label: '复核答案', color: 'bg-warn' },
  translating: { label: '生成翻译', color: 'bg-warn' },
  compressing: { label: '压缩上下文', color: 'bg-warn' },
  error: { label: '出错了', color: 'bg-danger' }
}

const LANGUAGE_OPTIONS: Array<{ value: Region; label: string }> = [
  { value: 'zh', label: 'zh' },
  { value: 'en', label: 'en' },
  { value: 'mixed', label: 'mixed' }
]

const EXPANDING_STATUSES: RunStatus[] = [
  'extracting',
  'answering',
  'verifying',
  'translating',
  'compressing'
]

if (isMentorSelectionWindow) {
  document.documentElement.style.background = 'transparent'
  document.body.style.background = 'transparent'
}

function MainApp() {
  const loadConfig = useInterviewStore((state) => state.loadConfig)
  const loadPersonalization = useInterviewStore(
    (state) => state.loadPersonalization
  )
  const configLoaded = useInterviewStore((state) => state.configLoaded)
  const apiKey = useInterviewStore((state) => state.config.llm.apiKey)
  const status = useInterviewStore((state) => state.status)
  const listening = useInterviewStore((state) => state.listening)
  const currentAnswer = useInterviewStore((state) => state.currentAnswer)
  const currentReasoning = useInterviewStore((state) => state.currentReasoning)
  const isReasoning = useInterviewStore((state) => state.isReasoning)
  const errorMessage = useInterviewStore((state) => state.errorMessage)
  const answerLanguage = useInterviewStore((state) => state.config.interview.region)
  const settingsOpen = useInterviewStore((state) => state.settingsOpen)
  const historyPanelOpen = useInterviewStore((state) => state.historyPanelOpen)
  const mentorPanelOpen = useInterviewStore((state) => state.mentor.visible)
  const micEnabled = useInterviewStore((state) => state.config.stt.micEnabled)
  const systemEnabled = useInterviewStore((state) => state.config.stt.systemEnabled)
  const micVolume = useInterviewStore((state) => state.micVolume)
  const systemVolume = useInterviewStore((state) => state.systemVolume)
  const qaCount = useInterviewStore((state) => state.qaHistory.length)
  const meetingQACount = useInterviewStore((state) => state.meetingQAs.length)
  const recordCount = qaCount + meetingQACount
  const historyCount = useInterviewStore(
    (state) =>
      state.archivedSessions.length +
      (state.qaHistory.length > 0 || state.meetingQAs.length > 0 || state.sessionFeedback ? 1 : 0)
  )
  const hasSessionPreset = useInterviewStore(
    (state) =>
      Boolean(state.sessionPreset.topic) ||
      Boolean(state.sessionPreset.background) ||
      state.sessionPreset.documents.length > 0 ||
      state.sessionPreset.preparedQuestions.length > 0 ||
      state.sessionPreset.qaPairs.length > 0
  )
  const preparedQuestionCount = useInterviewStore(
    (state) => state.sessionPreset.preparedQuestions.length
  )
  const meetingNoteCount = useInterviewStore(
    (state) => state.meetingNoteSelectionIds.length
  )
  const qaInvitation = useInterviewStore((state) => state.qaInvitation)
  const activeMeetingQA = useInterviewStore((state) => state.activeMeetingQA)
  const visibleMeetingQAId = useInterviewStore(
    (state) => state.visibleMeetingQAId
  )
  const setSettingsOpen = useInterviewStore((state) => state.setSettingsOpen)
  const setHistoryPanelOpen = useInterviewStore((state) => state.setHistoryPanelOpen)
  const setAnswerLanguage = useInterviewStore((state) => state.setAnswerLanguage)
  const startListening = useInterviewStore((state) => state.startListening)
  const stopListening = useInterviewStore((state) => state.stopListening)
  const startNewConversation = useInterviewStore((state) => state.startNewConversation)
  const clearCurrent = useInterviewStore((state) => state.clearCurrent)
  const clearHistory = useInterviewStore((state) => state.clearHistory)
  const showPreparedQuestions = useInterviewStore(
    (state) => state.showPreparedQuestions
  )
  const compressContext = useInterviewStore((state) => state.compressContext)
  const setAudioEnabled = useInterviewStore((state) => state.setAudioEnabled)
  const hasContext = useInterviewStore(
    (state) => state.dialogHistory.length > 0 || state.qaHistory.length > 0
  )
  const [quickControlsOpen, setQuickControlsOpen] = useState(false)
  const [sessionPresetOpen, setSessionPresetOpen] = useState(false)
  const [meetingNotesOpen, setMeetingNotesOpen] = useState(false)

  const contentRef = useRef<HTMLDivElement>(null)
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastWindowHeightRef = useRef<number | null>(null)

  const expanded =
    EXPANDING_STATUSES.includes(status) ||
    Boolean(currentAnswer) ||
    Boolean(currentReasoning) ||
    isReasoning ||
    Boolean(qaInvitation) ||
    Boolean(activeMeetingQA) ||
    Boolean(visibleMeetingQAId) ||
    (status === 'error' && Boolean(errorMessage))
  const panelOpen =
    settingsOpen ||
    historyPanelOpen ||
    quickControlsOpen ||
    sessionPresetOpen ||
    meetingNotesOpen ||
    mentorPanelOpen
  const busy = EXPANDING_STATUSES.includes(status)
  const statusMeta = STATUS_META[status]

  const resizeWindow = useCallback((height: number, immediate = false) => {
    const nextHeight = Math.max(BAR_HEIGHT, Math.min(MAX_WINDOW_HEIGHT, Math.ceil(height)))
    if (resizeTimerRef.current) {
      clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = null
    }

    const commit = () => {
      resizeTimerRef.current = null
      if (lastWindowHeightRef.current === nextHeight) return
      lastWindowHeightRef.current = nextHeight
      void window.inview.resizeWindow({ height: nextHeight, animate: true }).catch(() => {
        lastWindowHeightRef.current = null
      })
    }

    if (immediate) {
      commit()
    } else {
      resizeTimerRef.current = setTimeout(commit, 100)
    }
  }, [])

  const resizeToContent = useCallback(() => {
    if (panelOpen) {
      resizeWindow(MAX_WINDOW_HEIGHT, true)
      return
    }
    if (!expanded) {
      resizeWindow(BAR_HEIGHT, true)
      return
    }

    const contentHeight = contentRef.current?.getBoundingClientRect().height ?? 0
    resizeWindow(BAR_HEIGHT + Math.min(MAX_CONTENT_HEIGHT, contentHeight))
  }, [expanded, panelOpen, resizeWindow])

  useEffect(() => {
    void loadConfig()
    void loadPersonalization()
  }, [loadConfig, loadPersonalization])

  useEffect(() => {
    return window.inview.onToggleListening(() => {
      const state = useInterviewStore.getState()
      if (state.listening) {
        state.stopListening()
      } else {
        void state.startListening()
      }
    })
  }, [])

  useEffect(() => {
    return window.inview.onCopyAnswer(() => {
      const state = useInterviewStore.getState()
      const answer =
        state.mentor.visible && state.mentor.summary
          ? state.mentor.summary
          : state.currentAnswer
      if (answer) void navigator.clipboard.writeText(answer).catch(() => {})
    })
  }, [])

  useEffect(() => {
    return window.inview.onRecheckMentorAnswer(() => {
      void useInterviewStore.getState().recheckMentorAnswer()
    })
  }, [])

  useEffect(() => {
    return window.inview.onToggleMentorPanel(() => {
      void useInterviewStore.getState().toggleMentorPanel()
    })
  }, [])

  useEffect(() => {
    if (configLoaded && !apiKey) setSettingsOpen(true)
  }, [apiKey, configLoaded, setSettingsOpen])

  useEffect(() => {
    resizeToContent()
  }, [resizeToContent])

  useEffect(() => {
    const content = contentRef.current
    if (!content) return

    const observer = new ResizeObserver(() => {
      if (expanded && !panelOpen) resizeToContent()
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [expanded, panelOpen, resizeToContent])

  useEffect(() => {
    return () => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
    }
  }, [])

  const toggleListening = () => {
    if (listening) {
      stopListening()
    } else {
      void startListening()
    }
  }

  const copyAnswer = () => {
    if (currentAnswer) void navigator.clipboard.writeText(currentAnswer).catch(() => {})
  }

  const closeQuickControls = useCallback(() => {
    setQuickControlsOpen(false)
  }, [])

  const openHistoryFromQuickControls = useCallback(() => {
    setHistoryPanelOpen(true)
    setQuickControlsOpen(false)
  }, [setHistoryPanelOpen])

  const openSettingsFromQuickControls = useCallback(() => {
    setSettingsOpen(true)
    setQuickControlsOpen(false)
  }, [setSettingsOpen])

  const openSessionPresetFromQuickControls = useCallback(() => {
    setSessionPresetOpen(true)
    setQuickControlsOpen(false)
  }, [])

  const closeSessionPreset = useCallback(() => {
    setSessionPresetOpen(false)
  }, [])

  return (
    <div
      className={`app-glass relative min-h-[40px] overflow-hidden rounded-xl border border-white/40 bg-bg text-slate-100 ${
        panelOpen ? 'h-screen' : ''
      }`}
    >
      <header className="bubble-drag flex h-10 select-none items-center gap-2 px-3">
        <div className="flex min-w-[104px] shrink-0 items-center gap-2">
          <span
            className={`h-2.5 w-2.5 rounded-full ${statusMeta.color} ${
              status === 'listening' ? 'pulse-ok' : ''
            }`}
          />
          <span className="text-xs font-semibold tracking-wide text-slate-100">AI Mentor</span>
        </div>

        <button
          type="button"
          onClick={() => setSessionPresetOpen(true)}
          className={`bubble-no-drag relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition hover:bg-bg-hover hover:text-white ${
            hasSessionPreset ? 'text-accent-glow' : 'text-slate-400'
          }`}
          title={hasSessionPreset ? '当前会话预设已启用' : '设置当前会话主题、资料和预设问答'}
          aria-label="打开当前会话预设"
          aria-pressed={hasSessionPreset}
        >
          <svg
            viewBox="0 0 24 24"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 5h16v14H4zM8 3v4M16 3v4M7 11h10M7 15h6" />
          </svg>
          {hasSessionPreset ? (
            <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-ok" />
          ) : null}
        </button>

        {preparedQuestionCount > 0 ? (
          <button
            type="button"
            onClick={() => showPreparedQuestions()}
            className="bubble-no-drag relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 transition hover:bg-bg-hover hover:text-accent-glow"
            title={`调出我的预置提问（${preparedQuestionCount}）`}
            aria-label="调出我的预置提问"
          >
            <span className="text-sm font-semibold">?</span>
            <span className="absolute right-0 top-0 rounded-full bg-accent px-1 text-[8px] leading-3 text-white">
              {preparedQuestionCount}
            </span>
          </button>
        ) : null}

        <button
          type="button"
          onClick={() => setMeetingNotesOpen(true)}
          className={`bubble-no-drag relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sm transition hover:bg-bg-hover hover:text-white ${
            meetingNoteCount > 0 ? 'text-ok' : 'text-slate-400'
          }`}
          title={`会议笔记${meetingNoteCount ? `（已选 ${meetingNoteCount}）` : ''}`}
          aria-label="打开会议笔记"
        >
          ◫
          {meetingNoteCount > 0 ? (
            <span className="absolute right-0 top-0 rounded-full bg-ok px-1 text-[8px] leading-3 text-bg">
              {meetingNoteCount}
            </span>
          ) : null}
        </button>

        <button
          type="button"
          onClick={toggleListening}
          className="bubble-no-drag flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs text-slate-300 transition hover:bg-bg-hover hover:text-white"
          title={`${listening ? '停止监听' : '开始监听'}（Command+Shift+L）${errorMessage ? ` · ${errorMessage}` : ''}`}
          aria-label={listening ? '停止监听' : '开始监听'}
        >
          <span aria-hidden="true">{listening ? '■' : '▶'}</span>
          <span className="truncate">{statusMeta.label}</span>
          {listening && micEnabled ? (
            <span
              className="h-1.5 w-4 overflow-hidden rounded-full bg-bg-card"
              title="麦克风音量"
            >
              <span
                className="block h-full bg-accent transition-[width] duration-100"
                style={{ width: `${Math.max(8, micVolume * 100)}%` }}
              />
            </span>
          ) : null}
          {listening && systemEnabled ? (
            <span
              className="h-1.5 w-4 overflow-hidden rounded-full bg-bg-card"
              title="系统声音音量"
            >
              <span
                className="block h-full bg-warn transition-[width] duration-100"
                style={{ width: `${Math.max(8, systemVolume * 100)}%` }}
              />
            </span>
          ) : null}
        </button>

        {listening ? (
          <>
            <button
              type="button"
              onClick={() => void setAudioEnabled('mic', !micEnabled)}
              disabled={busy}
              className={`bubble-no-drag shrink-0 rounded px-1 text-xs transition ${
                micEnabled ? 'text-accent hover:bg-bg-hover' : 'text-slate-600 hover:text-slate-400'
              } disabled:cursor-not-allowed disabled:opacity-35 ${
                busy ? 'hover:bg-transparent' : ''
              }`}
              title={micEnabled ? '麦克风已开启' : '麦克风已静音'}
              aria-label={micEnabled ? '静音麦克风' : '开启麦克风'}
            >
              🎤
            </button>
            <button
              type="button"
              onClick={() => void setAudioEnabled('system', !systemEnabled)}
              disabled={busy}
              className={`bubble-no-drag shrink-0 rounded px-1 text-xs transition ${
                systemEnabled ? 'text-warn hover:bg-bg-hover' : 'text-slate-600 hover:text-slate-400'
              } disabled:cursor-not-allowed disabled:opacity-35`}
              title={systemEnabled ? '系统声音已开启' : '系统声音已关闭'}
              aria-label={systemEnabled ? '关闭系统声音' : '开启系统声音'}
            >
              🔊
            </button>
          </>
        ) : null}

        <div
          className="bubble-no-drag flex shrink-0 items-center rounded-md bg-bg-card p-0.5"
          role="group"
          aria-label="回答语言"
        >
          {LANGUAGE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => void setAnswerLanguage(option.value)}
              aria-pressed={answerLanguage === option.value}
              className={`min-w-7 rounded px-1.5 py-1 text-[10px] leading-none transition ${
                answerLanguage === option.value
                  ? 'bg-accent text-white'
                  : 'text-slate-500 hover:text-slate-100'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setQuickControlsOpen(true)}
          className="bubble-no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 transition hover:bg-bg-hover hover:text-white"
          title="快捷控制"
          aria-label="打开快捷控制"
          aria-expanded={quickControlsOpen}
        >
          <svg
            viewBox="0 0 24 24"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6" />
          </svg>
        </button>

        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="bubble-no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sm text-slate-400 transition hover:bg-bg-hover hover:text-white"
          title="设置"
          aria-label="打开设置"
        >
          ⚙
        </button>
      </header>

      <div
        ref={contentRef}
        aria-hidden={!expanded || mentorPanelOpen}
        className={`border-t border-slate-700/60 bg-transparent transition-[max-height,opacity] duration-200 ease-out ${
          expanded && !mentorPanelOpen
            ? 'max-h-[400px] overflow-y-auto opacity-100'
            : 'pointer-events-none max-h-0 overflow-hidden opacity-0'
        }`}
      >
        <MeetingQAPanel />
        <CurrentQA />

        {recordCount > 0 ? (
          <details className="mx-3 mb-2 overflow-hidden rounded-lg border border-bg-hover bg-bg/40">
            <summary className="bubble-no-drag cursor-pointer px-3 py-2 text-[11px] text-slate-400 hover:text-white">
              本轮记录（{recordCount}）
            </summary>
            <div className="h-48 border-t border-bg-hover">
              <HistoryList />
            </div>
          </details>
        ) : null}

        <div className="sticky bottom-0 flex items-center gap-1 border-t border-bg-hover bg-bg-panel px-3 py-2 backdrop-blur">
          <button
            type="button"
            onClick={copyAnswer}
            disabled={!currentAnswer}
            className="rounded px-2 py-1 text-[11px] text-slate-400 transition hover:bg-bg-hover hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
            title="复制答案（Command+Shift+C）"
          >
            复制
          </button>
          <button
            type="button"
            onClick={startNewConversation}
            disabled={busy}
            className="rounded px-2 py-1 text-[11px] text-slate-400 transition hover:bg-bg-hover hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
            title="保留本轮历史并开始新对话"
          >
            新对话
          </button>
          <button
            type="button"
            onClick={() => void compressContext()}
            disabled={!hasContext || busy}
            className="rounded px-2 py-1 text-[11px] text-slate-400 transition hover:bg-bg-hover hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
            title="将当前上下文压缩为摘要，不删除历史记录"
          >
            压缩
          </button>
          <button
            type="button"
            onClick={() => setHistoryPanelOpen(true)}
            className="rounded px-2 py-1 text-[11px] text-slate-400 transition hover:bg-bg-hover hover:text-white"
            title="查看历史对话与整轮反馈"
          >
            历史{historyCount > 0 ? `(${historyCount})` : ''}
          </button>
          <button
            type="button"
            onClick={() => setHistoryPanelOpen(true)}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-500 transition hover:bg-bg-hover hover:text-accent-glow"
            title="整轮反馈"
            aria-label="打开整轮反馈"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M5 4h14v12H8l-3 3z" />
              <path d="M8 8h8M8 12h5" />
            </svg>
          </button>
          <span className="flex-1" />
          <button
            type="button"
            onClick={clearCurrent}
            className="rounded px-2 py-1 text-[11px] text-slate-500 transition hover:bg-danger/10 hover:text-danger"
            title="清空当前问题和答案"
          >
            清空当前
          </button>
          <button
            type="button"
            onClick={clearHistory}
            className="rounded px-2 py-1 text-[11px] text-slate-500 transition hover:bg-danger/10 hover:text-danger"
            title="清空本轮全部问答与对话记录"
          >
            清空历史
          </button>
        </div>
      </div>

      <QuickControlsPanel
        open={quickControlsOpen}
        onClose={closeQuickControls}
        onOpenHistory={openHistoryFromQuickControls}
        onOpenSettings={openSettingsFromQuickControls}
        onOpenSessionPreset={openSessionPresetFromQuickControls}
      />
      <SessionPresetPanel open={sessionPresetOpen} onClose={closeSessionPreset} />
      <MeetingNotesPanel
        open={meetingNotesOpen}
        onClose={() => setMeetingNotesOpen(false)}
      />
      <ConversationHistoryPanel />
      <SettingsPanel />
      {mentorPanelOpen ? (
        <div className="absolute inset-x-0 bottom-0 top-10">
          <MentorPanel />
        </div>
      ) : null}
    </div>
  )
}

export default function App() {
  if (isMentorSelectionWindow) return <MentorOverlay />
  return <MainApp />
}
