/**
 * Preload API 类型定义(共享)
 * 主进程的 preload 实现,渲染进程通过 global.d.ts 消费
 */

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
} from './types'

export interface MentorCapturePayload {
  imageBase64: string
  imageWidth: number
  imageHeight: number
  captureMode: 'fullscreen' | 'region'
  captureTarget?: MentorCaptureTarget
}

export interface MentorRegionRect {
  x: number
  y: number
  width: number
  height: number
}

export interface MentorCaptureTarget {
  ownerName: string
  windowName: string
  bounds: MentorRegionRect
  windowId?: number
}

export interface VisionOcrLine {
  text: string
  confidence: number
  boundingBox: {
    x: number
    y: number
    width: number
    height: number
  }
}

export interface VisionOcrResult {
  text: string
  confidence: number
  lines: VisionOcrLine[]
  engine: 'apple-vision'
}

export interface MentorAccessibilityTextOptions {
  contentStartRatio?: number
  contentEndRatio?: number
}

export interface MentorAccessibilityTextResult {
  text: string
  lineCount: number
  nodeCount: number
  truncated: boolean
  programmingLanguage?: string
  engine: 'macos-accessibility'
}

export interface WindowResizeOptions {
  height: number
  width?: number
  animate?: boolean
}

export interface InviewAPI {
  /** 获取完整配置 */
  getConfig: () => Promise<AppConfig>
  /** 保存完整配置 */
  setConfig: (config: AppConfig) => Promise<boolean>
  /** 获取本机保存的统一个人认知—表达画像。 */
  getPersonalization: () => Promise<PersonalizationProfile>
  /** 保存画像并自动归档上一个版本。 */
  setPersonalization: (
    profile: PersonalizationProfile
  ) => Promise<PersonalizationProfile>
  getPersonalizationVersions: () => Promise<PersonalizationVersionSummary[]>
  rollbackPersonalization: (version: number) => Promise<PersonalizationProfile>
  getPersonalizationEvidence: () => Promise<PersonalizationFeedbackEvidence[]>
  upsertPersonalizationEvidence: (
    evidence: PersonalizationFeedbackEvidence
  ) => Promise<PersonalizationFeedbackEvidence[]>
  markPersonalizationEvidenceProcessed: (
    profileVersion: number
  ) => Promise<PersonalizationFeedbackEvidence[]>
  selectKnowledgeBaseFolder: () => Promise<string>
  /** 在主进程完成目录白名单与隐私过滤后读取抽样语料。 */
  readKnowledgeBaseCorpus: (rootPath: string) => Promise<KnowledgeBaseCorpus>
  /** 将用户明确选择的会议记录写入固定本地知识库，并自动执行维护。 */
  saveMeetingNote: (
    payload: MeetingNoteExportPayload
  ) => Promise<MeetingNoteSaveResult>
  retryMeetingKnowledgeMaintenance: (
    notePath: string
  ) => Promise<KnowledgeMaintenanceResult>
  /** 实时更新隐蔽状态(不写盘) */
  updateStealth: (state: StealthState) => Promise<boolean>
  /** 获取当前隐蔽状态 */
  getStealth: () => Promise<StealthState>

  // 窗口控制
  minimizeWindow: () => Promise<void>
  closeWindow: () => Promise<void>
  quitApp: () => Promise<void>
  toggleAlwaysOnTop: () => Promise<boolean>
  resizeWindow: (options: WindowResizeOptions) => Promise<boolean>

  // 设置面板焦点管理(切屏检测规避开启时,设置面板需临时恢复可聚焦)
  settingsOpen: () => Promise<boolean>
  settingsClose: () => Promise<boolean>
  /** 临时允许窗口接收键盘输入；关闭输入面板后需配对释放 */
  inputFocusAcquire: () => Promise<boolean>
  inputFocusRelease: () => Promise<boolean>

  // 系统音频源(采集腾讯会议/飞书等对方声音)
  getSystemAudioSources: () => Promise<Array<{ id: string; name: string }>>
  getSystemAudioPermission: () => Promise<string>

  // electron-audio-loopback: 临时启用/禁用系统音频 loopback
  enableLoopbackAudio: () => Promise<void>
  disableLoopbackAudio: () => Promise<void>

  // 简历文件解析
  parseResume: (data: ArrayBuffer, fileName: string) => Promise<string>
  /** 解析当前会话上传的参考资料，不保存原文件路径。 */
  parseReferenceDocument: (
    data: ArrayBuffer,
    fileName: string
  ) => Promise<string>

  // 屏幕文字识别助手
  captureMentor: () => Promise<void>
  captureMentorScreen: () => Promise<void>
  /** 使用本轮连续采集已锁定的区域再次截取，不改变前台窗口焦点。 */
  captureMentorRegion: () => Promise<void>
  /** 连续滚动采集使用：直接返回一帧，不触发单次 OCR 事件。 */
  captureMentorScreenFrame: (
    resetWindowLock?: boolean
  ) => Promise<MentorCapturePayload>
  captureMentorRegionFrame: () => Promise<MentorCapturePayload>
  /** 从已锁定窗口的 macOS Accessibility 树读取完整结构化文本。 */
  extractMentorWindowText: (
    options?: MentorAccessibilityTextOptions
  ) => Promise<MentorAccessibilityTextResult>
  /** 检查高精度窗口结构化文本所需的 macOS 辅助功能权限。 */
  getMentorAccessibilityPermission: () => Promise<boolean>
  /** 由用户主动触发 macOS 辅助功能授权提示。 */
  requestMentorAccessibilityPermission: () => Promise<boolean>
  /** 使用本地 macOS Vision 对长截图图块做高精度识别。 */
  recognizeMentorImage: (imageBase64: string) => Promise<VisionOcrResult>
  startMentorSelection: () => Promise<void>
  onMentorCapture: (callback: (payload: MentorCapturePayload) => void) => () => void
  onMentorCaptureError: (callback: (message: string) => void) => () => void
  onMentorDelayedCapture: (callback: () => void) => () => void
  onMentorStartSelection: (callback: () => void) => () => void
  onMentorContinuousCapture: (callback: () => void) => () => void
  onMentorContinuousSelection: (callback: () => void) => () => void
  onMentorContinuousFinish: (callback: () => void) => () => void
  onMentorContinuousUndo: (callback: () => void) => () => void
  onMentorContinuousCancel: (callback: () => void) => () => void
  sendRegionSelected: (rect: MentorRegionRect) => Promise<void>
  onToggleListening: (callback: () => void) => () => void
  onCopyAnswer: (callback: () => void) => () => void
  /** Mentor 面板打开时，Cmd+X 触发对当前答案的重新核对 */
  onRecheckMentorAnswer: (callback: () => void) => () => void
  /** 监听主进程的 Mentor 面板切换指令（Cmd+G 快捷键触发） */
  onToggleMentorPanel: (callback: () => void) => () => void
  /** 通知主进程 Mentor 面板已打开，需注册模式快捷键 */
  mentorPanelOpen: () => Promise<void>
  /** 通知主进程 Mentor 面板已关闭，需注销模式快捷键 */
  mentorPanelClose: () => Promise<void>

  // 平台信息(渲染进程可读)
  platform: string
}
