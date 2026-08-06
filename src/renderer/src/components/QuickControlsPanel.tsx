import { useEffect, useState } from 'react'
import { useInterviewStore } from '../store/interview'

interface QuickControlsPanelProps {
  open: boolean
  onClose: () => void
  onOpenHistory: () => void
  onOpenSettings: () => void
  onOpenSessionPreset: () => void
}

type IconName =
  | 'mentor'
  | 'history'
  | 'preset'
  | 'conversation'
  | 'compress'
  | 'copy'
  | 'settings'
  | 'minimize'
  | 'hide'

const BUSY_STATUSES = new Set([
  'extracting',
  'answering',
  'verifying',
  'translating',
  'compressing'
])

export function QuickControlsPanel({
  open,
  onClose,
  onOpenHistory,
  onOpenSettings,
  onOpenSessionPreset
}: QuickControlsPanelProps) {
  const status = useInterviewStore((state) => state.status)
  const listening = useInterviewStore((state) => state.listening)
  const currentAnswer = useInterviewStore((state) => state.currentAnswer)
  const micEnabled = useInterviewStore((state) => state.config.stt.micEnabled)
  const systemEnabled = useInterviewStore((state) => state.config.stt.systemEnabled)
  const micVolume = useInterviewStore((state) => state.config.stt.micVolume)
  const systemVolume = useInterviewStore((state) => state.config.stt.systemVolume)
  const alwaysOnTop = useInterviewStore((state) => state.config.stealth.alwaysOnTop)
  const hasContext = useInterviewStore(
    (state) => state.dialogHistory.length > 0 || state.qaHistory.length > 0
  )
  const hasCurrent = useInterviewStore(
    (state) =>
      Boolean(state.currentQuestion) ||
      Boolean(state.currentAnswer) ||
      Boolean(state.currentReasoning) ||
      Boolean(state.currentTranslation)
  )
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
  const startNewConversation = useInterviewStore((state) => state.startNewConversation)
  const compressContext = useInterviewStore((state) => state.compressContext)
  const clearCurrent = useInterviewStore((state) => state.clearCurrent)
  const clearHistory = useInterviewStore((state) => state.clearHistory)
  const setAudioEnabled = useInterviewStore((state) => state.setAudioEnabled)
  const setAudioVolume = useInterviewStore((state) => state.setAudioVolume)
  const saveConfig = useInterviewStore((state) => state.saveConfig)
  const updateStealth = useInterviewStore((state) => state.updateStealth)
  const toggleMentorPanel = useInterviewStore((state) => state.toggleMentorPanel)
  const [confirmClearHistory, setConfirmClearHistory] = useState(false)

  const busy = BUSY_STATUSES.has(status)

  useEffect(() => {
    if (!open) {
      setConfirmClearHistory(false)
      return
    }

    void window.inview.inputFocusAcquire().catch(() => {})
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      void window.inview.inputFocusRelease().catch(() => {})
    }
  }, [onClose, open])

  if (!open) return null

  const commitAudioConfig = () => {
    void saveConfig(useInterviewStore.getState().config)
  }

  const openMentor = () => {
    onClose()
    void toggleMentorPanel()
  }

  const copyAnswer = () => {
    if (!currentAnswer) return
    void navigator.clipboard.writeText(currentAnswer).catch(() => {})
  }

  return (
    <div
      className="fixed inset-0 z-30 flex flex-col bg-bg-panel text-slate-100"
      role="dialog"
      aria-modal="true"
      aria-label="快捷控制"
    >
      <header className="bubble-drag flex h-10 shrink-0 items-center justify-between border-b border-bg-card px-3">
        <div>
          <div className="text-xs font-semibold">快捷控制</div>
          <div className="text-[9px] text-slate-500">{listening ? '监听中，可实时调整音频' : '待机配置'}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="bubble-no-drag flex h-7 w-7 items-center justify-center rounded-md text-lg text-slate-400 hover:bg-bg-hover hover:text-white"
          aria-label="关闭快捷控制"
        >
          ×
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <section aria-labelledby="quick-actions-title">
          <div
            id="quick-actions-title"
            className="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500"
          >
            功能入口
          </div>
          <div className="grid grid-cols-3 gap-2">
            <ActionButton
              icon="mentor"
              label="Mentor"
              hint="文字 / 截屏分析"
              shortcut="⌘G"
              onClick={openMentor}
            />
            <ActionButton
              icon="history"
              label={`历史${historyCount ? ` · ${historyCount}` : ''}`}
              hint="问答与整轮反馈"
              onClick={onOpenHistory}
            />
            <ActionButton
              icon="preset"
              label={hasSessionPreset ? '会话预设 · 已启用' : '会话预设'}
              hint="主题 / 资料 / 提词"
              onClick={onOpenSessionPreset}
            />
            <ActionButton
              icon="conversation"
              label="新对话"
              hint="归档当前上下文"
              onClick={() => {
                startNewConversation()
                onClose()
              }}
              disabled={busy}
            />
            <ActionButton
              icon="compress"
              label="压缩上下文"
              hint="保留完整历史"
              onClick={() => {
                void compressContext()
                onClose()
              }}
              disabled={!hasContext || busy}
            />
            <ActionButton
              icon="copy"
              label="复制答案"
              hint="复制当前回答"
              shortcut="⇧⌘C"
              onClick={copyAnswer}
              disabled={!currentAnswer}
            />
            <ActionButton
              icon="settings"
              label="完整设置"
              hint="模型与练习参数"
              onClick={onOpenSettings}
            />
          </div>
        </section>

        <section
          className="rounded-lg border border-bg-hover bg-bg/35 p-3"
          aria-labelledby="audio-controls-title"
        >
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div id="audio-controls-title" className="text-xs font-medium text-slate-200">
                音频控制
              </div>
              <div className="mt-0.5 text-[10px] text-slate-500">
                音源切换会自动重启采集，音量实时生效
              </div>
            </div>
            <span
              className={`rounded px-1.5 py-0.5 text-[9px] ${
                listening ? 'bg-ok/10 text-ok' : 'bg-bg-card text-slate-500'
              }`}
            >
              {listening ? '实时' : '下次监听'}
            </span>
          </div>

          <AudioControl
            label="麦克风"
            accent="accent"
            enabled={micEnabled}
            volume={micVolume}
            disabled={busy}
            onEnabledChange={(enabled) => void setAudioEnabled('mic', enabled)}
            onVolumeChange={(volume) => setAudioVolume('mic', volume)}
            onVolumeCommit={commitAudioConfig}
          />
          <AudioControl
            label="系统声音"
            accent="warn"
            enabled={systemEnabled}
            volume={systemVolume}
            disabled={busy}
            onEnabledChange={(enabled) => void setAudioEnabled('system', enabled)}
            onVolumeChange={(volume) => setAudioVolume('system', volume)}
            onVolumeCommit={commitAudioConfig}
          />
        </section>

        <section className="rounded-lg border border-bg-hover bg-bg/35 p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs font-medium text-slate-200">窗口</div>
            <div className="flex items-center gap-2 text-[10px] text-slate-400">
              始终置顶
              <button
                type="button"
                onClick={() => void updateStealth({ alwaysOnTop: !alwaysOnTop })}
                aria-pressed={alwaysOnTop}
                className={`relative h-4 w-7 rounded-full transition ${
                  alwaysOnTop ? 'bg-accent' : 'bg-bg-hover'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition ${
                    alwaysOnTop ? 'left-3.5' : 'left-0.5'
                  }`}
                />
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <ActionButton
              icon="minimize"
              label="最小化"
              hint="收进 Dock"
              compact
              onClick={() => {
                onClose()
                void window.inview.minimizeWindow()
              }}
            />
            <ActionButton
              icon="hide"
              label="隐藏窗口"
              hint="可从托盘恢复"
              compact
              onClick={() => {
                onClose()
                void window.inview.closeWindow()
              }}
            />
          </div>
        </section>

        <section className="flex items-center justify-between gap-2 rounded-lg border border-danger/15 bg-danger/5 px-3 py-2">
          <div>
            <div className="text-[11px] text-slate-300">清理当前内容或全部本地历史</div>
            <div className="text-[9px] text-slate-600">清空全部历史需要二次确认</div>
          </div>
          <div className="flex shrink-0 gap-1">
            <button
              type="button"
              onClick={() => {
                clearCurrent()
                onClose()
              }}
              disabled={!hasCurrent}
              className="rounded px-2 py-1 text-[10px] text-slate-500 hover:bg-bg-hover hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
            >
              清空当前
            </button>
            <button
              type="button"
              onClick={() => {
                if (!confirmClearHistory) {
                  setConfirmClearHistory(true)
                  return
                }
                clearHistory()
                onClose()
              }}
              className="rounded px-2 py-1 text-[10px] text-danger hover:bg-danger/10"
            >
              {confirmClearHistory ? '再次确认' : '清空历史'}
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}

function ActionButton({
  icon,
  label,
  hint,
  shortcut,
  onClick,
  disabled = false,
  compact = false
}: {
  icon: IconName
  label: string
  hint: string
  shortcut?: string
  onClick: () => void
  disabled?: boolean
  compact?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`group flex min-w-0 items-center gap-2 rounded-lg border border-bg-hover bg-bg-card text-left transition hover:border-accent/40 hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-35 ${
        compact ? 'px-2.5 py-2' : 'min-h-[62px] px-2.5 py-2'
      }`}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-bg text-slate-400 group-hover:text-accent-glow">
        <ControlIcon name={icon} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-medium text-slate-200">{label}</span>
        <span className="mt-0.5 block truncate text-[9px] text-slate-600">{hint}</span>
      </span>
      {shortcut ? <kbd className="text-[8px] text-slate-600">{shortcut}</kbd> : null}
    </button>
  )
}

function AudioControl({
  label,
  accent,
  enabled,
  volume,
  disabled,
  onEnabledChange,
  onVolumeChange,
  onVolumeCommit
}: {
  label: string
  accent: 'accent' | 'warn'
  enabled: boolean
  volume: number
  disabled: boolean
  onEnabledChange: (enabled: boolean) => void
  onVolumeChange: (volume: number) => void
  onVolumeCommit: () => void
}) {
  return (
    <div className="mb-2.5 last:mb-0">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => onEnabledChange(!enabled)}
          disabled={disabled}
          aria-pressed={enabled}
          className={`flex items-center gap-2 text-[11px] ${
            enabled ? 'text-slate-200' : 'text-slate-600'
          } disabled:cursor-not-allowed disabled:opacity-40`}
        >
          <span
            className={`relative h-4 w-7 rounded-full transition ${
              enabled ? (accent === 'accent' ? 'bg-accent' : 'bg-warn') : 'bg-bg-hover'
            }`}
          >
            <span
              className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition ${
                enabled ? 'left-3.5' : 'left-0.5'
              }`}
            />
          </span>
          {label}
        </button>
        <span className="text-[10px] tabular-nums text-slate-500">{Math.round(volume * 100)}%</span>
      </div>
      <input
        type="range"
        min="0"
        max="1"
        step="0.05"
        value={volume}
        disabled={!enabled}
        onChange={(event) => onVolumeChange(Number(event.target.value))}
        onPointerUp={onVolumeCommit}
        onKeyUp={onVolumeCommit}
        onBlur={onVolumeCommit}
        aria-label={`${label}音量`}
        className={`w-full disabled:cursor-not-allowed disabled:opacity-30 ${
          accent === 'accent' ? 'accent-accent' : 'accent-warn'
        }`}
      />
    </div>
  )
}

function ControlIcon({ name }: { name: IconName }) {
  const common = {
    viewBox: '0 0 24 24',
    className: 'h-4 w-4',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  }

  switch (name) {
    case 'mentor':
      return (
        <svg {...common}>
          <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
          <path d="m9 15 6-6M10 9h5v5" />
        </svg>
      )
    case 'history':
      return (
        <svg {...common}>
          <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
          <path d="M3 3v5h5M12 7v5l3 2" />
        </svg>
      )
    case 'preset':
      return (
        <svg {...common}>
          <path d="M4 5h16v14H4zM8 3v4M16 3v4M7 11h10M7 15h6" />
        </svg>
      )
    case 'conversation':
      return (
        <svg {...common}>
          <path d="M4 5h16v11H8l-4 4z" />
          <path d="M8 9h8M8 12h5" />
        </svg>
      )
    case 'compress':
      return (
        <svg {...common}>
          <path d="M8 3v5H3M16 3v5h5M8 21v-5H3M16 21v-5h5" />
          <path d="m3 8 5-5M21 8l-5-5M3 16l5 5M21 16l-5 5" />
        </svg>
      )
    case 'copy':
      return (
        <svg {...common}>
          <rect x="8" y="8" width="11" height="11" rx="2" />
          <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
        </svg>
      )
    case 'settings':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
        </svg>
      )
    case 'minimize':
      return (
        <svg {...common}>
          <path d="M5 12h14" />
        </svg>
      )
    case 'hide':
      return (
        <svg {...common}>
          <path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 4.2A10.8 10.8 0 0 1 12 4c5.5 0 9 5 9 5a15 15 0 0 1-2.1 2.7M6.6 6.6C4.3 8 3 10 3 10s3.5 5 9 5c1 0 2-.2 2.8-.5" />
        </svg>
      )
  }
}
