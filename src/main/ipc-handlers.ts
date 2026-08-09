/**
 * IPC 事件处理器
 */

import {
  app,
  ipcMain,
  BrowserWindow,
  desktopCapturer,
  dialog,
  systemPreferences
} from 'electron'
import { extname } from 'path'
import { IPC } from './ipc-channels'
import { loadConfig, saveConfig } from './config'
import { readKnowledgeBaseCorpus } from './knowledge-base'
import {
  maintainMeetingKnowledgeBase,
  saveMeetingNote
} from './meeting-notes'
import {
  listPersonalizationVersions,
  loadPersonalizationEvidence,
  loadPersonalizationProfile,
  markPersonalizationEvidenceProcessed,
  rollbackPersonalizationProfile,
  savePersonalizationProfile,
  upsertPersonalizationEvidence
} from './personalization'
import {
  checkRepositorySnapshotFreshness,
  indexRepository,
  listLatestRepositories
} from './repository-knowledge/indexer'
import {
  getRepositoryEvidence,
  prewarmRepositorySnapshot,
  retrieveRepositoryContext
} from './repository-knowledge/retriever'
import { getMainWindow, updateStealth } from './window'
import { temporarilyEnableFocus } from './stealth/anti-switch'
import {
  captureLastMentorRegion,
  captureLastMentorRegionFrame,
  captureFullScreenForMentor,
  captureFrontmostWindowFrame,
  closeMentorSelectionWindow,
  enforceMentorNonFocus,
  extractLockedWindowAccessibilityText,
  handleRegionSelected,
  registerMentorModeShortcuts,
  recognizeImageWithVision,
  startMentorRegionSelection,
  updateMentorDelayedCapture,
  unregisterMentorModeShortcuts
} from './mentor'
import type {
  AppConfig,
  RepositoryIndexRequest,
  RepositoryRetrievalRequest,
  StealthState
} from '@shared/types'
import type {
  MentorAccessibilityTextOptions,
  WindowResizeOptions
} from '@shared/preload-api'

const MAX_REFERENCE_DOCUMENT_BYTES = 20 * 1024 * 1024
const PLAIN_TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.json',
  '.log'
])

async function parseReferenceDocument(
  data: ArrayBuffer,
  fileName: string
): Promise<string> {
  if (!(data instanceof ArrayBuffer) || data.byteLength === 0) {
    throw new Error('文件内容为空')
  }
  if (data.byteLength > MAX_REFERENCE_DOCUMENT_BYTES) {
    throw new Error('单个文件不能超过 20 MB')
  }

  const extension = extname(fileName).toLocaleLowerCase()
  const bytes = new Uint8Array(data)
  if (PLAIN_TEXT_EXTENSIONS.has(extension)) {
    return new TextDecoder('utf-8').decode(bytes)
  }

  if (extension === '.pdf') {
    try {
      const { PDFParse } = require('pdf-parse')
      const parser = new PDFParse({ data: bytes })
      const result = await parser.getText()
      await parser.destroy()
      return result.text as string
    } catch (error) {
      throw new Error(`PDF 解析失败: ${(error as Error).message}`)
    }
  }

  if (extension === '.docx') {
    try {
      const mammoth = require('mammoth') as {
        extractRawText: (options: {
          buffer: Buffer
        }) => Promise<{ value: string }>
      }
      const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) })
      return result.value
    } catch (error) {
      throw new Error(`DOCX 解析失败: ${(error as Error).message}`)
    }
  }

  throw new Error('暂不支持该格式，请上传 PDF、DOCX、TXT、Markdown、CSV、JSON 或 LOG')
}

export function registerIpcHandlers(): void {
  // 设置、历史搜索、反馈输入可能嵌套打开。用计数避免内层关闭时过早恢复 noFocus。
  let inputFocusLeaseCount = 0
  let repositoryIndexAbort: AbortController | null = null

  const acquireInputFocus = (): boolean => {
    const win = getMainWindow()
    if (!win) return false
    if (enforceMentorNonFocus()) return false
    inputFocusLeaseCount += 1
    temporarilyEnableFocus(win)
    return true
  }

  const releaseInputFocus = (): boolean => {
    inputFocusLeaseCount = Math.max(0, inputFocusLeaseCount - 1)
    if (inputFocusLeaseCount === 0) {
      updateStealth(loadConfig().stealth)
      enforceMentorNonFocus()
    }
    return true
  }

  // 获取配置
  ipcMain.handle(IPC.CONFIG_GET, () => {
    return loadConfig()
  })

  // 保存配置
  ipcMain.handle(IPC.CONFIG_SET, (_event, config: AppConfig) => {
    saveConfig(config)
    // 如果隐蔽配置变化,立即应用
    updateStealth(config.stealth)
    updateMentorDelayedCapture(config.mentor)
    const mentorOwnsFocusPolicy = enforceMentorNonFocus()
    if (inputFocusLeaseCount > 0 && !mentorOwnsFocusPolicy) {
      const win = getMainWindow()
      if (win) temporarilyEnableFocus(win)
    }
    return true
  })

  ipcMain.handle(IPC.PERSONALIZATION_GET, () => {
    return loadPersonalizationProfile()
  })

  ipcMain.handle(IPC.PERSONALIZATION_SET, (_event, profile: unknown) => {
    return savePersonalizationProfile(profile)
  })

  ipcMain.handle(IPC.PERSONALIZATION_VERSIONS, () => {
    return listPersonalizationVersions()
  })

  ipcMain.handle(IPC.PERSONALIZATION_ROLLBACK, (_event, version: number) => {
    return rollbackPersonalizationProfile(version)
  })

  ipcMain.handle(IPC.PERSONALIZATION_EVIDENCE_GET, () => {
    return loadPersonalizationEvidence()
  })

  ipcMain.handle(IPC.PERSONALIZATION_EVIDENCE_UPSERT, (_event, evidence: unknown) => {
    return upsertPersonalizationEvidence(evidence)
  })

  ipcMain.handle(IPC.PERSONALIZATION_EVIDENCE_MARK, (_event, version: number) => {
    return markPersonalizationEvidenceProcessed(version)
  })

  ipcMain.handle(IPC.KNOWLEDGE_BASE_SELECT, async () => {
    const win = getMainWindow()
    const options: Electron.OpenDialogOptions = {
      title: '选择个人知识库',
      properties: ['openDirectory']
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? '' : result.filePaths[0] ?? ''
  })

  ipcMain.handle(IPC.KNOWLEDGE_BASE_READ, (_event, rootPath: string) => {
    return readKnowledgeBaseCorpus(rootPath)
  })

  ipcMain.handle(IPC.MEETING_NOTE_SAVE, (_event, payload: unknown) => {
    return saveMeetingNote(payload)
  })

  ipcMain.handle(
    IPC.MEETING_KNOWLEDGE_MAINTAIN,
    (_event, notePath: string) => maintainMeetingKnowledgeBase(notePath)
  )

  // 仅更新隐蔽状态(实时调整,不写盘)
  ipcMain.handle(IPC.STEALTH_UPDATE, (_event, state: StealthState) => {
    updateStealth(state)
    const mentorOwnsFocusPolicy = enforceMentorNonFocus()
    if (inputFocusLeaseCount > 0 && !mentorOwnsFocusPolicy) {
      const win = getMainWindow()
      if (win) temporarilyEnableFocus(win)
    }
    return true
  })

  ipcMain.handle(IPC.STEALTH_GET, () => {
    return loadConfig().stealth
  })

  // 窗口控制
  ipcMain.handle(IPC.WIN_MINIMIZE, () => {
    getMainWindow()?.minimize()
  })

  ipcMain.handle(IPC.WIN_CLOSE, () => {
    getMainWindow()?.close()
  })

  ipcMain.handle(IPC.WIN_TOGGLE_ALWAYS_ON_TOP, () => {
    const win: BrowserWindow | null = getMainWindow()
    if (!win) return false
    const next = !win.isAlwaysOnTop()
    win.setAlwaysOnTop(next, 'screen-saver')
    return next
  })

  ipcMain.handle(IPC.WIN_RESIZE, (event, options: WindowResizeOptions) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? getMainWindow()
    if (!win || win.isDestroyed() || !Number.isFinite(options?.height)) return false

    const bounds = win.getBounds()
    const requestedHeight = Math.round(options.height)
    const requestedWidth = options?.width
    const hasValidWidth =
      Number.isFinite(requestedWidth) &&
      Number(requestedWidth) >= 320 &&
      Number(requestedWidth) <= 700
    const width = hasValidWidth ? Math.round(Number(requestedWidth)) : bounds.width
    // 宽度拖拽会回传当前高度；Mentor 的高面板不应因此被压缩。
    const height =
      hasValidWidth && requestedHeight === bounds.height
        ? bounds.height
        : Math.max(40, Math.min(700, requestedHeight))
    // Mentor 从左侧拖拽改宽，右边缘应固定在屏幕边缘。
    const x = hasValidWidth ? bounds.x + bounds.width - width : bounds.x

    win.setBounds({ x, y: bounds.y, width, height }, Boolean(options.animate))
    return true
  })

  ipcMain.handle(IPC.APP_QUIT, () => {
    app.quit()
  })

  // 设置面板打开:临时恢复窗口可聚焦(否则 antiSwitchDetect 会导致 input 无法输入)
  ipcMain.handle(IPC.SETTINGS_OPEN, () => {
    return acquireInputFocus()
  })

  // 设置面板关闭:根据配置恢复隐蔽状态
  ipcMain.handle(IPC.SETTINGS_CLOSE, () => {
    return releaseInputFocus()
  })

  ipcMain.handle(IPC.INPUT_FOCUS_ACQUIRE, () => {
    return acquireInputFocus()
  })

  ipcMain.handle(IPC.INPUT_FOCUS_RELEASE, () => {
    return releaseInputFocus()
  })

  // 获取可用于采集系统音频的桌面源(sourceId)
  // macOS 屏幕录制权限无法主动调用 API 请求,只能在首次调用 desktopCapturer.getSources() 时
  // 由系统自动弹窗。thumbnailSize 需用正常尺寸,否则系统可能跳过实际捕获,不触发弹窗。
  ipcMain.handle(IPC.SYSTEM_AUDIO_SOURCES, async () => {
    // 优先尝试带缩略图的请求;某些系统上即使权限已授予,缩略图生成也会失败
    const tryGetSources = async (thumbnailSize: { width: number; height: number }) => {
      return await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize
      })
    }

    try {
      const sources = await tryGetSources({ width: 320, height: 180 })
      return sources.map((s) => ({
        id: s.id,
        name: s.name
      }))
    } catch (err1) {
      console.warn('[SYSTEM_AUDIO_SOURCES] 第一次 getSources 失败:', err1)
      try {
        const sources = await tryGetSources({ width: 0, height: 0 })
        return sources.map((s) => ({
          id: s.id,
          name: s.name
        }))
      } catch (err2) {
        console.error('[SYSTEM_AUDIO_SOURCES] 第二次 getSources 仍失败:', err2)
        throw new Error(
          `Failed to get sources. ` +
          `reason=${(err2 as Error).message || err2}; ` +
          `platform=${process.platform}; ` +
          `please restart the app after granting screen recording permission.`
        )
      }
    }
  })

  // 获取当前系统音频采集权限状态
  // 返回 'granted' | 'denied' | 'not-determined'
  ipcMain.handle(IPC.SYSTEM_AUDIO_PERMISSION, () => {
    if (process.platform === 'darwin') {
      try {
        const status = (systemPreferences.getMediaAccessStatus as (m: string) => string)('screen')
        console.log('[SYSTEM_AUDIO_PERMISSION] macOS screen access status:', status)
        return status === 'granted' ? 'granted' : status === 'denied' ? 'denied' : 'not-determined'
      } catch (err) {
        console.error('[SYSTEM_AUDIO_PERMISSION] getMediaAccessStatus failed:', err)
        return 'not-determined'
      }
    }
    return 'granted'
  })

  // 解析简历文件(PDF/TXT → 纯文本)
  ipcMain.handle(IPC.RESUME_PARSE, async (_event, data: ArrayBuffer, fileName: string) => {
    return parseReferenceDocument(data, fileName)
  })

  ipcMain.handle(
    IPC.SESSION_DOCUMENT_PARSE,
    async (_event, data: ArrayBuffer, fileName: string) => {
      return parseReferenceDocument(data, fileName)
    }
  )

  ipcMain.handle(IPC.REPOSITORY_SELECT, async () => {
    const win = getMainWindow()
    const options: Electron.OpenDialogOptions = {
      title: '选择会前工作仓库',
      properties: ['openDirectory']
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? '' : result.filePaths[0] ?? ''
  })

  ipcMain.handle(
    IPC.REPOSITORY_INDEX,
    async (_event, request: RepositoryIndexRequest) => {
      if (repositoryIndexAbort) throw new Error('已有仓库正在建立知识索引')
      const controller = new AbortController()
      repositoryIndexAbort = controller
      try {
        return await indexRepository(request, loadConfig().llm, {
          signal: controller.signal,
          onProgress: (value) => {
            const win = getMainWindow()
            if (win && !win.isDestroyed()) {
              win.webContents.send(IPC.REPOSITORY_INDEX_PROGRESS, value)
            }
          }
        })
      } finally {
        if (repositoryIndexAbort === controller) repositoryIndexAbort = null
      }
    }
  )

  ipcMain.handle(IPC.REPOSITORY_INDEX_CANCEL, () => {
    if (!repositoryIndexAbort) return false
    repositoryIndexAbort.abort()
    return true
  })

  ipcMain.handle(IPC.REPOSITORY_LIST, () => listLatestRepositories())

  ipcMain.handle(IPC.REPOSITORY_FRESHNESS, (_event, snapshotId: string) => {
    return checkRepositorySnapshotFreshness(snapshotId)
  })

  ipcMain.handle(IPC.REPOSITORY_PREWARM, (_event, snapshotId: string) => {
    return prewarmRepositorySnapshot(snapshotId)
  })

  ipcMain.handle(
    IPC.REPOSITORY_RETRIEVE,
    (_event, request: RepositoryRetrievalRequest) => {
      return retrieveRepositoryContext(request)
    }
  )

  ipcMain.handle(
    IPC.REPOSITORY_EVIDENCE,
    (_event, snapshotId: string, evidenceIds: string[]) => {
      return getRepositoryEvidence(
        snapshotId,
        Array.isArray(evidenceIds) ? evidenceIds : []
      )
    }
  )

  // 顶部 mentor 按钮与 Command+G 共用同一套开关流程。
  ipcMain.handle(IPC.MENTOR_CAPTURE_REQUEST, () => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.MENTOR_TOGGLE_PANEL)
    }
  })

  ipcMain.handle(IPC.MENTOR_FULLSCREEN_CAPTURE_REQUEST, async () => {
    await captureFullScreenForMentor()
  })

  ipcMain.handle(IPC.MENTOR_REGION_CAPTURE_REQUEST, async () => {
    await captureLastMentorRegion()
  })

  ipcMain.handle(IPC.MENTOR_FULLSCREEN_FRAME_REQUEST, (_event, resetWindowLock) => {
    return captureFrontmostWindowFrame(resetWindowLock === true)
  })

  ipcMain.handle(IPC.MENTOR_REGION_FRAME_REQUEST, () => {
    return captureLastMentorRegionFrame()
  })

  ipcMain.handle(
    IPC.MENTOR_ACCESSIBILITY_TEXT_REQUEST,
    (_event, options?: MentorAccessibilityTextOptions) => {
      return extractLockedWindowAccessibilityText(options)
    }
  )

  ipcMain.handle(IPC.MENTOR_ACCESSIBILITY_PERMISSION_GET, () => {
    return systemPreferences.isTrustedAccessibilityClient(false)
  })

  ipcMain.handle(IPC.MENTOR_ACCESSIBILITY_PERMISSION_REQUEST, () => {
    return systemPreferences.isTrustedAccessibilityClient(true)
  })

  ipcMain.handle(IPC.MENTOR_VISION_OCR_REQUEST, (_event, imageBase64: string) => {
    return recognizeImageWithVision(imageBase64)
  })

  ipcMain.handle(IPC.MENTOR_SELECTION_REQUEST, () => {
    startMentorRegionSelection()
  })

  ipcMain.handle(IPC.MENTOR_REGION_SELECTED, async (_event, rect) => {
    await handleRegionSelected(rect)
  })

  // Mentor 面板打开时启用截屏、选区与关闭快捷键。
  ipcMain.handle(IPC.MENTOR_PANEL_OPEN, () => {
    registerMentorModeShortcuts()
  })

  // Mentor 面板关闭时注销模式快捷键，并清理可能残留的选区窗口。
  ipcMain.handle(IPC.MENTOR_PANEL_CLOSE, () => {
    unregisterMentorModeShortcuts()
    closeMentorSelectionWindow()
  })
}
