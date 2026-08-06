/**
 * preload 桥接脚本
 * 通过 contextBridge 暴露安全 API 给渲染进程
 */

import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../main/ipc-channels'
import type {
  AppConfig,
  KnowledgeBaseCorpus,
  KnowledgeMaintenanceResult,
  MeetingNoteExportPayload,
  MeetingNoteSaveResult,
  PersonalizationFeedbackEvidence,
  PersonalizationProfile,
  PersonalizationVersionSummary,
  StealthState
} from '@shared/types'
import type {
  InviewAPI,
  MentorAccessibilityTextOptions,
  MentorAccessibilityTextResult,
  MentorCapturePayload,
  MentorRegionRect,
  VisionOcrResult,
  WindowResizeOptions
} from '@shared/preload-api'

const api: InviewAPI = {
  /** 获取完整配置 */
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke(IPC.CONFIG_GET),
  /** 保存完整配置 */
  setConfig: (config: AppConfig): Promise<boolean> =>
    ipcRenderer.invoke(IPC.CONFIG_SET, config),
  getPersonalization: (): Promise<PersonalizationProfile> =>
    ipcRenderer.invoke(IPC.PERSONALIZATION_GET),
  setPersonalization: (
    profile: PersonalizationProfile
  ): Promise<PersonalizationProfile> =>
    ipcRenderer.invoke(IPC.PERSONALIZATION_SET, profile),
  getPersonalizationVersions: (): Promise<PersonalizationVersionSummary[]> =>
    ipcRenderer.invoke(IPC.PERSONALIZATION_VERSIONS),
  rollbackPersonalization: (version: number): Promise<PersonalizationProfile> =>
    ipcRenderer.invoke(IPC.PERSONALIZATION_ROLLBACK, version),
  getPersonalizationEvidence: (): Promise<PersonalizationFeedbackEvidence[]> =>
    ipcRenderer.invoke(IPC.PERSONALIZATION_EVIDENCE_GET),
  upsertPersonalizationEvidence: (
    evidence: PersonalizationFeedbackEvidence
  ): Promise<PersonalizationFeedbackEvidence[]> =>
    ipcRenderer.invoke(IPC.PERSONALIZATION_EVIDENCE_UPSERT, evidence),
  markPersonalizationEvidenceProcessed: (
    profileVersion: number
  ): Promise<PersonalizationFeedbackEvidence[]> =>
    ipcRenderer.invoke(IPC.PERSONALIZATION_EVIDENCE_MARK, profileVersion),
  selectKnowledgeBaseFolder: (): Promise<string> =>
    ipcRenderer.invoke(IPC.KNOWLEDGE_BASE_SELECT),
  readKnowledgeBaseCorpus: (rootPath: string): Promise<KnowledgeBaseCorpus> =>
    ipcRenderer.invoke(IPC.KNOWLEDGE_BASE_READ, rootPath),
  saveMeetingNote: (
    payload: MeetingNoteExportPayload
  ): Promise<MeetingNoteSaveResult> =>
    ipcRenderer.invoke(IPC.MEETING_NOTE_SAVE, payload),
  retryMeetingKnowledgeMaintenance: (
    notePath: string
  ): Promise<KnowledgeMaintenanceResult> =>
    ipcRenderer.invoke(IPC.MEETING_KNOWLEDGE_MAINTAIN, notePath),
  /** 实时更新隐蔽状态(不写盘) */
  updateStealth: (state: StealthState): Promise<boolean> =>
    ipcRenderer.invoke(IPC.STEALTH_UPDATE, state),
  /** 获取当前隐蔽状态 */
  getStealth: (): Promise<StealthState> => ipcRenderer.invoke(IPC.STEALTH_GET),

  // 窗口控制
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke(IPC.WIN_MINIMIZE),
  closeWindow: (): Promise<void> => ipcRenderer.invoke(IPC.WIN_CLOSE),
  quitApp: (): Promise<void> => ipcRenderer.invoke(IPC.APP_QUIT),
  toggleAlwaysOnTop: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC.WIN_TOGGLE_ALWAYS_ON_TOP),
  resizeWindow: (options: WindowResizeOptions): Promise<boolean> =>
    ipcRenderer.invoke(IPC.WIN_RESIZE, options),

  // 设置面板焦点管理(切屏检测规避开启时,设置面板需临时恢复可聚焦)
  settingsOpen: (): Promise<boolean> => ipcRenderer.invoke(IPC.SETTINGS_OPEN),
  settingsClose: (): Promise<boolean> => ipcRenderer.invoke(IPC.SETTINGS_CLOSE),
  inputFocusAcquire: (): Promise<boolean> => ipcRenderer.invoke(IPC.INPUT_FOCUS_ACQUIRE),
  inputFocusRelease: (): Promise<boolean> => ipcRenderer.invoke(IPC.INPUT_FOCUS_RELEASE),

  // 系统音频源(采集腾讯会议/飞书等对方声音)
  getSystemAudioSources: (): Promise<Array<{ id: string; name: string }>> =>
    ipcRenderer.invoke(IPC.SYSTEM_AUDIO_SOURCES),
  getSystemAudioPermission: (): Promise<string> =>
    ipcRenderer.invoke(IPC.SYSTEM_AUDIO_PERMISSION),

  // electron-audio-loopback: 临时启用/禁用系统音频 loopback
  // 调用 enableLoopbackAudio() 后,getDisplayMedia 会返回系统音频
  // 获取后立即调用 disableLoopbackAudio() 恢复正常行为
  enableLoopbackAudio: (): Promise<void> => ipcRenderer.invoke(IPC.LOOPBACK_ENABLE),
  disableLoopbackAudio: (): Promise<void> => ipcRenderer.invoke(IPC.LOOPBACK_DISABLE),

  // 解析简历文件(PDF/TXT → 纯文本)
  parseResume: (data: ArrayBuffer, fileName: string): Promise<string> =>
    ipcRenderer.invoke(IPC.RESUME_PARSE, data, fileName),
  parseReferenceDocument: (
    data: ArrayBuffer,
    fileName: string
  ): Promise<string> =>
    ipcRenderer.invoke(IPC.SESSION_DOCUMENT_PARSE, data, fileName),

  // 屏幕文字识别助手
  captureMentor: (): Promise<void> =>
    ipcRenderer.invoke(IPC.MENTOR_CAPTURE_REQUEST),
  captureMentorScreen: (): Promise<void> =>
    ipcRenderer.invoke(IPC.MENTOR_FULLSCREEN_CAPTURE_REQUEST),
  captureMentorRegion: (): Promise<void> =>
    ipcRenderer.invoke(IPC.MENTOR_REGION_CAPTURE_REQUEST),
  captureMentorScreenFrame: (
    resetWindowLock?: boolean
  ): Promise<MentorCapturePayload> =>
    ipcRenderer.invoke(IPC.MENTOR_FULLSCREEN_FRAME_REQUEST, resetWindowLock),
  captureMentorRegionFrame: (): Promise<MentorCapturePayload> =>
    ipcRenderer.invoke(IPC.MENTOR_REGION_FRAME_REQUEST),
  extractMentorWindowText: (
    options?: MentorAccessibilityTextOptions
  ): Promise<MentorAccessibilityTextResult> =>
    ipcRenderer.invoke(IPC.MENTOR_ACCESSIBILITY_TEXT_REQUEST, options),
  getMentorAccessibilityPermission: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC.MENTOR_ACCESSIBILITY_PERMISSION_GET),
  requestMentorAccessibilityPermission: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC.MENTOR_ACCESSIBILITY_PERMISSION_REQUEST),
  recognizeMentorImage: (imageBase64: string): Promise<VisionOcrResult> =>
    ipcRenderer.invoke(IPC.MENTOR_VISION_OCR_REQUEST, imageBase64),
  startMentorSelection: (): Promise<void> =>
    ipcRenderer.invoke(IPC.MENTOR_SELECTION_REQUEST),
  onMentorCapture: (callback: (payload: MentorCapturePayload) => void): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: MentorCapturePayload
    ): void => callback(payload)
    ipcRenderer.on(IPC.MENTOR_CAPTURE, listener)
    return () => ipcRenderer.removeListener(IPC.MENTOR_CAPTURE, listener)
  },
  onMentorCaptureError: (callback: (message: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string): void =>
      callback(message)
    ipcRenderer.on(IPC.MENTOR_CAPTURE_ERROR, listener)
    return () => ipcRenderer.removeListener(IPC.MENTOR_CAPTURE_ERROR, listener)
  },
  onMentorDelayedCapture: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.MENTOR_DELAYED_CAPTURE, listener)
    return () => ipcRenderer.removeListener(IPC.MENTOR_DELAYED_CAPTURE, listener)
  },
  onMentorStartSelection: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.MENTOR_START_SELECTION, listener)
    return () => ipcRenderer.removeListener(IPC.MENTOR_START_SELECTION, listener)
  },
  onMentorContinuousCapture: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.MENTOR_CONTINUOUS_CAPTURE, listener)
    return () => ipcRenderer.removeListener(IPC.MENTOR_CONTINUOUS_CAPTURE, listener)
  },
  onMentorContinuousSelection: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.MENTOR_CONTINUOUS_SELECTION, listener)
    return () => ipcRenderer.removeListener(IPC.MENTOR_CONTINUOUS_SELECTION, listener)
  },
  onMentorContinuousFinish: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.MENTOR_CONTINUOUS_FINISH, listener)
    return () => ipcRenderer.removeListener(IPC.MENTOR_CONTINUOUS_FINISH, listener)
  },
  onMentorContinuousUndo: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.MENTOR_CONTINUOUS_UNDO, listener)
    return () => ipcRenderer.removeListener(IPC.MENTOR_CONTINUOUS_UNDO, listener)
  },
  onMentorContinuousCancel: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.MENTOR_CONTINUOUS_CANCEL, listener)
    return () => ipcRenderer.removeListener(IPC.MENTOR_CONTINUOUS_CANCEL, listener)
  },
  sendRegionSelected: (rect: MentorRegionRect): Promise<void> =>
    ipcRenderer.invoke(IPC.MENTOR_REGION_SELECTED, rect),
  onToggleListening: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.MENTOR_TOGGLE_LISTENING, listener)
    return () => ipcRenderer.removeListener(IPC.MENTOR_TOGGLE_LISTENING, listener)
  },
  onCopyAnswer: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.MENTOR_COPY_ANSWER, listener)
    return () => ipcRenderer.removeListener(IPC.MENTOR_COPY_ANSWER, listener)
  },
  onRecheckMentorAnswer: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.MENTOR_RECHECK_ANSWER, listener)
    return () => ipcRenderer.removeListener(IPC.MENTOR_RECHECK_ANSWER, listener)
  },
  onToggleMentorPanel: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.MENTOR_TOGGLE_PANEL, listener)
    return () => ipcRenderer.removeListener(IPC.MENTOR_TOGGLE_PANEL, listener)
  },
  mentorPanelOpen: (): Promise<void> =>
    ipcRenderer.invoke(IPC.MENTOR_PANEL_OPEN),
  mentorPanelClose: (): Promise<void> =>
    ipcRenderer.invoke(IPC.MENTOR_PANEL_CLOSE),

  // 平台信息(渲染进程可读)
  platform: 'darwin'
}

contextBridge.exposeInMainWorld('inview', api)

// 重新导出,保持向后兼容
export type { InviewAPI }
