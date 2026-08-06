/**
 * 屏幕文字识别助手
 * 负责主窗口内 Mentor 面板的快捷键、选区覆盖层与 macOS 截屏，
 * OCR/AI 由主窗口渲染进程完成。
 */

import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  screen,
  systemPreferences
} from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { MentorConfig } from '@shared/types'
import { IPC } from './ipc-channels'
import { loadConfig } from './config'
import { getMainWindow, updateStealth } from './window'
import type {
  MentorAccessibilityTextOptions,
  MentorAccessibilityTextResult,
  MentorCapturePayload,
  MentorCaptureTarget,
  VisionOcrResult
} from '@shared/preload-api'

const MENTOR_SHORTCUT = 'Command+G'
const FULL_SCREEN_CAPTURE_SHORTCUT = 'Command+H'
const REGION_CAPTURE_SHORTCUT = 'Command+J'
const TOGGLE_LISTENING_SHORTCUT = 'Command+Shift+L'
const COPY_ANSWER_SHORTCUT = 'Command+Shift+C'
const RECHECK_ANSWER_SHORTCUT = 'Command+X'
const DISMISS_MENTOR_SHORTCUT = 'Escape'
const CONTINUOUS_CAPTURE_SHORTCUT = 'Command+Control+H'
const CONTINUOUS_SELECTION_SHORTCUT = 'Command+Control+J'
const CONTINUOUS_FINISH_SHORTCUT = 'Command+Control+Enter'
const CONTINUOUS_UNDO_SHORTCUT = 'Command+Control+Backspace'
const CONTINUOUS_CANCEL_SHORTCUT = 'Command+Control+Escape'

let mentorSelectionWindow: BrowserWindow | null = null
let lastMentorRegion: MentorRegionRect | null = null
let lastMentorWindowTarget: FrontmostWindowResult | null = null
let captureInProgress = false
let mentorModeActive = false
let delayedCaptureConfig: MentorConfig = {
  delayedCaptureEnabled: false,
  delayedCaptureDelaySeconds: 15
}
let mouseIdleMonitor: ChildProcess | null = null
let monitorRestartTimer: NodeJS.Timeout | null = null
let lastMouseActivityToken: string | null = null
let lastMouseSnapshotAt = 0
let mouseStoppedAt = 0
let delayedCaptureTriggered = false

export function enforceMentorNonFocus(): boolean {
  if (!mentorModeActive) return false
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.setFocusable(false)
  }
  return true
}

interface MentorRegionRect {
  x: number
  y: number
  width: number
  height: number
}

interface MentorCaptureImage {
  png: Buffer
  width: number
  height: number
}

interface FrontmostWindowResult extends MentorRegionRect {
  windowId: number
  ownerName: string
  windowName: string
  processId: number
}

interface MouseIdleSnapshot {
  mouseCounters: number[]
  cursorX: number
  cursorY: number
}

function normalizeDelayedCaptureConfig(config: MentorConfig): MentorConfig {
  const rawDelay = Number(config.delayedCaptureDelaySeconds)
  return {
    delayedCaptureEnabled: Boolean(config.delayedCaptureEnabled),
    delayedCaptureDelaySeconds: Math.max(
      3,
      Math.min(300, Number.isFinite(rawDelay) ? Math.round(rawDelay) : 15)
    )
  }
}

function resetMouseIdleCycle(): void {
  mouseStoppedAt = Date.now()
  delayedCaptureTriggered = false
}

function sendDelayedCaptureError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.MENTOR_CAPTURE_ERROR, message)
  }
}

function triggerDelayedCapture(): void {
  if (
    !mentorModeActive ||
    !delayedCaptureConfig.delayedCaptureEnabled ||
    delayedCaptureTriggered
  ) {
    return
  }

  if (captureInProgress) return

  delayedCaptureTriggered = true
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  win.webContents.send(IPC.MENTOR_DELAYED_CAPTURE)
}

function handleMouseIdleSnapshot(snapshot: MouseIdleSnapshot): void {
  if (
    !Array.isArray(snapshot.mouseCounters) ||
    snapshot.mouseCounters.length === 0 ||
    snapshot.mouseCounters.some(
      (counter) => !Number.isInteger(counter) || counter < 0
    ) ||
    !Number.isFinite(snapshot.cursorX) ||
    !Number.isFinite(snapshot.cursorY)
  ) {
    return
  }

  const now = Date.now()
  if (lastMouseSnapshotAt > 0 && now - lastMouseSnapshotAt > 1500) {
    // 系统休眠或主进程长时间暂停后重新开始计时，避免唤醒即截屏。
    resetMouseIdleCycle()
  }
  lastMouseSnapshotAt = now

  const activityToken = [
    ...snapshot.mouseCounters,
    Math.round(snapshot.cursorX),
    Math.round(snapshot.cursorY)
  ].join(':')
  if (lastMouseActivityToken === null) {
    lastMouseActivityToken = activityToken
    resetMouseIdleCycle()
    return
  }
  if (activityToken !== lastMouseActivityToken) {
    // 任一鼠标事件计数变化，都从最后一次操作重新开始计时。
    lastMouseActivityToken = activityToken
    resetMouseIdleCycle()
    return
  }

  const idleMs = Date.now() - mouseStoppedAt
  if (idleMs < delayedCaptureConfig.delayedCaptureDelaySeconds * 1000) return

  triggerDelayedCapture()
}

function getMouseIdleHelperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'native', 'mouse-idle')
    : join(app.getAppPath(), 'build', 'native', 'mouse-idle')
}

function getVisionOcrHelperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'native', 'vision-ocr')
    : join(app.getAppPath(), 'build', 'native', 'vision-ocr')
}

function parseImageBase64(imageBase64: string): Buffer {
  const normalized = imageBase64.replace(/^data:image\/[a-z0-9.+-]+;base64,/iu, '')
  if (!normalized.trim()) {
    throw new Error('OCR 图像数据为空')
  }
  const image = Buffer.from(normalized, 'base64')
  if (image.length === 0) {
    throw new Error('OCR 图像数据无效')
  }
  if (image.length > 40 * 1024 * 1024) {
    throw new Error('OCR 图像超过 40MB，请缩小选区或缩短滚动内容')
  }
  return image
}

export function recognizeImageWithVision(
  imageBase64: string
): Promise<VisionOcrResult> {
  const helperPath = getVisionOcrHelperPath()
  if (!existsSync(helperPath)) {
    return Promise.reject(new Error(`Vision OCR 组件不存在：${helperPath}`))
  }
  const image = parseImageBase64(imageBase64)

  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (
      error?: Error,
      result?: VisionOcrResult
    ): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else if (result) resolve(result)
      else reject(new Error('Vision OCR 未返回结果'))
    }
    const timeout = setTimeout(() => {
      child.kill()
      finish(new Error('Vision OCR 超时'))
    }, 30_000)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      finish(new Error(`Vision OCR 启动失败：${error.message}`))
    })
    child.on('close', (code) => {
      if (code !== 0) {
        finish(new Error(stderr.trim() || `Vision OCR 异常退出：${code}`))
        return
      }
      try {
        const parsed = JSON.parse(stdout) as VisionOcrResult
        if (
          typeof parsed.text !== 'string' ||
          !Number.isFinite(parsed.confidence) ||
          !Array.isArray(parsed.lines) ||
          parsed.engine !== 'apple-vision'
        ) {
          throw new Error('返回结构无效')
        }
        finish(undefined, parsed)
      } catch (error) {
        finish(new Error(`Vision OCR 结果解析失败：${(error as Error).message}`))
      }
    })
    child.stdin?.on('error', (error) => {
      finish(new Error(`Vision OCR 图像写入失败：${error.message}`))
    })
    child.stdin?.end(image)
  })
}

export function extractLockedWindowAccessibilityText(
  options: MentorAccessibilityTextOptions = {}
): Promise<MentorAccessibilityTextResult> {
  const target = lastMentorWindowTarget
  if (!target) {
    return Promise.reject(new Error('尚未锁定可读取的目标窗口'))
  }
  const helperPath = getVisionOcrHelperPath()
  if (!existsSync(helperPath)) {
    return Promise.reject(new Error(`Accessibility 组件不存在：${helperPath}`))
  }
  const contentStartRatio = Math.max(
    0,
    Math.min(1, options.contentStartRatio ?? 0)
  )
  const contentEndRatio = Math.max(
    contentStartRatio,
    Math.min(1, options.contentEndRatio ?? 1)
  )
  const encodedTitle = Buffer.from(target.windowName, 'utf8').toString('base64')

  return new Promise((resolve, reject) => {
    const child = spawn(
      helperPath,
      [
        '--accessibility-text',
        `--pid=${target.processId}`,
        `--window-title-base64=${encodedTitle}`,
        `--content-start=${contentStartRatio}`,
        `--content-end=${contentEndRatio}`
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (
      error?: Error,
      result?: MentorAccessibilityTextResult
    ): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else if (result) resolve(result)
      else reject(new Error('Accessibility 未返回文本'))
    }
    const timeout = setTimeout(() => {
      child.kill()
      finish(new Error('Accessibility 文本读取超时'))
    }, 8_000)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      finish(new Error(`Accessibility 组件启动失败：${error.message}`))
    })
    child.on('close', (code) => {
      if (code !== 0) {
        finish(
          new Error(
            stderr.trim() || `Accessibility 文本读取异常退出：${code}`
          )
        )
        return
      }
      try {
        const parsed = JSON.parse(stdout) as MentorAccessibilityTextResult
        if (
          typeof parsed.text !== 'string' ||
          !Number.isFinite(parsed.lineCount) ||
          !Number.isFinite(parsed.nodeCount) ||
          typeof parsed.truncated !== 'boolean' ||
          (
            parsed.programmingLanguage !== undefined &&
            typeof parsed.programmingLanguage !== 'string'
          ) ||
          parsed.engine !== 'macos-accessibility'
        ) {
          throw new Error('返回结构无效')
        }
        finish(undefined, parsed)
      } catch (error) {
        finish(
          new Error(
            `Accessibility 结果解析失败：${(error as Error).message}`
          )
        )
      }
    })
  })
}

function resolveFrontmostWindow(): Promise<FrontmostWindowResult> {
  const helperPath = getVisionOcrHelperPath()
  if (!existsSync(helperPath)) {
    return Promise.reject(new Error(`窗口定位组件不存在：${helperPath}`))
  }

  return new Promise((resolve, reject) => {
    const child = spawn(
      helperPath,
      ['--frontmost-window', `--exclude-pid=${process.pid}`],
      {
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (
      error?: Error,
      result?: FrontmostWindowResult
    ): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else if (result) resolve(result)
      else reject(new Error('窗口定位组件未返回结果'))
    }
    const timeout = setTimeout(() => {
      child.kill()
      finish(new Error('获取前台窗口位置超时'))
    }, 5_000)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      finish(new Error(`窗口定位组件启动失败：${error.message}`))
    })
    child.on('close', (code) => {
      if (code !== 0) {
        finish(new Error(stderr.trim() || `窗口定位组件异常退出：${code}`))
        return
      }
      try {
        const parsed = JSON.parse(stdout) as FrontmostWindowResult
        const normalized = normalizeRegionRect(parsed)
        if (
          !Number.isInteger(parsed.windowId) ||
          typeof parsed.ownerName !== 'string' ||
          typeof parsed.windowName !== 'string' ||
          !Number.isInteger(parsed.processId)
        ) {
          throw new Error('返回结构无效')
        }
        finish(undefined, {
          ...normalized,
          windowId: parsed.windowId,
          ownerName: parsed.ownerName,
          windowName: parsed.windowName,
          processId: parsed.processId
        })
      } catch (error) {
        finish(new Error(`窗口定位结果解析失败：${(error as Error).message}`))
      }
    })
  })
}

function scheduleMonitorRestart(): void {
  if (
    monitorRestartTimer ||
    !mentorModeActive ||
    !delayedCaptureConfig.delayedCaptureEnabled
  ) {
    return
  }

  monitorRestartTimer = setTimeout(() => {
    monitorRestartTimer = null
    startMouseIdleMonitor()
  }, 1000)
}

function startMouseIdleMonitor(): void {
  if (
    process.platform !== 'darwin' ||
    mouseIdleMonitor ||
    !mentorModeActive ||
    !delayedCaptureConfig.delayedCaptureEnabled
  ) {
    return
  }

  const helperPath = getMouseIdleHelperPath()
  if (!existsSync(helperPath)) {
    const error = new Error(`鼠标静止监测组件不存在：${helperPath}`)
    console.error('[mentor]', error.message)
    sendDelayedCaptureError(error)
    return
  }

  const monitor = spawn(helperPath, ['--watch'], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  mouseIdleMonitor = monitor
  lastMouseActivityToken = null
  lastMouseSnapshotAt = 0
  resetMouseIdleCycle()
  let outputBuffer = ''

  monitor.stdout?.setEncoding('utf8')
  monitor.stdout?.on('data', (chunk: string) => {
    outputBuffer += chunk
    const lines = outputBuffer.split('\n')
    outputBuffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        handleMouseIdleSnapshot(JSON.parse(line) as MouseIdleSnapshot)
      } catch (error) {
        console.warn('[mentor] 忽略无效的鼠标静止信息:', error)
      }
    }
  })
  monitor.stderr?.setEncoding('utf8')
  monitor.stderr?.on('data', (chunk: string) => {
    const message = chunk.trim()
    if (message) console.warn('[mentor] 鼠标静止监测组件:', message)
  })
  monitor.on('error', (error) => {
    console.error('[mentor] 鼠标静止监测组件启动失败:', error)
    sendDelayedCaptureError(error)
  })
  monitor.on('close', (code, signal) => {
    if (mouseIdleMonitor !== monitor) return
    mouseIdleMonitor = null
    lastMouseActivityToken = null
    lastMouseSnapshotAt = 0
    mouseStoppedAt = 0
    delayedCaptureTriggered = false
    if (code !== 0 && signal !== 'SIGTERM') {
      console.warn(`[mentor] 鼠标静止监测组件退出: code=${code}, signal=${signal}`)
    }
    scheduleMonitorRestart()
  })
}

function stopMouseIdleMonitor(): void {
  if (monitorRestartTimer) {
    clearTimeout(monitorRestartTimer)
    monitorRestartTimer = null
  }
  lastMouseActivityToken = null
  lastMouseSnapshotAt = 0
  mouseStoppedAt = 0
  delayedCaptureTriggered = false
  const monitor = mouseIdleMonitor
  mouseIdleMonitor = null
  if (monitor && !monitor.killed) {
    monitor.kill()
  }
}

export function updateMentorDelayedCapture(config: MentorConfig): void {
  delayedCaptureConfig = normalizeDelayedCaptureConfig(config)
  if (!mentorModeActive || !delayedCaptureConfig.delayedCaptureEnabled) {
    stopMouseIdleMonitor()
    return
  }

  if (!mouseIdleMonitor) {
    startMouseIdleMonitor()
  } else {
    // 修改等待时长后从当前时刻重新开始一轮静止计时。
    resetMouseIdleCycle()
  }
}

function normalizeRegionRect(rect: MentorRegionRect): MentorRegionRect {
  const values = [rect.x, rect.y, rect.width, rect.height]
  if (!values.every(Number.isFinite)) {
    throw new Error('选区坐标无效')
  }

  const normalized = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  }
  if (normalized.width <= 0 || normalized.height <= 0) {
    throw new Error('选区尺寸必须大于 0')
  }
  return normalized
}

async function capturePrimaryDisplay(rect?: MentorRegionRect): Promise<MentorCaptureImage> {
  const display = screen.getPrimaryDisplay()
  const bounds = display.bounds
  const scaleFactor = Math.max(1, display.scaleFactor)
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(bounds.width * scaleFactor),
      height: Math.round(bounds.height * scaleFactor)
    }
  })
  const source =
    sources.find((item) => item.display_id === String(display.id)) ?? sources[0]

  if (!source || source.thumbnail.isEmpty()) {
    const permission =
      process.platform === 'darwin'
        ? systemPreferences.getMediaAccessStatus('screen')
        : 'unknown'
    if (permission !== 'granted') {
      throw new Error(
        '需要屏幕录制权限。请在“系统设置 → 隐私与安全性 → 录屏与系统录音”中允许 InviewPractice，然后重启应用。'
      )
    }
    throw new Error('未能读取主显示器图像，请重试。')
  }

  if (!rect) {
    const imageSize = source.thumbnail.getSize()
    return {
      png: source.thumbnail.toPNG(),
      width: imageSize.width,
      height: imageSize.height
    }
  }

  const left = Math.max(bounds.x, rect.x)
  const top = Math.max(bounds.y, rect.y)
  const right = Math.min(bounds.x + bounds.width, rect.x + rect.width)
  const bottom = Math.min(bounds.y + bounds.height, rect.y + rect.height)
  if (right <= left || bottom <= top) {
    throw new Error('选区不在主显示器范围内')
  }

  const imageSize = source.thumbnail.getSize()
  const scaleX = imageSize.width / bounds.width
  const scaleY = imageSize.height / bounds.height
  const x = Math.max(0, Math.round((left - bounds.x) * scaleX))
  const y = Math.max(0, Math.round((top - bounds.y) * scaleY))
  const width = Math.min(
    imageSize.width - x,
    Math.max(1, Math.round((right - left) * scaleX))
  )
  const height = Math.min(
    imageSize.height - y,
    Math.max(1, Math.round((bottom - top) * scaleY))
  )

  const cropped = source.thumbnail.crop({ x, y, width, height })
  const croppedSize = cropped.getSize()
  return {
    png: cropped.toPNG(),
    width: croppedSize.width,
    height: croppedSize.height
  }
}

async function captureWindowById(
  target: FrontmostWindowResult
): Promise<MentorCaptureImage> {
  const display = screen.getDisplayMatching(target)
  const scaleFactor = Math.max(1, display.scaleFactor)
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: {
      width: Math.max(1, Math.round(target.width * scaleFactor)),
      height: Math.max(1, Math.round(target.height * scaleFactor))
    },
    fetchWindowIcons: false
  })
  const source = sources.find((item) => {
    const [kind, id] = item.id.split(':')
    return kind === 'window' && Number(id) === target.windowId
  })
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error(
      `已锁定的窗口不可读取或已经关闭：${target.ownerName} ${target.windowName}`.trim()
    )
  }
  const size = source.thumbnail.getSize()
  return {
    png: source.thumbnail.toPNG(),
    width: size.width,
    height: size.height
  }
}

function unregisterMentorModeShortcuts(): void {
  mentorModeActive = false
  stopMouseIdleMonitor()
  globalShortcut.unregister(FULL_SCREEN_CAPTURE_SHORTCUT)
  globalShortcut.unregister(REGION_CAPTURE_SHORTCUT)
  globalShortcut.unregister(RECHECK_ANSWER_SHORTCUT)
  globalShortcut.unregister(DISMISS_MENTOR_SHORTCUT)
  globalShortcut.unregister(CONTINUOUS_CAPTURE_SHORTCUT)
  globalShortcut.unregister(CONTINUOUS_SELECTION_SHORTCUT)
  globalShortcut.unregister(CONTINUOUS_FINISH_SHORTCUT)
  globalShortcut.unregister(CONTINUOUS_UNDO_SHORTCUT)
  globalShortcut.unregister(CONTINUOUS_CANCEL_SHORTCUT)
  updateStealth(loadConfig().stealth)
}

function registerMentorModeShortcuts(): void {
  mentorModeActive = true
  // Mentor 全流程由全局快捷键控制。面板始终不可聚焦，避免打断被采集窗口。
  enforceMentorNonFocus()
  updateMentorDelayedCapture(loadConfig().mentor)
  const shortcuts = [
    {
      accelerator: FULL_SCREEN_CAPTURE_SHORTCUT,
      callback: (): void => {
        void captureFullScreenForMentor().catch(() => {})
      }
    },
    {
      accelerator: REGION_CAPTURE_SHORTCUT,
      callback: startMentorRegionSelection
    },
    {
      accelerator: RECHECK_ANSWER_SHORTCUT,
      callback: (): void => {
        const win = getMainWindow()
        if (!win || win.isDestroyed()) return
        win.webContents.send(IPC.MENTOR_RECHECK_ANSWER)
      }
    },
    {
      accelerator: DISMISS_MENTOR_SHORTCUT,
      callback: (): void => {
        const win = getMainWindow()
        if (!win || win.isDestroyed()) return
        win.webContents.send(IPC.MENTOR_TOGGLE_PANEL)
      }
    },
    {
      accelerator: CONTINUOUS_CAPTURE_SHORTCUT,
      callback: (): void => {
        const win = getMainWindow()
        if (!win || win.isDestroyed()) return
        win.webContents.send(IPC.MENTOR_CONTINUOUS_CAPTURE)
      }
    },
    {
      accelerator: CONTINUOUS_SELECTION_SHORTCUT,
      callback: (): void => {
        const win = getMainWindow()
        if (!win || win.isDestroyed()) return
        win.webContents.send(IPC.MENTOR_CONTINUOUS_SELECTION)
      }
    },
    {
      accelerator: CONTINUOUS_FINISH_SHORTCUT,
      callback: (): void => {
        const win = getMainWindow()
        if (!win || win.isDestroyed()) return
        win.webContents.send(IPC.MENTOR_CONTINUOUS_FINISH)
      }
    },
    {
      accelerator: CONTINUOUS_UNDO_SHORTCUT,
      callback: (): void => {
        const win = getMainWindow()
        if (!win || win.isDestroyed()) return
        win.webContents.send(IPC.MENTOR_CONTINUOUS_UNDO)
      }
    },
    {
      accelerator: CONTINUOUS_CANCEL_SHORTCUT,
      callback: (): void => {
        closeMentorSelectionWindow()
        const win = getMainWindow()
        if (!win || win.isDestroyed()) return
        win.webContents.send(IPC.MENTOR_CONTINUOUS_CANCEL)
      }
    }
  ]

  for (const { accelerator, callback } of shortcuts) {
    if (globalShortcut.isRegistered(accelerator)) continue

    const registered = globalShortcut.register(accelerator, callback)
    if (!registered) {
      console.warn(`[mentor] 模式快捷键 ${accelerator} 注册失败`)
    }
  }
}

function createMentorSelectionWindow(): BrowserWindow {
  const displayBounds = screen.getPrimaryDisplay().bounds
  const win = new BrowserWindow({
    ...displayBounds,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  mentorSelectionWindow = win
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setFocusable(false)
  win.setIgnoreMouseEvents(false)
  if (typeof win.setContentProtection === 'function') {
    win.setContentProtection(true)
  }

  if (process.env['ELECTRON_RENDERER_URL']) {
    const rendererUrl = new URL(process.env['ELECTRON_RENDERER_URL'])
    rendererUrl.searchParams.set('mentorSelection', '1')
    rendererUrl.hash = 'mentor'
    void win.loadURL(rendererUrl.toString())
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), {
      hash: 'mentor',
      query: { mentorSelection: '1' }
    })
  }

  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return
    win.showInactive()
  })

  win.on('closed', () => {
    if (mentorSelectionWindow === win) {
      mentorSelectionWindow = null
    }
  })

  return win
}

export function closeMentorSelectionWindow(): void {
  const win = mentorSelectionWindow
  mentorSelectionWindow = null
  if (win && !win.isDestroyed()) {
    win.close()
  }
}

export function startMentorRegionSelection(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return

  win.webContents.send(IPC.MENTOR_START_SELECTION)
  if (mentorSelectionWindow && !mentorSelectionWindow.isDestroyed()) {
    return
  }
  createMentorSelectionWindow()
}

async function captureMentorFrame(
  rect?: MentorRegionRect
): Promise<MentorCapturePayload> {
  if (captureInProgress) {
    throw new Error('上一帧仍在截取')
  }
  const win = getMainWindow()
  if (!win || win.isDestroyed()) {
    throw new Error('主窗口不存在')
  }

  captureInProgress = true
  win.setIgnoreMouseEvents(true, { forward: true })

  try {
    const capture = await capturePrimaryDisplay(rect)
    return {
      imageBase64: capture.png.toString('base64'),
      imageWidth: capture.width,
      imageHeight: capture.height,
      captureMode: rect ? 'region' : 'fullscreen'
    }
  } catch (err) {
    console.error('[mentor] 屏幕截取失败:', err)
    throw err
  } finally {
    if (!win.isDestroyed()) {
      // 捕获不激活 Mentor，恢复鼠标事件后目标窗口仍保持焦点。
      win.setIgnoreMouseEvents(false)
    }
    captureInProgress = false
  }
}

async function captureForMentor(
  rect?: MentorRegionRect,
  captureTarget?: MentorCaptureTarget
): Promise<void> {
  const payload = {
    ...(await captureMentorFrame(rect)),
    captureTarget
  }
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.MENTOR_CAPTURE, payload)
  }
}

export async function captureFullScreenForMentor(): Promise<void> {
  if (mentorModeActive && delayedCaptureConfig.delayedCaptureEnabled) {
    // 手动全屏截取也完成当前静止周期，避免快捷键触发后立刻再自动截取。
    delayedCaptureTriggered = true
  }
  await captureForMentor()
}

export async function handleRegionSelected(
  rect: MentorRegionRect
): Promise<void> {
  lastMentorRegion = normalizeRegionRect(rect)
  await captureForMentor(lastMentorRegion, {
    ownerName: '固定选区',
    windowName: `${lastMentorRegion.width}×${lastMentorRegion.height}`,
    bounds: lastMentorRegion
  })
}

export async function captureLastMentorRegion(): Promise<void> {
  if (!lastMentorRegion) {
    throw new Error('尚未锁定连续采集区域，请先按 Control+Command+J 选取区域')
  }
  await captureForMentor(lastMentorRegion)
}

export async function captureFrontmostWindowFrame(
  resetWindowLock = false
): Promise<MentorCapturePayload> {
  if (resetWindowLock || !lastMentorWindowTarget) {
    try {
      const frontmost = await resolveFrontmostWindow()
      lastMentorWindowTarget = {
        ...frontmost,
        ...normalizeRegionRect(frontmost)
      }
      console.log(
        `[mentor] 已锁定前台窗口：${frontmost.ownerName} ${frontmost.windowName}`.trim()
      )
    } catch (error) {
      lastMentorWindowTarget = null
      throw new Error(
        `无法锁定前台目标窗口：${(error as Error).message}。请保持目标窗口在前台后重试，或使用固定选区模式。`
      )
    }
  }
  const target = lastMentorWindowTarget
  if (!target) {
    throw new Error('前台目标窗口未锁定')
  }
  if (captureInProgress) {
    throw new Error('上一帧仍在截取')
  }
  const win = getMainWindow()
  if (!win || win.isDestroyed()) {
    throw new Error('主窗口不存在')
  }

  captureInProgress = true
  win.setIgnoreMouseEvents(true, { forward: true })
  try {
    const capture = await captureWindowById(target)
    return {
      imageBase64: capture.png.toString('base64'),
      imageWidth: capture.width,
      imageHeight: capture.height,
      captureMode: 'fullscreen',
      captureTarget: {
        ownerName: target.ownerName,
        windowName: target.windowName,
        bounds: normalizeRegionRect(target),
        windowId: target.windowId
      }
    }
  } finally {
    if (!win.isDestroyed()) {
      win.setIgnoreMouseEvents(false)
    }
    captureInProgress = false
  }
}

export function captureLastMentorRegionFrame(): Promise<MentorCapturePayload> {
  if (!lastMentorRegion) {
    return Promise.reject(
      new Error('尚未锁定滚动捕获区域，请先按 Control+Command+J 选取区域')
    )
  }
  return captureMentorFrame(lastMentorRegion).then((payload) => ({
    ...payload,
    captureTarget: {
      ownerName: '固定选区',
      windowName: `${lastMentorRegion?.width ?? 0}×${lastMentorRegion?.height ?? 0}`,
      bounds: lastMentorRegion as MentorRegionRect
    }
  }))
}

export function registerMentorShortcut(): void {
  const shortcuts = [
    {
      accelerator: MENTOR_SHORTCUT,
      callback: (): void => {
        const win = getMainWindow()
        if (!win || win.isDestroyed()) return
        win.webContents.send(IPC.MENTOR_TOGGLE_PANEL)
      }
    },
    {
      accelerator: TOGGLE_LISTENING_SHORTCUT,
      callback: (): void => {
        const win = getMainWindow()
        if (!win || win.isDestroyed()) return
        win.webContents.send(IPC.MENTOR_TOGGLE_LISTENING)
      }
    },
    {
      accelerator: COPY_ANSWER_SHORTCUT,
      callback: (): void => {
        const win = getMainWindow()
        if (!win || win.isDestroyed()) return
        win.webContents.send(IPC.MENTOR_COPY_ANSWER)
      }
    }
  ]

  for (const { accelerator, callback } of shortcuts) {
    const registered = globalShortcut.register(accelerator, callback)
    if (!registered) {
      console.error(`[mentor] 全局快捷键 ${accelerator} 注册失败`)
    }
  }
}

export function unregisterMentorShortcut(): void {
  unregisterMentorModeShortcuts()
  closeMentorSelectionWindow()
  globalShortcut.unregister(MENTOR_SHORTCUT)
  globalShortcut.unregister(TOGGLE_LISTENING_SHORTCUT)
  globalShortcut.unregister(COPY_ANSWER_SHORTCUT)
}

export { registerMentorModeShortcuts, unregisterMentorModeShortcuts }
