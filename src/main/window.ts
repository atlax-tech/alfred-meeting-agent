/**
 * 主窗口创建与管理
 */

import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'
import { applyStealth } from './stealth'
import { applyNativeLiquidGlass } from './liquid-glass'
import type { StealthState } from '@shared/types'

let mainWindow: BrowserWindow | null = null
let isQuitting = false

const DEFAULT_WIDTH = 480
const DEFAULT_HEIGHT = 40
const MIN_WIDTH = 320
const MAX_WIDTH = 700
const MAX_HEIGHT = 700
const WINDOW_MARGIN = 12

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/** 允许应用退出时真正关闭窗口，而不是隐藏到托盘。 */
export function setMainWindowQuitting(quitting: boolean): void {
  isQuitting = quitting
}

export interface CreateWindowOptions {
  stealth: StealthState
}

export function createMainWindow(opts: CreateWindowOptions): BrowserWindow {
  const { workArea } = screen.getPrimaryDisplay()
  const x = workArea.x + workArea.width - DEFAULT_WIDTH - WINDOW_MARGIN
  const y = workArea.y + WINDOW_MARGIN

  // 无边框透明窗口只提供画布，圆角和展开动画由渲染进程负责。
  mainWindow = new BrowserWindow({
    x,
    y,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    minWidth: MIN_WIDTH,
    maxWidth: MAX_WIDTH,
    minHeight: DEFAULT_HEIGHT,
    maxHeight: MAX_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    opacity: 0.98,
    skipTaskbar: false,
    backgroundColor: '#00000000',
    title: 'InviewPractice',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  const win = mainWindow

  // macOS 26 uses AppKit's real NSGlassEffectView. Older systems keep the
  // native vibrancy fallback instead of receiving a CSS-only imitation.
  if (process.platform === 'darwin' && !applyNativeLiquidGlass(win)) {
    win.setVibrancy('under-window')
  }

  // 应用隐蔽配置
  applyStealth(win, opts.stealth)

  // macOS 会为原生全屏应用创建独立 Space，需要显式允许覆盖全屏窗口。
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // 拦截新窗口,在外部浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // 捕获渲染进程 console 输出到主进程终端(用于诊断 STT 问题)
  // Electron 33+ console-message 签名: (event, details)
  win.webContents.on('console-message', (_e, details) => {
    const d = details as { level?: number; message?: string; line?: number; sourceId?: string }
    const level = d.level ?? 0
    const tag = level >= 3 ? '[RENDERER ERROR]' : `[RENDERER L${level}]`
    console.log(`${tag} ${d.message} (${d.sourceId}:${d.line})`)
  })

  // 加载渲染进程
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show()
  })

  win.on('close', (event) => {
    if (process.platform === 'darwin' && !isQuitting) {
      event.preventDefault()
      win.hide()
    }
  })

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  // 渲染进程异常退出时记录并自动重载,避免永久黑屏
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[main] Renderer process gone:', details.reason, details.exitCode)
    if (!win.isDestroyed()) {
      win.reload()
    }
  })

  return win
}

/** 动态更新隐蔽配置(无需重建窗口) */
export function updateStealth(state: StealthState): void {
  if (!mainWindow) return
  applyStealth(mainWindow, state)
}
