import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { useInterviewStore } from '@renderer/store/interview'
import { initializeOcr } from '@renderer/services/ocr'
import type { MentorRegionRect } from '@shared/preload-api'
import type { MentorConfig } from '@shared/types'
import { MarkdownContent } from './MarkdownContent'
import { AnswerQualityBadge } from './AnswerQualityBadge'

const MIN_PANEL_WIDTH = 320
const MAX_PANEL_WIDTH = 700

const STATUS_LABELS = {
  idle: '等待截屏',
  input: '等待截屏',
  selecting: '选取区域',
  ocr: 'OCR 识别中',
  collecting: '滚动捕获中',
  stitching: '长截图识别中',
  ai: 'AI 分析中',
  rechecking: '重新核对中',
  verifying: '准确性复核中',
  done: '完成',
  error: '处理失败'
} as const

const INPUT_QUALITY_LABELS = {
  high: '原文质量高',
  medium: '原文质量一般',
  low: '原文质量低'
} as const

interface Point {
  x: number
  y: number
}

interface SelectionStart {
  client: Point
  screen: Point
}

interface ResizeStart {
  screenX: number
  width: number
}

function createSelectionRect(start: Point, current: Point): MentorRegionRect {
  return {
    x: Math.min(start.x, current.x),
    y: Math.min(start.y, current.y),
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y)
  }
}

function clampPanelWidth(width: number): number {
  return Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, Math.round(width)))
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const isSelectionSurface =
  new URLSearchParams(window.location.search).get('mentorSelection') === '1'

export function MentorOverlay() {
  return isSelectionSurface ? <MentorSelectionSurface /> : null
}

function MentorSelectionSurface() {
  const [selection, setSelection] = useState<MentorRegionRect | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const selectionStartRef = useRef<SelectionStart | null>(null)

  const handleMouseDown = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || submitting) return
    selectionStartRef.current = {
      client: { x: Math.round(event.clientX), y: Math.round(event.clientY) },
      screen: { x: Math.round(event.screenX), y: Math.round(event.screenY) }
    }
    setSelection({
      x: Math.round(event.clientX),
      y: Math.round(event.clientY),
      width: 0,
      height: 0
    })
  }

  const handleMouseMove = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const start = selectionStartRef.current
    if (!start || submitting) return
    setSelection(
      createSelectionRect(start.client, {
        x: Math.round(event.clientX),
        y: Math.round(event.clientY)
      })
    )
  }

  const handleMouseUp = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const start = selectionStartRef.current
    selectionStartRef.current = null
    if (!start || submitting) return

    const displayRect = createSelectionRect(start.client, {
      x: Math.round(event.clientX),
      y: Math.round(event.clientY)
    })
    if (displayRect.width === 0 || displayRect.height === 0) {
      setSelection(null)
      return
    }

    setSelection(displayRect)
    setSubmitting(true)
    const screenRect = createSelectionRect(start.screen, {
      x: Math.round(event.screenX),
      y: Math.round(event.screenY)
    })
    void window.inview
      .sendRegionSelected(screenRect)
      .then(() => window.close())
      .catch(() => {
        setSubmitting(false)
        setSelection(null)
      })
  }

  return (
    <div
      className="fixed inset-0 cursor-crosshair select-none bg-transparent"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      role="application"
      aria-label="拖动鼠标选取需要分析的屏幕区域"
    >
      {selection ? (
        <>
          <div
            className="pointer-events-none absolute border-2 border-dashed border-accent bg-accent/10 shadow-[0_0_0_1px_rgba(0,0,0,0.45)]"
            style={{
              left: selection.x,
              top: selection.y,
              width: selection.width,
              height: selection.height
            }}
          />
          <div
            className="pointer-events-none absolute rounded bg-black/85 px-2 py-1 font-mono text-[10px] text-white shadow-lg"
            style={{
              left: Math.min(
                selection.x + selection.width + 6,
                Math.max(6, window.innerWidth - 72)
              ),
              top: Math.min(
                selection.y + selection.height + 6,
                Math.max(6, window.innerHeight - 28)
              )
            }}
          >
            {submitting ? '截取中…' : `${selection.width} × ${selection.height}`}
          </div>
        </>
      ) : null}
    </div>
  )
}

export function MentorPanel() {
  const mentor = useInterviewStore((state) => state.mentor)
  const mentorCapture = useInterviewStore((state) => state.mentorCapture)
  const mentorConfig = useInterviewStore((state) => state.config.mentor)
  const loadConfig = useInterviewStore((state) => state.loadConfig)
  const enterSelectionMode = useInterviewStore((state) => state.startMentorSelection)
  const runMentorCapture = useInterviewStore((state) => state.runMentorCapture)
  const startMentorContinuousSelection = useInterviewStore(
    (state) => state.startMentorContinuousSelection
  )
  const requestMentorContinuousCapture = useInterviewStore(
    (state) => state.requestMentorContinuousCapture
  )
  const finishMentorContinuousCapture = useInterviewStore(
    (state) => state.finishMentorContinuousCapture
  )
  const undoMentorContinuousCapture = useInterviewStore(
    (state) => state.undoMentorContinuousCapture
  )
  const cancelMentorContinuousCapture = useInterviewStore(
    (state) => state.cancelMentorContinuousCapture
  )
  const recheckMentorAnswer = useInterviewStore(
    (state) => state.recheckMentorAnswer
  )
  const setMentorError = useInterviewStore((state) => state.setMentorError)
  const dismissMentor = useInterviewStore((state) => state.dismissMentor)
  const contextAvailable = useInterviewStore(
    (state) => state.qaHistory.length > 0 || state.dialogHistory.length > 0
  )

  const [copied, setCopied] = useState(false)
  const [delayDraft, setDelayDraft] = useState(
    String(mentorConfig.delayedCaptureDelaySeconds)
  )
  const [accessibilityTrusted, setAccessibilityTrusted] = useState<
    boolean | null
  >(null)
  const [requestingAccessibility, setRequestingAccessibility] = useState(false)
  const resizeStartRef = useRef<ResizeStart | null>(null)
  const resizeFrameRef = useRef<number | null>(null)

  useEffect(() => {
    let disposed = false
    const refreshPermission = (): void => {
      void window.inview
        .getMentorAccessibilityPermission()
        .then((trusted) => {
          if (!disposed) setAccessibilityTrusted(trusted)
        })
        .catch(() => {
          if (!disposed) setAccessibilityTrusted(false)
        })
    }
    refreshPermission()
    const interval = window.setInterval(refreshPermission, 2_500)
    return () => {
      disposed = true
      window.clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    const configReady = loadConfig()
    void initializeOcr().catch((error) => {
      console.error('[mentor] OCR Worker 初始化失败:', error)
    })

    const removeCaptureListener = window.inview.onMentorCapture(
      ({ imageBase64, imageWidth, imageHeight, captureMode, captureTarget }) => {
        void configReady.then(() => {
          const state = useInterviewStore.getState()
          if (state.mentorCapture.active) {
            return state.collectMentorFrame(imageBase64, {
              imageWidth,
              imageHeight,
              captureMode,
              captureTarget
            })
          }
          return runMentorCapture(imageBase64, undefined, {
            imageWidth,
            imageHeight,
            captureMode
          })
        })
      }
    )
    const removeSelectionListener = window.inview.onMentorStartSelection(() => {
      enterSelectionMode()
    })
    const removeCaptureErrorListener = window.inview.onMentorCaptureError(
      (message) => {
        setMentorError(`自动截取失败：${message}`)
      }
    )
    const removeDelayedCaptureListener = window.inview.onMentorDelayedCapture(() => {
      const state = useInterviewStore.getState()
      if (state.mentorCapture.active) {
        void state.requestMentorContinuousCapture()
      } else if (
        state.mentor.status !== 'ocr' &&
        state.mentor.status !== 'ai' &&
        state.mentor.status !== 'rechecking' &&
        state.mentor.status !== 'verifying'
      ) {
        void window.inview.captureMentorScreen().catch((error) => {
          state.setMentorError(`自动截取失败：${formatError(error)}`)
        })
      }
    })
    const removeContinuousCaptureListener = window.inview.onMentorContinuousCapture(
      () => {
        void useInterviewStore.getState().requestMentorContinuousCapture()
      }
    )
    const removeContinuousSelectionListener =
      window.inview.onMentorContinuousSelection(() => {
        void useInterviewStore.getState().startMentorContinuousSelection()
      })
    const removeContinuousFinishListener = window.inview.onMentorContinuousFinish(
      () => {
        void useInterviewStore.getState().finishMentorContinuousCapture()
      }
    )
    const removeContinuousUndoListener = window.inview.onMentorContinuousUndo(() => {
      useInterviewStore.getState().undoMentorContinuousCapture()
    })
    const removeContinuousCancelListener = window.inview.onMentorContinuousCancel(
      () => {
        useInterviewStore.getState().cancelMentorContinuousCapture()
      }
    )

    return () => {
      removeCaptureListener()
      removeSelectionListener()
      removeCaptureErrorListener()
      removeDelayedCaptureListener()
      removeContinuousCaptureListener()
      removeContinuousSelectionListener()
      removeContinuousFinishListener()
      removeContinuousUndoListener()
      removeContinuousCancelListener()
    }
  }, [enterSelectionMode, loadConfig, runMentorCapture, setMentorError])

  useEffect(() => {
    setCopied(false)
  }, [mentor.summary])

  useEffect(() => {
    setDelayDraft(String(mentorConfig.delayedCaptureDelaySeconds))
  }, [mentorConfig.delayedCaptureDelaySeconds])

  useEffect(() => {
    const handleResizeMove = (event: MouseEvent): void => {
      const start = resizeStartRef.current
      if (!start) return

      const width = clampPanelWidth(start.width + start.screenX - event.screenX)
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current)
      }
      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null
        void window.inview.resizeWindow({
          width,
          height: window.innerHeight
        })
      })
    }

    const finishResize = (): void => {
      if (!resizeStartRef.current) return
      resizeStartRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    window.addEventListener('mousemove', handleResizeMove)
    window.addEventListener('mouseup', finishResize)
    window.addEventListener('blur', finishResize)
    return () => {
      window.removeEventListener('mousemove', handleResizeMove)
      window.removeEventListener('mouseup', finishResize)
      window.removeEventListener('blur', finishResize)
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current)
      }
    }
  }, [])

  const captureFullScreen = (): void => {
    void window.inview.captureMentorScreen().catch((error) => {
      setMentorError(`全屏截取失败：${formatError(error)}`)
    })
  }

  const requestSelection = (): void => {
    void window.inview.startMentorSelection().catch((error) => {
      setMentorError(`进入选区失败：${formatError(error)}`)
    })
  }

  const requestAccessibilityPermission = (): void => {
    setRequestingAccessibility(true)
    void window.inview
      .requestMentorAccessibilityPermission()
      .then((trusted) => setAccessibilityTrusted(trusted))
      .catch((error) => {
        setMentorError(`辅助功能授权失败：${formatError(error)}`)
      })
      .finally(() => setRequestingAccessibility(false))
  }

  const saveMentorConfig = (partial: Partial<MentorConfig>): void => {
    const state = useInterviewStore.getState()
    const nextConfig = {
      ...state.config,
      mentor: { ...state.config.mentor, ...partial }
    }
    void state.saveConfig(nextConfig).catch((error) => {
      setMentorError(`鼠标静止自动截取设置保存失败：${formatError(error)}`)
    })
  }

  const commitDelay = (): void => {
    const parsed = Number(delayDraft)
    const delaySeconds = Math.max(
      3,
      Math.min(300, Number.isFinite(parsed) ? Math.round(parsed) : 15)
    )
    setDelayDraft(String(delaySeconds))
    if (delaySeconds !== mentorConfig.delayedCaptureDelaySeconds) {
      saveMentorConfig({ delayedCaptureDelaySeconds: delaySeconds })
    }
  }

  const startPanelResize = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return

    event.preventDefault()
    event.stopPropagation()
    resizeStartRef.current = {
      screenX: event.screenX,
      width: window.innerWidth
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  const copySummary = async (): Promise<void> => {
    if (!mentor.summary) return
    try {
      await navigator.clipboard.writeText(mentor.summary)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  const isLoading =
    mentor.status === 'ocr' ||
    mentor.status === 'stitching' ||
    mentor.status === 'ai' ||
    mentor.status === 'rechecking' ||
    mentor.status === 'verifying'
  const latestCaptureFrame =
    mentorCapture.frames[mentorCapture.frames.length - 1]
  const isSelecting = mentor.status === 'selecting'
  const showOcrFallback =
    mentor.status === 'error' &&
    /OCR|识别|屏幕/.test(mentor.error) &&
    (mentor.hasContext || contextAvailable)

  return (
    <section
      className="flex h-full flex-col overflow-hidden text-slate-100"
      aria-label="Mentor 屏幕文字识别与分析面板"
    >
      <div
        className="bubble-no-drag absolute inset-y-0 left-0 z-50 w-[3px] cursor-col-resize bg-slate-700/80 transition-colors hover:bg-accent"
        onMouseDown={startPanelResize}
        role="separator"
        aria-label="拖拽调整 Mentor 面板宽度"
        aria-orientation="vertical"
      />

      <header className="bubble-drag flex h-10 shrink-0 items-center justify-between border-b border-slate-800 px-3 pl-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <svg
            viewBox="0 0 24 24"
            className="h-4 w-4 shrink-0 text-slate-500"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            aria-hidden="true"
          >
            <path d="M5 7h14M5 12h14M5 17h14" strokeLinecap="round" />
          </svg>
          <h1 className="truncate text-sm font-semibold tracking-wide">Mentor</h1>
          <span className="flex items-center gap-1.5 text-[11px] text-slate-500">
            {isLoading ? (
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            ) : null}
            {STATUS_LABELS[mentor.status]}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void dismissMentor()}
          className="bubble-no-drag grid h-7 w-7 place-items-center rounded-md text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
          aria-label="关闭 Mentor"
          title="关闭（Cmd+G）"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      <div className="shrink-0 space-y-2.5 border-b border-slate-800 px-3 py-2.5">
        {isSelecting ? (
          <div className="flex min-w-0 items-center gap-2 text-xs leading-5 text-amber-300">
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-400" />
            <span>
              {mentorCapture.active
                ? '滚动捕获选区 — 拖拽锁定区域后即可滚动，系统会在后台自动取样'
                : '选取区域中 — 请在屏幕上拖拽选择要识别的区域（⌘J）'}
            </span>
          </div>
        ) : mentorCapture.active || mentor.status === 'stitching' ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void requestMentorContinuousCapture()}
                disabled={mentorCapture.processing}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-accent/60 bg-accent/10 px-3 py-2 text-xs font-medium text-accent-glow transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
                title="立即记录当前滚动位置；后台也会自动取样（Control+Command+H）"
              >
                {mentor.status === 'stitching'
                  ? '生成长截图中'
                  : mentorCapture.processing
                    ? '后台采样中'
                    : '立即采样'}
                <kbd className="font-mono text-[10px] text-accent/70">⌃⌘H</kbd>
              </button>
              <button
                type="button"
                onClick={() => void finishMentorContinuousCapture()}
                disabled={
                  mentor.status === 'stitching' ||
                  mentorCapture.frames.length === 0
                }
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-200 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                title="完成连续采集并开始分析（Control+Command+Enter）"
              >
                完成并分析
                <kbd className="font-mono text-[10px] text-emerald-400/70">
                  ⌃⌘↩
                </kbd>
              </button>
            </div>
            <div className="flex items-center justify-between gap-2 text-[10px] text-slate-500">
              <span className="min-w-0 truncate">
                已记录 {mentorCapture.frames.length} 个关键帧
                {mentorCapture.lastStep?.continuityConfirmed &&
                mentorCapture.frames.length > 1
                  ? ` · 图像重叠可信度 ${Math.round(
                      mentorCapture.lastStep.similarity * 100
                    )}%`
                  : ''}
                {latestCaptureFrame &&
                latestCaptureFrame.contentWidth <
                  latestCaptureFrame.width * 0.94
                  ? ` · 滚动区 ${latestCaptureFrame.contentWidth}px`
                  : ''}
                {mentorCapture.warnings.length > 0
                  ? ` · ${mentorCapture.warnings.length} 处待确认`
                  : ''}
              </span>
              <button
                type="button"
                onClick={undoMentorContinuousCapture}
                disabled={
                  mentorCapture.processing || mentorCapture.frames.length === 0
                }
                className="shrink-0 rounded px-1.5 py-1 transition hover:bg-slate-800 hover:text-slate-200 disabled:opacity-35"
                title="撤销上一个关键帧（Control+Command+Backspace）"
              >
                撤销 ⌃⌘⌫
              </button>
              <button
                type="button"
                onClick={cancelMentorContinuousCapture}
                className="shrink-0 rounded px-1.5 py-1 transition hover:bg-red-500/10 hover:text-red-300"
                title="取消连续采集（Control+Command+Escape）"
              >
                取消 ⌃⌘Esc
              </button>
            </div>
            {mentorCapture.progressText ? (
              <p className="text-[10px] leading-4 text-slate-500">
                {mentorCapture.progressText}
              </p>
            ) : null}
            {mentorCapture.captureTarget ? (
              <p
                className="truncate text-[10px] leading-4 text-slate-400"
                title={`${mentorCapture.captureTarget.ownerName} · ${
                  mentorCapture.captureTarget.windowName || '未命名窗口'
                } · ${mentorCapture.captureTarget.bounds.width}×${
                  mentorCapture.captureTarget.bounds.height
                }`}
              >
                已锁定：{mentorCapture.captureTarget.ownerName}
                {mentorCapture.captureTarget.windowName
                  ? ` · ${mentorCapture.captureTarget.windowName}`
                  : ''}
                {` · ${mentorCapture.captureTarget.bounds.width}×${mentorCapture.captureTarget.bounds.height}`}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={captureFullScreen}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-accent hover:bg-slate-800 hover:text-white"
                title="单次全屏截取（Command+H）"
              >
                单次全屏
                <kbd className="font-mono text-[10px] text-slate-600">⌘H</kbd>
              </button>
              <button
                type="button"
                onClick={requestSelection}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-accent hover:bg-slate-800 hover:text-white"
                title="单次选区截取（Command+J）"
              >
                单次选区
                <kbd className="font-mono text-[10px] text-slate-600">⌘J</kbd>
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void requestMentorContinuousCapture()}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-accent/35 bg-accent/5 px-3 py-1.5 text-xs text-accent-glow transition hover:border-accent hover:bg-accent/10"
                title="锁定当前前台窗口并开始滚动捕获（Control+Command+H）"
              >
                当前窗口
                <kbd className="font-mono text-[10px] text-accent/70">⌃⌘H</kbd>
              </button>
              <button
                type="button"
                onClick={() => void startMentorContinuousSelection()}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-accent/35 bg-accent/5 px-3 py-1.5 text-xs text-accent-glow transition hover:border-accent hover:bg-accent/10"
                title="开始固定选区连续采集（Control+Command+J）"
              >
                连续选区
                <kbd className="font-mono text-[10px] text-accent/70">⌃⌘J</kbd>
              </button>
            </div>
            {accessibilityTrusted === false ? (
              <div className="flex items-center justify-between gap-2 rounded-md border border-amber-500/25 bg-amber-500/5 px-2 py-1.5 text-[10px] leading-4 text-amber-200">
                <span className="min-w-0">
                  网页高精度提取需要一次“辅助功能”授权
                </span>
                <button
                  type="button"
                  onClick={requestAccessibilityPermission}
                  disabled={requestingAccessibility}
                  className="shrink-0 rounded border border-amber-400/35 px-2 py-0.5 font-medium transition hover:bg-amber-400/10 disabled:opacity-50"
                >
                  {requestingAccessibility ? '请求中…' : '授权'}
                </button>
              </div>
            ) : null}
          </div>
        )}
        <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/40 px-2.5 py-2">
          <button
            type="button"
            onClick={() =>
              saveMentorConfig({
                delayedCaptureEnabled: !mentorConfig.delayedCaptureEnabled
              })
            }
            className="flex min-w-0 items-center gap-2 text-left"
            aria-pressed={mentorConfig.delayedCaptureEnabled}
            title="鼠标停止操作达到设定时长后，自动执行单次全屏或当前连续采集范围"
          >
            <span
              className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                mentorConfig.delayedCaptureEnabled ? 'bg-accent' : 'bg-slate-700'
              }`}
              aria-hidden="true"
            >
              <span
                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                  mentorConfig.delayedCaptureEnabled
                    ? 'translate-x-[18px]'
                    : 'translate-x-0.5'
                }`}
              />
            </span>
            <span className="min-w-0">
              <span className="block text-xs font-medium text-slate-200">
                鼠标静止自动截取
              </span>
              <span className="block truncate text-[10px] text-slate-500">
                鼠标操作会重置计时，静止后仅触发一次
              </span>
            </span>
          </button>
          <label className="flex shrink-0 items-center gap-1 text-[11px] text-slate-500">
            <input
              type="number"
              min={3}
              max={300}
              step={1}
              value={delayDraft}
              disabled={!mentorConfig.delayedCaptureEnabled}
              onChange={(event) => setDelayDraft(event.target.value)}
              onBlur={commitDelay}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
              }}
              aria-label="鼠标静止自动截取等待秒数"
              className="h-7 w-16 rounded-md border border-slate-700 bg-slate-900 px-2 text-right text-xs text-slate-200 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-40"
            />
            秒
          </label>
        </div>
      </div>

      <div
        className="relative grid min-h-0 flex-1 grid-rows-[minmax(120px,0.72fr)_minmax(190px,1.28fr)] divide-y divide-slate-800"
      >
        <section className="flex min-h-0 flex-col px-3 py-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
              屏幕文字 / OCR 原文
            </h2>
            <span className="flex items-center gap-2 text-[10px]">
              {mentor.ocrConfidence !== undefined ? (
                <span
                  className={
                    mentor.inputQuality === 'low'
                      ? 'text-red-300'
                      : mentor.inputQuality === 'medium'
                        ? 'text-amber-300'
                        : 'text-emerald-400'
                  }
                  title={`OCR 置信度 ${mentor.ocrConfidence.toFixed(0)}%`}
                >
                  {INPUT_QUALITY_LABELS[mentor.inputQuality]}
                </span>
              ) : null}
              {mentor.hasContext ? (
                <span className="text-emerald-400">已注入对话上下文</span>
              ) : null}
              {mentor.programmingLanguage ? (
                <span
                  className="text-sky-300"
                  title="从答题页面的语言选择框读取"
                >
                  代码语言 · {mentor.programmingLanguage}
                </span>
              ) : null}
              {mentorCapture.frames.length > 0 ? (
                <span
                  className={
                    mentorCapture.warnings.length > 0
                      ? 'text-amber-300'
                      : 'text-accent-glow'
                  }
                  title={mentorCapture.warnings.join('\n')}
                >
                  长截图 {mentorCapture.frames.length} 帧
                  {mentorCapture.totalHeight
                    ? ` · ${mentorCapture.totalHeight}px`
                    : ''}
                  {mentorCapture.engine === 'macos-accessibility'
                    ? ' · Accessibility'
                    : mentorCapture.engine === 'apple-vision'
                      ? ' · Vision'
                      : mentorCapture.engine === 'mixed'
                        ? ' · Vision/Tesseract'
                        : ''}
                  {mentorCapture.warnings.length > 0
                    ? ` · ${mentorCapture.warnings.length} 处缺口`
                    : ''}
                </span>
              ) : null}
            </span>
          </div>
          <div
            className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-slate-800 bg-slate-900/55 p-3 text-sm leading-6 text-slate-300"
            aria-live="polite"
          >
            {mentor.ocrText ? (
              mentor.ocrText
            ) : (
              <span className="text-slate-600">
                {mentor.status === 'ocr'
                  ? '正在读取屏幕文字…'
                  : mentor.status === 'stitching'
                    ? mentorCapture.progressText || '正在生成并识别长截图…'
                  : isSelecting
                    ? '拖拽选择后，识别到的文字会显示在这里'
                    : mentor.status === 'collecting'
                      ? '后台正在记录图像关键帧；请正常向下滚动，结束时按 ⌃⌘↩'
                    : '识别到的屏幕文字会显示在这里'}
              </span>
            )}
          </div>
        </section>

        <section className="flex min-h-0 flex-col px-3 py-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
              AI 分析与解答
            </h2>
            {isLoading ? (
              <span className="flex items-center gap-1.5 text-[10px] text-slate-500">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                {mentor.status === 'verifying'
                  ? '独立复核中'
                  : mentor.status === 'rechecking'
                    ? '重新求解并验证样例'
                    : mentor.status === 'stitching'
                      ? '长截图统一识别中'
                      : '候选答案生成中'}
              </span>
            ) : mentor.summary ? (
              <AnswerQualityBadge
                confidence={mentor.answerConfidence}
                verified={mentor.answerVerified}
                corrected={mentor.answerCorrected}
                note={mentor.answerQualityNote}
              />
            ) : null}
          </div>
          <div
            className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-slate-800 bg-slate-900/55 p-3 text-sm leading-6 text-slate-100"
            aria-live="polite"
          >
            {mentor.summary ? (
              <MarkdownContent content={mentor.summary} />
            ) : (
              <span className="text-slate-600">
                {mentor.status === 'ai'
                  ? mentor.hasContext
                    ? '正在结合对话上下文分析…'
                    : '正在分析题目…'
                  : mentor.status === 'stitching'
                    ? '正在拼接长截图并统一提取原文；完成后才会调用 AI'
                  : mentor.status === 'collecting'
                    ? '滚动捕获期间不会调用 OCR 或 AI；到底后按 ⌃⌘↩ 统一处理'
                  : mentor.status === 'rechecking'
                    ? '上一版已标记为错误，正在重新读取题意并验证样例…'
                  : mentor.status === 'verifying'
                    ? '候选答案已生成，正在独立复核关键结论…'
                  : 'AI 解答会在这里流式显示'}
              </span>
            )}

            {mentor.summary &&
            mentor.answerQualityNote &&
            mentor.answerConfidence !== 'high' ? (
              <p className="mt-3 border-t border-slate-800 pt-2 text-xs leading-5 text-amber-200/80">
                可靠性提示：{mentor.answerQualityNote}
              </p>
            ) : null}

            {mentor.reasoning ? (
              <details className="mt-3 border-t border-slate-800 pt-3 text-xs leading-5 text-slate-400">
                <summary className="cursor-pointer select-none text-slate-400 hover:text-slate-200">
                  思考链
                </summary>
                <MarkdownContent className="mt-2" content={mentor.reasoning} compact />
              </details>
            ) : null}
          </div>

          {mentor.error ? (
            <div
              className="mt-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-300"
              role="alert"
            >
              <p>{mentor.error}</p>
              {showOcrFallback ? (
                <p className="mt-1 text-amber-200/80">
                  OCR 未能提供完整文字；请重新截取更清晰的区域，Mentor
                  会保留当前对话上下文。
                </p>
              ) : null}
            </div>
          ) : null}
        </section>

      </div>

      <footer className="flex h-12 shrink-0 items-center justify-between border-t border-slate-800 bg-slate-950/45 px-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void copySummary()}
            disabled={!mentor.summary}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 transition hover:border-accent hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <rect x="8" y="8" width="11" height="11" rx="2" />
              <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
            </svg>
            {copied ? '已复制' : '复制'}
          </button>

          <button
            type="button"
            onClick={() => void recheckMentorAnswer()}
            disabled={!mentor.summary || isLoading}
            className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/35 px-2.5 py-1.5 text-xs text-amber-200 transition hover:border-amber-400 hover:bg-amber-500/10 hover:text-amber-100 disabled:cursor-not-allowed disabled:opacity-35"
            title="标记当前解答有误并重新核对（Cmd+X）"
          >
            解答有误
            <kbd className="font-mono text-[10px] text-amber-400/70">⌘X</kbd>
          </button>
        </div>

        <button
          type="button"
          onClick={() => void dismissMentor()}
          className="rounded-md px-2.5 py-1.5 text-xs text-slate-400 transition hover:bg-slate-800 hover:text-white"
        >
          关闭
        </button>
      </footer>
    </section>
  )
}
