/**
 * 全局状态管理(Zustand)
 * 同时承载 AI Mentor 主流程编排的状态机
 */

import { create } from 'zustand'
import type {
  AnswerConfidence,
  AppConfig,
  AudioSourceType,
  ConversationSession,
  DetectedLanguage,
  DialogTurn,
  MeetingQARecord,
  PersonalizationFeedbackEvidence,
  PersonalizationProfile,
  PersonalizationVersionSummary,
  QAFeedbackDetail,
  QARecord,
  Region,
  RunStatus,
  SessionPreset,
  StealthState
} from '@shared/types'
import {
  createEmptyPersonalizationProfile,
  createEmptySessionPreset,
  DEFAULT_CONFIG
} from '@shared/types'
import type { MentorCaptureTarget } from '@shared/preload-api'
import { createSTTEngine, type STTEngine, type WhisperDualEngine } from '../services/stt'
import { chatOnce, chatStream, type ResponseLanguage } from '../services/llm'
import { recognizeScreenText } from '../services/ocr'
import { selectAccessibilityPrimaryContent } from '../services/accessibility-content'
import {
  appendScrollCaptureFrame,
  getScrollCaptureWarnings,
  recognizeLongCapture,
  type ScrollCaptureFrame
} from '../services/scroll-capture'
import type { OcrStitchStep } from '../services/ocr-stitch'
import {
  extractQuestion,
  buildAnswerMessages,
  buildTranslationMessages,
  buildContextCompressionMessages,
  getSpokenAnswerMaxTokens
} from '../services/question-detector'
import { looksLikeQaInvitation } from '../services/question-detector'
import { reviewAnswer, type InputQuality } from '../services/answer-quality'
import {
  buildPendingFeedbackInstructions,
  buildPersonalizationInstructions,
  distillPersonalization as runPersonalizationDistillation
} from '../services/personalization'
import {
  buildSessionPresetDetectionContext,
  buildSessionPresetInstructions,
  hasSessionPreset,
  normalizeSessionPreset
} from '../services/session-preset'

const HISTORY_STORAGE_KEY = 'inview-do:conversation-history:v2'
const LEGACY_HISTORY_STORAGE_KEY = 'inview-do:conversation-history:v1'
const MENTOR_SYSTEM_PROMPT =
  '你是一名严谨的 AI Mentor。先判断主要内容的类型，再按对应模式回答。' +
  '不要提及"截图""OCR""屏幕"等词，直接分析内容本身。' +
  '\n\n' +
  '==== 内容分类 =====\n' +
  '\n' +
  '【算法/编程题】信号：代码片段、函数签名、输入输出格式、数据结构（数组/链表/树/图/栈/堆/哈希）、' +
  '算法术语（排序/搜索/DP/回溯/贪心/BFS/DFS/递归/二分/滑动窗口/双指针）、' +
  '复杂度符号 O(n)/O(logn)、LeetCode 风格描述。' +
  '英文编程题属于此类，直接解答无需单独翻译。\n' +
  '\n' +
  '【翻译需求】信号：大段外文文本（英文/日文/韩文等），无明显题目结构（无选项/无填空/无问答），' +
  '内容为文章/文档/对话等连续文本。注意：外文试卷或编程题不属于翻译需求。\n' +
  '\n' +
  '【普通测试题】信号：选择题（A/B/C/D 或 ①②③④）、填空题（___/空白标记）、' +
  '判断题（√/×/正确/错误）、问答题（"简述""为什么""如何理解""试分析""比较""论证"）、' +
  '阅读理解（材料+题目）、数理化公式/计算、文史地知识点。\n' +
  '\n' +
  '【其他】报错日志（stack trace/Error/Exception）、配置文件、终端输出、笔记/聊天记录。\n' +
  '\n' +
  '==== 各类型回答格式 =====\n' +
  '\n' +
  '● 算法/编程题：\n' +
  '1. 一句话概括题目\n' +
  '2. 关键要求与约束（特别是“连续”“非空”“恰好 k 个”等不能丢失）\n' +
  '3. 解题思路（讲清正确性依据，不能只说“典型模板”）\n' +
  '4. 样例验证（先逐一验证原文中的完整测试用例，再输出代码）\n' +
  '5. 核心代码\n' +
  '6. 时间/空间复杂度\n' +
  '\n' +
  '● 翻译需求：\n' +
  '1. 中文翻译（保留段落结构，专业术语保留英文）\n' +
  '2. 如有难句或关键术语，附简短解释\n' +
  '\n' +
  '● 普通测试题：\n' +
  '1. 给出正确答案（选择题标选项+内容，填空题写填入内容，问答题先结论）\n' +
  '2. 每题附 1-3 句解析（为什么是这个答案、涉及的知识点）\n' +
  '3. 外文题干先给一句中文概括\n' +
  '\n' +
  '● 其他：\n' +
  '报错 → 含义和常见原因；配置 → 关键参数解释；笔记 → 总结提取\n' +
  '\n' +
  '==== 复合场景 =====\n' +
  '\n' +
  '【外文+题目】先给中文题意概括，再按对应题型完整解答，不单独输出翻译。\n' +
  '【多道题】按题号顺序逐一解答，每题用 "### 题 N" 标注。超过 5 道先解前 5 道，末尾提示可重新截取。\n' +
  '\n' +
  '==== 约束 =====\n' +
  '- 正确率优先于完整度和表达风格。先独立求解并核对关键结论，再组织答案\n' +
  '- 原文可能有识别错误；只有上下文能够唯一确定时才能修正，否则明确指出歧义，不能擅自补字或改题\n' +
  '- 输入内容已经过正文区域筛选，只分析连续正文、题干、选项、代码或主要文档内容，忽略残留的菜单、标签栏、地址栏和操作栏文字\n' +
  '- 缺少题干、选项、约束、公式、代码上下文等关键信息时，不给确定答案；使用“信息不足”说明缺少什么\n' +
  '- 选择题必须确保选项字母、选项内容和解析一致；计算题要复算关键步骤；代码题要检查边界条件和复杂度\n' +
  '- 算法题强制验证门禁：先扫描原文中的“示例/样例/输入/输出/Example/Input/Output”，提取所有完整测试用例；候选方案必须逐例推演并与期望输出比较\n' +
  '- 只要任一样例不通过，就必须丢弃当前算法并重新求解，禁止继续输出该思路或代码；最终答案的“样例验证”必须列出输入、期望输出、推演输出和结论\n' +
  '- 原文没有完整样例时要明确说明“未提取到完整样例”，再基于约束构造最小用例和边界用例自检，并标注为自构造用例\n' +
  '- 如果输入中提供了“当前编辑器编程语言”，核心代码必须严格使用该语言；不得根据题干语言、历史答案或个人偏好改用其他语言\n' +
  '- 使用贪心、二分答案或单调性时必须给出可验证的正确性依据；XOR 等区间扩展后不单调的运算，不能直接套用求和或最大值最小化模板\n' +
  '- 不得编造个人经历、数据、引用、来源或当前无法验证的事实。推断必须明确标注为推断\n' +
  '- 如有对话历史，仅将其作为辅助信息；若历史结论与当前题目或可靠知识冲突，应纠正错误而不是维持错误口径\n' +
  '- 单题不超过 15 句，技术术语保留英文原词\n' +
  '- 使用标准 Markdown 输出，可使用标题、列表、表格和代码块；不要输出原始 HTML\n' +
  '- 可读信息不足时宁可请求补充，也不要根据零散词句猜出一个看似完整的答案'

type MentorStatus =
  | 'idle'
  | 'input'
  | 'selecting'
  | 'ocr'
  | 'collecting'
  | 'stitching'
  | 'ai'
  | 'rechecking'
  | 'verifying'
  | 'done'
  | 'error'

interface MentorState {
  visible: boolean
  ocrText: string
  analysisText: string
  summary: string
  reasoning: string
  status: MentorStatus
  error: string
  hasContext?: boolean
  inputQuality: InputQuality
  ocrConfidence?: number
  programmingLanguage?: string
  answerConfidence: AnswerConfidence
  answerQualityNote: string
  answerVerified: boolean
  answerCorrected: boolean
}

interface SavedConversationState {
  version: 2
  active: ConversationSession
  archived: ConversationSession[]
}

interface ActiveMeetingQA {
  id: string
  preparedQuestionId: string
  question: string
  answer: string
  sourceTurnIds: string[]
  askedAt: number
  heardOwnQuestion: boolean
}

interface MentorCaptureOptions {
  imageWidth?: number
  imageHeight?: number
  captureMode?: 'fullscreen' | 'region'
  captureTarget?: MentorCaptureTarget
  analysisTextOverride?: string
  inputQualityOverride?: InputQuality
  ocrConfidenceOverride?: number
  programmingLanguage?: string
  previousAnswer?: string
  recheck?: boolean
  captureWarnings?: string[]
  preserveCaptureSession?: boolean
}

type MentorCaptureSource = 'fullscreen' | 'region'

interface MentorCaptureSession {
  id: string
  active: boolean
  source: MentorCaptureSource
  frames: ScrollCaptureFrame[]
  mergedText: string
  processing: boolean
  warnings: string[]
  lastStep: OcrStitchStep | null
  progressText: string
  captureTarget: MentorCaptureTarget | null
  tileCount?: number
  totalHeight?: number
  programmingLanguage?: string
  engine?: 'macos-accessibility' | 'apple-vision' | 'mixed'
}

type PersonalizationStatus = 'idle' | 'reading' | 'distilling' | 'saving' | 'error'

function createMentorCaptureSession(
  active = false,
  source: MentorCaptureSource = 'fullscreen'
): MentorCaptureSession {
  return {
    id: genId(),
    active,
    source,
    frames: [],
    mergedText: '',
    processing: false,
    warnings: [],
    lastStep: null,
    progressText: '',
    captureTarget: null
  }
}

function assessOcrInputQuality(
  confidence: number,
  readableLength: number,
  usedFallback: boolean
): InputQuality {
  if (
    usedFallback ||
    !Number.isFinite(confidence) ||
    confidence < 45 ||
    readableLength < 24
  ) {
    return 'low'
  }
  return confidence < 70 ? 'medium' : 'high'
}

function createConversationSession(): ConversationSession {
  const now = Date.now()
  return {
    id: genId(),
    title: '新对话',
    startedAt: now,
    updatedAt: now,
    qaHistory: [],
    dialogHistory: [],
    meetingQAs: [],
    meetingNoteSelectionIds: []
  }
}

function loadConversationState(): SavedConversationState {
  try {
    const raw =
      localStorage.getItem(HISTORY_STORAGE_KEY) ??
      localStorage.getItem(LEGACY_HISTORY_STORAGE_KEY)
    if (!raw) return { version: 2, active: createConversationSession(), archived: [] }
    const parsed = JSON.parse(raw) as {
      version?: number
      active?: ConversationSession
      archived?: ConversationSession[]
    }
    if ((parsed.version !== 1 && parsed.version !== 2) || !parsed.active) {
      throw new Error('unsupported history version')
    }
    const normalizeSession = (session: ConversationSession): ConversationSession => ({
      ...session,
      sessionPreset: normalizeSessionPreset(session.sessionPreset),
      meetingQAs: Array.isArray(session.meetingQAs) ? session.meetingQAs : [],
      meetingNoteSelectionIds: Array.isArray(session.meetingNoteSelectionIds)
        ? session.meetingNoteSelectionIds.filter(
            (item): item is string => typeof item === 'string'
          )
        : []
    })
    return {
      version: 2,
      active: normalizeSession(parsed.active),
      archived: Array.isArray(parsed.archived)
        ? parsed.archived.map(normalizeSession)
        : []
    }
  } catch {
    return { version: 2, active: createConversationSession(), archived: [] }
  }
}

const restoredConversation = loadConversationState()

interface InterviewStore {
  // 配置
  config: AppConfig
  configLoaded: boolean
  // 运行状态
  status: RunStatus
  listening: boolean
  // 当前问题/答案
  currentQuestion: string
  currentAnswer: string
  currentAnswerConfidence: AnswerConfidence
  currentAnswerQualityNote: string
  currentAnswerVerified: boolean
  currentAnswerCorrected: boolean
  // 混合模式下非中文答案的中文翻译
  currentTranslation: string
  currentDetectedLanguage: DetectedLanguage | null
  isTranslating: boolean
  // 当前思维链(思考模式开启时)
  currentReasoning: string
  // 是否正在输出思维链阶段(用于 UI 提示)
  isReasoning: boolean
  // 语音识别实时文本
  partialText: string
  // 当前识别到的说话者标记(如 [mic] / [system])
  transcriptSpeaker: 'mic' | 'system' | null
  // 对话历史(用于上下文关联)
  dialogHistory: DialogTurn[]
  // 问答记录
  qaHistory: QARecord[]
  sessionId: string
  sessionStartedAt: number
  contextSummary: string
  contextCompressedAt: number | null
  sessionFeedback: string
  sessionFeedbackUpdatedAt: number | null
  sessionPreset: SessionPreset
  meetingQAs: MeetingQARecord[]
  meetingNoteSelectionIds: string[]
  qaInvitation: string
  activeMeetingQA: ActiveMeetingQA | null
  visibleMeetingQAId: string | null
  archivedSessions: ConversationSession[]
  // 跨语言的个人认知—表达画像与持续反馈证据
  personalization: PersonalizationProfile
  personalizationLoaded: boolean
  personalizationVersions: PersonalizationVersionSummary[]
  personalizationEvidence: PersonalizationFeedbackEvidence[]
  personalizationStatus: PersonalizationStatus
  personalizationProgress: string
  personalizationError: string
  // 错误信息
  errorMessage: string
  // 设置面板可见
  settingsOpen: boolean
  historyPanelOpen: boolean
  // 音频源实时音量(0~1)
  micVolume: number
  systemVolume: number
  // 系统音频权限状态
  systemAudioPermission: 'granted' | 'denied' | 'not-determined' | 'unknown'
  // 屏幕文字识别助手浮窗
  mentor: MentorState
  mentorCapture: MentorCaptureSession

  // 内部引擎引用(不放入状态,避免序列化)
  _stt: STTEngine | null
  _abortAnswer: AbortController | null
  /** STT 累积缓冲区(等待停顿后再提交给问题检测) */
  _sttBuffer: string
  /** 停顿检测定时器 */
  _sttBufferTimer: ReturnType<typeof setTimeout> | null
  /** 缓冲区对应的说话者 */
  _sttBufferSpeaker: 'mic' | 'system' | null
  /** 被判定为尚未说完整的文本；下一段同一说话者语音会接在后面 */
  _pendingTranscript: string
  _pendingTranscriptSpeaker: 'mic' | 'system' | null
  _mentorAbort: AbortController | null
  _mentorRequestId: number
  _mentorRollingTimer: number | null
  _personalizationAbort: AbortController | null
  _personalizationTimer: ReturnType<typeof setTimeout> | null

  // 动作
  loadConfig: () => Promise<void>
  saveConfig: (config: AppConfig) => Promise<void>
  loadPersonalization: () => Promise<void>
  updatePersonalizationSettings: (
    partial: Partial<Pick<
      PersonalizationProfile,
      | 'enabled'
      | 'autoDistillFeedback'
      | 'feedbackDistillThreshold'
      | 'knowledgeBasePath'
    >>
  ) => Promise<void>
  distillPersonalization: (
    includeKnowledgeBase?: boolean,
    automatic?: boolean
  ) => Promise<void>
  rollbackPersonalization: (version: number) => Promise<void>
  setAnswerLanguage: (language: Region) => Promise<void>
  updateStealth: (partial: Partial<StealthState>) => Promise<void>
  setSettingsOpen: (open: boolean) => void
  setHistoryPanelOpen: (open: boolean) => void
  setAudioEnabled: (source: AudioSourceType, enabled: boolean) => Promise<void>
  setAudioVolume: (source: AudioSourceType, volume: number) => void
  setMentorError: (message: string) => void
  startMentorSelection: () => void
  startMentorContinuousCapture: (source: MentorCaptureSource) => void
  startMentorContinuousSelection: () => Promise<void>
  requestMentorContinuousCapture: () => Promise<void>
  collectMentorFrame: (
    imageBase64: string,
    options: Pick<
      MentorCaptureOptions,
      'imageWidth' | 'imageHeight' | 'captureMode' | 'captureTarget'
    >
  ) => Promise<void>
  finishMentorContinuousCapture: () => Promise<void>
  undoMentorContinuousCapture: () => void
  cancelMentorContinuousCapture: () => void
  runMentorText: (text: string) => Promise<void>
  runMentorCapture: (
    imageBase64: string,
    recognizedText?: string,
    options?: MentorCaptureOptions
  ) => Promise<void>
  recheckMentorAnswer: () => Promise<void>
  toggleMentorPanel: () => Promise<void>
  dismissMentor: () => Promise<void>

  startListening: () => Promise<void>
  stopListening: () => void
  clearCurrent: () => void
  clearHistory: () => void
  startNewConversation: () => void
  saveSessionPreset: (preset: SessionPreset) => void
  showPreparedQuestions: (invitation?: string) => void
  dismissPreparedQuestions: () => void
  startPreparedQuestionCapture: (preparedQuestionId: string) => void
  confirmPreparedQuestionAsked: () => void
  finishPreparedQuestionCapture: () => void
  cancelPreparedQuestionCapture: () => void
  dismissMeetingQAResult: () => void
  toggleMeetingNoteSelection: (sourceId: string) => void
  compressContext: () => Promise<void>
  updateQAFeedback: (
    sessionId: string,
    qaId: string,
    feedback: string,
    detail?: QAFeedbackDetail
  ) => void
  updateSessionFeedback: (sessionId: string, feedback: string) => void
}

function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function currentSessionSnapshot(state: InterviewStore): ConversationSession {
  const firstQuestion = state.qaHistory[state.qaHistory.length - 1]?.question
  const latestTimestamp = state.qaHistory[0]?.timestamp ?? state.sessionStartedAt
  return {
    id: state.sessionId,
    title:
      firstQuestion?.slice(0, 42) ||
      state.sessionPreset.topic.slice(0, 42) ||
      '新对话',
    startedAt: state.sessionStartedAt,
    updatedAt: Math.max(Date.now(), latestTimestamp),
    qaHistory: state.qaHistory,
    dialogHistory: state.dialogHistory,
    overallFeedback: state.sessionFeedback || undefined,
    overallFeedbackUpdatedAt: state.sessionFeedbackUpdatedAt || undefined,
    contextSummary: state.contextSummary || undefined,
    contextCompressedAt: state.contextCompressedAt || undefined,
    sessionPreset: hasSessionPreset(state.sessionPreset)
      ? state.sessionPreset
      : undefined,
    meetingQAs: state.meetingQAs,
    meetingNoteSelectionIds: state.meetingNoteSelectionIds
  }
}

function persistConversationState(state: InterviewStore): void {
  try {
    const saved: SavedConversationState = {
      version: 2,
      active: currentSessionSnapshot(state),
      archived: state.archivedSessions.slice(0, 30)
    }
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(saved))
  } catch (err) {
    console.warn('[history] 保存本地历史失败:', err)
  }
}

export const useInterviewStore = create<InterviewStore>((set, get) => ({
  config: structuredClone(DEFAULT_CONFIG),
  configLoaded: false,
  status: 'idle',
  listening: false,
  currentQuestion: '',
  currentAnswer: '',
  currentAnswerConfidence: 'unverified',
  currentAnswerQualityNote: '',
  currentAnswerVerified: false,
  currentAnswerCorrected: false,
  currentTranslation: '',
  currentDetectedLanguage: null,
  isTranslating: false,
  currentReasoning: '',
  isReasoning: false,
  partialText: '',
  transcriptSpeaker: null,
  dialogHistory: restoredConversation.active.dialogHistory ?? [],
  qaHistory: restoredConversation.active.qaHistory ?? [],
  sessionId: restoredConversation.active.id,
  sessionStartedAt: restoredConversation.active.startedAt,
  contextSummary: restoredConversation.active.contextSummary ?? '',
  contextCompressedAt: restoredConversation.active.contextCompressedAt ?? null,
  sessionFeedback: restoredConversation.active.overallFeedback ?? '',
  sessionFeedbackUpdatedAt: restoredConversation.active.overallFeedbackUpdatedAt ?? null,
  sessionPreset: normalizeSessionPreset(restoredConversation.active.sessionPreset),
  meetingQAs: restoredConversation.active.meetingQAs ?? [],
  meetingNoteSelectionIds:
    restoredConversation.active.meetingNoteSelectionIds ?? [],
  qaInvitation: '',
  activeMeetingQA: null,
  visibleMeetingQAId: null,
  archivedSessions: restoredConversation.archived,
  personalization: createEmptyPersonalizationProfile(),
  personalizationLoaded: false,
  personalizationVersions: [],
  personalizationEvidence: [],
  personalizationStatus: 'idle',
  personalizationProgress: '',
  personalizationError: '',
  errorMessage: '',
  settingsOpen: false,
  historyPanelOpen: false,
  micVolume: 0,
  systemVolume: 0,
  systemAudioPermission: 'unknown',
  mentor: {
    visible: false,
    ocrText: '',
    analysisText: '',
    summary: '',
    reasoning: '',
    status: 'input',
    error: '',
    hasContext: false,
    inputQuality: 'high',
    answerConfidence: 'unverified',
    answerQualityNote: '',
    answerVerified: false,
    answerCorrected: false
  },
  mentorCapture: createMentorCaptureSession(),
  _stt: null,
  _abortAnswer: null,
  _sttBuffer: '',
  _sttBufferTimer: null,
  _sttBufferSpeaker: null,
  _pendingTranscript: '',
  _pendingTranscriptSpeaker: null,
  _mentorAbort: null,
  _mentorRequestId: 0,
  _mentorRollingTimer: null,
  _personalizationAbort: null,
  _personalizationTimer: null,

  loadConfig: async () => {
    try {
      const config = await window.inview.getConfig()
      // 首次启动:LLM 或 STT 缺 Key 时自动弹出设置面板
      const needSetup = !config.llm.apiKey || (config.stt.provider !== 'web' && !config.stt.apiKey)
      set({ config, configLoaded: true, settingsOpen: needSetup })
    } catch (err) {
      set({ configLoaded: true, errorMessage: `加载配置失败: ${(err as Error).message}` })
    }
  },

  loadPersonalization: async () => {
    try {
      const [profile, loadedEvidence, versions] = await Promise.all([
        window.inview.getPersonalization(),
        window.inview.getPersonalizationEvidence(),
        window.inview.getPersonalizationVersions()
      ])
      let evidence = loadedEvidence
      const knownIds = new Set(evidence.map((item) => item.id))
      const state = get()
      const sessions = [currentSessionSnapshot(state), ...state.archivedSessions]
      for (const session of sessions) {
        for (const qa of session.qaHistory) {
          const hasEvidence = Boolean(
            qa.feedback?.trim() ||
            qa.feedbackDetail?.approved ||
            qa.feedbackDetail?.preferredAnswer?.trim() ||
            qa.feedbackDetail?.dimensions.length
          )
          const id = `qa:${session.id}:${qa.id}`
          if (!hasEvidence || knownIds.has(id)) continue
          evidence = await window.inview.upsertPersonalizationEvidence({
            id,
            kind: 'qa',
            sessionId: session.id,
            qaId: qa.id,
            question: qa.question,
            answer: qa.answer,
            feedback: qa.feedback ?? '',
            feedbackDetail: qa.feedbackDetail,
            createdAt: qa.feedbackUpdatedAt ?? qa.timestamp,
            updatedAt: qa.feedbackUpdatedAt ?? qa.timestamp
          })
          knownIds.add(id)
        }
        const sessionEvidenceId = `session:${session.id}`
        if (session.overallFeedback?.trim() && !knownIds.has(sessionEvidenceId)) {
          evidence = await window.inview.upsertPersonalizationEvidence({
            id: sessionEvidenceId,
            kind: 'session',
            sessionId: session.id,
            feedback: session.overallFeedback,
            createdAt: session.overallFeedbackUpdatedAt ?? session.updatedAt,
            updatedAt: session.overallFeedbackUpdatedAt ?? session.updatedAt
          })
          knownIds.add(sessionEvidenceId)
        }
      }
      const pendingFeedbackRecords = evidence.filter(
        (item) => !item.processedProfileVersion
      ).length
      set({
        personalization: {
          ...profile,
          sourceStats: {
            ...profile.sourceStats,
            feedbackRecords: evidence.length,
            approvedAnswers: evidence.filter(
              (item) => item.feedbackDetail?.approved
            ).length,
            pendingFeedbackRecords
          }
        },
        personalizationEvidence: evidence,
        personalizationVersions: versions,
        personalizationLoaded: true,
        personalizationStatus: 'idle',
        personalizationError: ''
      })
    } catch (error) {
      set({
        personalizationLoaded: true,
        personalizationStatus: 'error',
        personalizationError: `加载个人画像失败：${(error as Error).message}`
      })
    }
  },

  updatePersonalizationSettings: async (partial) => {
    try {
      const saved = await window.inview.setPersonalization({
        ...get().personalization,
        ...partial
      })
      const versions = await window.inview.getPersonalizationVersions()
      set({
        personalization: saved,
        personalizationVersions: versions,
        personalizationError: ''
      })
    } catch (error) {
      set({
        personalizationStatus: 'error',
        personalizationError: `保存个人画像设置失败：${(error as Error).message}`
      })
    }
  },

  distillPersonalization: async (includeKnowledgeBase = true, automatic = false) => {
    const state = get()
    if (
      state.personalizationStatus === 'reading' ||
      state.personalizationStatus === 'distilling' ||
      state.personalizationStatus === 'saving'
    ) {
      return
    }
    const pendingEvidence = state.personalizationEvidence.filter(
      (item) => !item.processedProfileVersion
    )
    if (automatic && pendingEvidence.length < state.personalization.feedbackDistillThreshold) {
      return
    }

    const controller = new AbortController()
    set({
      personalizationStatus: includeKnowledgeBase ? 'reading' : 'distilling',
      personalizationProgress: includeKnowledgeBase
        ? '正在读取隐私过滤后的知识库样本'
        : '正在增量吸收新的问答反馈',
      personalizationError: '',
      _personalizationAbort: controller
    })

    try {
      const freshState = get()
      const corpus =
        includeKnowledgeBase && freshState.personalization.knowledgeBasePath
          ? await window.inview.readKnowledgeBaseCorpus(
              freshState.personalization.knowledgeBasePath
            )
          : undefined
      if (controller.signal.aborted) return

      const sessions = [
        currentSessionSnapshot(freshState),
        ...freshState.archivedSessions
      ]
      const allQA = [
        ...freshState.qaHistory,
        ...freshState.archivedSessions.flatMap((session) => session.qaHistory)
      ]
      set({ personalizationStatus: 'distilling' })
      const distilled = await runPersonalizationDistillation({
        llmConfig: freshState.config.llm,
        existing: freshState.personalization,
        corpus,
        evidence: freshState.personalizationEvidence,
        qaHistory: allQA,
        sessionHistory: sessions,
        signal: controller.signal,
        onProgress: (progress) => {
          set({
            personalizationStatus:
              progress.stage === 'saving' ? 'saving' : 'distilling',
            personalizationProgress: progress.message
          })
        }
      })
      if (controller.signal.aborted) return

      set({
        personalizationStatus: 'saving',
        personalizationProgress: '正在保存新画像版本'
      })
      const saved = await window.inview.setPersonalization({
        ...distilled,
        sourceStats: {
          ...distilled.sourceStats,
          pendingFeedbackRecords: 0
        }
      })
      const [evidence, versions] = await Promise.all([
        window.inview.markPersonalizationEvidenceProcessed(saved.profileVersion),
        window.inview.getPersonalizationVersions()
      ])
      set({
        personalization: {
          ...saved,
          sourceStats: {
            ...saved.sourceStats,
            feedbackRecords: evidence.length,
            approvedAnswers: evidence.filter(
              (item) => item.feedbackDetail?.approved
            ).length,
            pendingFeedbackRecords: 0
          }
        },
        personalizationEvidence: evidence,
        personalizationVersions: versions,
        personalizationStatus: 'idle',
        personalizationProgress: `个人画像已更新到 v${saved.profileVersion}`,
        personalizationError: '',
        _personalizationAbort: null
      })
    } catch (error) {
      if (controller.signal.aborted) return
      set({
        personalizationStatus: 'error',
        personalizationError: `个人风格蒸馏失败：${(error as Error).message}`,
        personalizationProgress: '',
        _personalizationAbort: null
      })
    }
  },

  rollbackPersonalization: async (version) => {
    try {
      const saved = await window.inview.rollbackPersonalization(version)
      const versions = await window.inview.getPersonalizationVersions()
      set({
        personalization: saved,
        personalizationVersions: versions,
        personalizationStatus: 'idle',
        personalizationProgress: `已从 v${version} 恢复为新版本 v${saved.profileVersion}`,
        personalizationError: ''
      })
    } catch (error) {
      set({
        personalizationStatus: 'error',
        personalizationError: `回滚个人画像失败：${(error as Error).message}`
      })
    }
  },

  saveConfig: async (config) => {
    const previous = get()
    const sourceSelectionChanged =
      previous.config.stt.micEnabled !== config.stt.micEnabled ||
      previous.config.stt.systemEnabled !== config.stt.systemEnabled

    await window.inview.setConfig(config)
    set({ config })

    const activeEngine = get()._stt as WhisperDualEngine | null
    activeEngine?.setVolume('mic', config.stt.micVolume)
    activeEngine?.setVolume('system', config.stt.systemVolume)

    // 采集中的音源开关不能只改配置；重启双路引擎后新选择才真正生效。
    if (previous.listening && sourceSelectionChanged) {
      get().stopListening()
      await get().startListening()
    }
  },

  setAnswerLanguage: async (language) => {
    const previous = get().config
    if (previous.interview.region === language) return

    const next: AppConfig = {
      ...previous,
      interview: { ...previous.interview, region: language }
    }

    // 先更新界面,再持久化,让顶部切换立即响应。
    set({ config: next, errorMessage: '' })
    try {
      await window.inview.setConfig(next)
    } catch (err) {
      // 仅在期间没有再次切换语言时回滚,避免覆盖用户的更新选择。
      set((state) =>
        state.config.interview.region === language
          ? {
              config: {
                ...state.config,
                interview: { ...state.config.interview, region: previous.interview.region }
              },
              errorMessage: `保存回答语言失败: ${(err as Error).message}`
            }
          : { errorMessage: `保存回答语言失败: ${(err as Error).message}` }
      )
    }
  },

  updateStealth: async (partial) => {
    const next = { ...get().config.stealth, ...partial }
    await window.inview.updateStealth(next)
    set((s) => ({ config: { ...s.config, stealth: next } }))
  },

  setSettingsOpen: (open) => {
    set({ settingsOpen: open })
    if (open) {
      window.inview?.settingsOpen?.().catch(() => {})
    } else {
      window.inview?.settingsClose?.().catch(() => {})
    }
  },

  setHistoryPanelOpen: (open) => {
    if (get().historyPanelOpen === open) return
    if (open) {
      window.inview.inputFocusAcquire().catch(() => {})
    } else {
      window.inview.inputFocusRelease().catch(() => {})
    }
    set({ historyPanelOpen: open })
  },

  setAudioEnabled: async (source, enabled) => {
    const { config } = get()
    const next = { ...config.stt, [source === 'mic' ? 'micEnabled' : 'systemEnabled']: enabled }
    await get().saveConfig({ ...config, stt: next })
  },

  setAudioVolume: (source, volume) => {
    const { config, _stt } = get()
    const next = { ...config.stt, [source === 'mic' ? 'micVolume' : 'systemVolume']: volume }
    ;(_stt as WhisperDualEngine | null)?.setVolume?.(source, volume)
    set({ config: { ...config, stt: next } })
  },

  setMentorError: (message) => {
    set({
      mentor: {
        ...get().mentor,
        visible: true,
        status: 'error',
        error: message
      }
    })
  },

  startMentorSelection: () => {
    const state = get()
    state._mentorAbort?.abort()
    const continuous = state.mentorCapture.active
    set({
      mentor: {
        visible: true,
        ocrText: continuous ? state.mentorCapture.mergedText : '',
        analysisText: continuous ? state.mentorCapture.mergedText : '',
        summary: '',
        reasoning: '',
        status: 'selecting',
        error: '',
        hasContext: false,
        inputQuality: 'high',
        ocrConfidence: undefined,
        answerConfidence: 'unverified',
        answerQualityNote: '',
        answerVerified: false,
        answerCorrected: false
      },
      mentorCapture: continuous
        ? state.mentorCapture
        : createMentorCaptureSession(),
      _mentorAbort: null,
      _mentorRequestId: state._mentorRequestId + 1
    })
  },

  startMentorContinuousCapture: (source) => {
    const state = get()
    state._mentorAbort?.abort()
    if (state._mentorRollingTimer !== null) {
      window.clearInterval(state._mentorRollingTimer)
    }
    set({
      mentor: {
        visible: true,
        ocrText: '',
        analysisText: '',
        summary: '',
        reasoning: '',
        status: 'collecting',
        error: '',
        hasContext: false,
        inputQuality: 'high',
        ocrConfidence: undefined,
        answerConfidence: 'unverified',
        answerQualityNote: '',
        answerVerified: false,
        answerCorrected: false
      },
      mentorCapture: createMentorCaptureSession(true, source),
      _mentorAbort: null,
      _mentorRequestId: state._mentorRequestId + 1,
      _mentorRollingTimer: null
    })
  },

  startMentorContinuousSelection: async () => {
    get().startMentorContinuousCapture('region')
    try {
      await window.inview.startMentorSelection()
    } catch (error) {
      get().cancelMentorContinuousCapture()
      get().setMentorError(`进入连续选区失败：${(error as Error).message}`)
    }
  },

  requestMentorContinuousCapture: async () => {
    let state = get()
    if (!state.mentorCapture.active) {
      state.startMentorContinuousCapture('fullscreen')
      state = get()
    }
    if (state.mentorCapture.processing || state.mentor.status === 'selecting') return

    const captureId = state.mentorCapture.id
    set({
      mentorCapture: {
        ...state.mentorCapture,
        processing: true,
        progressText:
          state.mentorCapture.frames.length === 0
            ? '正在获取首帧…'
            : '正在后台采样…'
      },
      mentor: {
        ...state.mentor,
        status: 'collecting',
        error: ''
      }
    })

    try {
      const payload =
        state.mentorCapture.source === 'region'
          ? await window.inview.captureMentorRegionFrame()
          : await window.inview.captureMentorScreenFrame(
              state.mentorCapture.frames.length === 0
            )
      await get().collectMentorFrame(payload.imageBase64, {
        imageWidth: payload.imageWidth,
        imageHeight: payload.imageHeight,
        captureMode: payload.captureMode,
        captureTarget: payload.captureTarget
      })
    } catch (error) {
      const current = get()
      if (current.mentorCapture.id !== captureId) return
      set({
        mentorCapture: {
          ...current.mentorCapture,
          processing: false,
          progressText: ''
        },
        mentor: {
          ...current.mentor,
          status: 'collecting',
          error: `连续截取失败：${(error as Error).message}`
        }
      })
    }
  },

  collectMentorFrame: async (imageBase64, options) => {
    const initial = get()
    if (!initial.mentorCapture.active) return
    if (
      options.captureMode &&
      options.captureMode !== initial.mentorCapture.source
    ) {
      set({
        mentorCapture: {
          ...initial.mentorCapture,
          processing: false,
          progressText: ''
        },
        mentor: {
          ...initial.mentor,
          status: 'collecting',
          error:
            initial.mentorCapture.source === 'region'
              ? '本轮已锁定固定选区，后台会继续截取相同区域'
              : '本轮已锁定前台目标窗口，后台会继续截取该窗口'
        }
      })
      return
    }
    const captureId = initial.mentorCapture.id
    set({
      mentorCapture: {
        ...initial.mentorCapture,
        processing: true,
        progressText:
          initial.mentorCapture.frames.length === 0
            ? '正在记录首帧…'
            : '正在比对滚动位置…'
      },
      mentor: {
        ...initial.mentor,
        status: 'collecting',
        error: ''
      }
    })

    try {
      if (!options.imageWidth || !options.imageHeight || !options.captureMode) {
        throw new Error('截屏尺寸信息不完整')
      }
      const appended = await appendScrollCaptureFrame(
        initial.mentorCapture.frames,
        {
          imageBase64,
          imageWidth: options.imageWidth,
          imageHeight: options.imageHeight,
          captureMode: options.captureMode
        }
      )
      const current = get()
      if (
        !current.mentorCapture.active ||
        current.mentorCapture.id !== captureId
      ) {
        return
      }

      const mentorCapture: MentorCaptureSession = {
        ...current.mentorCapture,
        frames: appended.frames,
        processing: false,
        warnings: appended.warnings,
        lastStep: appended.lastStep,
        captureTarget:
          options.captureTarget ?? current.mentorCapture.captureTarget,
        progressText: appended.accepted
          ? `已记录 ${appended.frames.length} 个关键帧，继续滚动即可`
          : `已记录 ${appended.frames.length} 个关键帧，等待页面继续滚动`
      }
      const rollingTimer =
        current._mentorRollingTimer ??
        window.setInterval(() => {
          const latest = get()
          if (
            latest.mentorCapture.active &&
            !latest.mentorCapture.processing &&
            latest.mentor.status === 'collecting'
          ) {
            void latest.requestMentorContinuousCapture()
          }
        }, 450)
      set({
        mentorCapture,
        _mentorRollingTimer: rollingTimer,
        mentor: {
          ...current.mentor,
          ocrText: '',
          analysisText: '',
          summary: '',
          reasoning: '',
          status: 'collecting',
          error: '',
          inputQuality: appended.warnings.length > 0 ? 'low' : 'high',
          ocrConfidence: undefined,
          answerConfidence: 'unverified',
          answerQualityNote: '',
          answerVerified: false,
          answerCorrected: false
        }
      })
    } catch (error) {
      const current = get()
      if (current.mentorCapture.id !== captureId) return
      set({
        mentorCapture: {
          ...current.mentorCapture,
          processing: false,
          progressText: ''
        },
        mentor: {
          ...current.mentor,
          status: 'collecting',
          error: `滚动捕获失败：${(error as Error).message}`
        }
      })
    }
  },

  finishMentorContinuousCapture: async () => {
    const initial = get()
    const captureId = initial.mentorCapture.id
    if (!initial.mentorCapture.active) return
    if (initial._mentorRollingTimer !== null) {
      window.clearInterval(initial._mentorRollingTimer)
    }
    set({
      _mentorRollingTimer: null,
      mentorCapture: {
        ...initial.mentorCapture,
        progressText: '正在完成最后一次采样…'
      }
    })

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const current = get()
      if (
        current.mentorCapture.id !== captureId ||
        !current.mentorCapture.active
      ) {
        return
      }
      if (!current.mentorCapture.processing) break
      await new Promise<void>((resolve) => window.setTimeout(resolve, 100))
    }

    const ready = get()
    if (ready.mentorCapture.id !== captureId) return
    if (ready.mentorCapture.processing) {
      set({
        mentorCapture: {
          ...ready.mentorCapture,
          progressText: ''
        },
        mentor: {
          ...ready.mentor,
          error: '后台采样尚未结束，请稍后再次按 Control+Command+Enter'
        }
      })
      return
    }

    set({
      mentorCapture: {
        ...ready.mentorCapture,
        processing: true,
        progressText: '正在收尾并生成长截图…'
      },
      mentor: {
        ...ready.mentor,
        status: 'stitching',
        error: ''
      }
    })

    let detectedProgrammingLanguage: string | undefined
    try {
      if (
        ready.mentorCapture.source === 'fullscreen' &&
        ready.mentorCapture.captureTarget
      ) {
        set({
          mentorCapture: {
            ...get().mentorCapture,
            progressText: '正在读取窗口结构化文本…'
          }
        })
        try {
          const accessibility =
            await window.inview.extractMentorWindowText({
              contentStartRatio: 0,
              contentEndRatio: 1
            })
          detectedProgrammingLanguage = accessibility.programmingLanguage
          const selected = selectAccessibilityPrimaryContent(
            accessibility.text,
            ready.mentorCapture.captureTarget.windowName
          )
          const readableLength = selected.text.replace(/\s/gu, '').length
          const isLeetCode =
            /leetcode|力扣/iu.test(
              ready.mentorCapture.captureTarget.windowName
            )
          const hasCompleteLeetCodeProblem =
            !isLeetCode ||
            (
              selected.isolatedPrimaryContent &&
              /示例\s*1|example\s*1/iu.test(selected.text) &&
              /输入\s*[:：]|input\s*:/iu.test(selected.text) &&
              /输出\s*[:：]|output\s*:/iu.test(selected.text) &&
              /提示\s*[:：]|constraints\s*:/iu.test(selected.text)
            )
          const reliable =
            readableLength >= 160 &&
            selected.lineCount >= 12 &&
            hasCompleteLeetCodeProblem &&
            (!accessibility.truncated || selected.isolatedPrimaryContent)
          if (reliable) {
            const current = get()
            if (current.mentorCapture.id !== captureId) return
            const completedSession: MentorCaptureSession = {
              ...current.mentorCapture,
              active: false,
              mergedText: selected.text,
              processing: false,
              warnings: [],
              progressText: '',
              programmingLanguage: detectedProgrammingLanguage,
              engine: 'macos-accessibility'
            }
            set({ mentorCapture: completedSession })
            await get().runMentorCapture('', selected.text, {
              analysisTextOverride: selected.text,
              inputQualityOverride: 'high',
              ocrConfidenceOverride: 100,
              programmingLanguage: detectedProgrammingLanguage,
              captureWarnings: [],
              preserveCaptureSession: true
            })
            return
          }
          console.warn(
            '[mentor] Accessibility 文本不足，回退长截图 OCR:',
            {
              readableLength,
              lineCount: selected.lineCount,
              truncated: accessibility.truncated,
              isolatedPrimaryContent: selected.isolatedPrimaryContent,
              hasCompleteLeetCodeProblem
            }
          )
        } catch (error) {
          console.warn('[mentor] Accessibility 读取失败，回退长截图 OCR:', error)
        }
      }

      set({
        mentorCapture: {
          ...get().mentorCapture,
          progressText: '结构化文本不可用，正在生成长截图…'
        }
      })
      const payload =
        ready.mentorCapture.source === 'region'
          ? await window.inview.captureMentorRegionFrame()
          : await window.inview.captureMentorScreenFrame()
      const beforeFinal = get()
      if (beforeFinal.mentorCapture.id !== captureId) return
      const appended = await appendScrollCaptureFrame(
        beforeFinal.mentorCapture.frames,
        payload
      )
      const composingSession: MentorCaptureSession = {
        ...beforeFinal.mentorCapture,
        active: false,
        frames: appended.frames,
        warnings: appended.warnings,
        lastStep: appended.lastStep,
        captureTarget:
          payload.captureTarget ?? beforeFinal.mentorCapture.captureTarget,
        processing: true,
        progressText: '正在生成长截图图块…'
      }
      set({ mentorCapture: composingSession })

      const recognition = await recognizeLongCapture(
        composingSession.frames,
        composingSession.warnings,
        (completed, total) => {
          const current = get()
          if (current.mentorCapture.id !== captureId) return
          set({
            mentorCapture: {
              ...current.mentorCapture,
              progressText: `正在识别长截图 ${completed}/${total}…`
            }
          })
        }
      )
      if (!recognition.text.trim()) {
        throw new Error('长截图中未识别到可分析的文字')
      }

      const current = get()
      if (current.mentorCapture.id !== captureId) return
      const completedSession: MentorCaptureSession = {
        ...current.mentorCapture,
        active: false,
        mergedText: recognition.text,
        processing: false,
        warnings: recognition.warnings,
        progressText: '',
        tileCount: recognition.tileCount,
        totalHeight: recognition.totalHeight,
        programmingLanguage: detectedProgrammingLanguage,
        engine: recognition.engine
      }
      set({ mentorCapture: completedSession })
      await get().runMentorCapture('', recognition.text, {
        analysisTextOverride: recognition.text,
        inputQualityOverride: recognition.inputQuality,
        ocrConfidenceOverride: recognition.confidence,
        programmingLanguage: detectedProgrammingLanguage,
        captureWarnings: recognition.warnings,
        preserveCaptureSession: true
      })
    } catch (error) {
      const current = get()
      if (current.mentorCapture.id !== captureId) return
      set({
        mentorCapture: {
          ...current.mentorCapture,
          active: true,
          processing: false,
          progressText: ''
        },
        mentor: {
          ...current.mentor,
          status: 'collecting',
          error: `长截图生成或识别失败：${(error as Error).message}`
        }
      })
    }
  },

  undoMentorContinuousCapture: () => {
    const state = get()
    const session = state.mentorCapture
    if (!session.active || session.processing || session.frames.length === 0) return
    const frames = session.frames.slice(0, -1)
    const mentorCapture: MentorCaptureSession = {
      ...session,
      frames,
      mergedText: '',
      warnings: getScrollCaptureWarnings(frames),
      lastStep: null,
      progressText:
        frames.length > 0
          ? `已撤销最后一个关键帧，剩余 ${frames.length} 个`
          : '已撤销全部关键帧，继续滚动即可重新采集'
    }
    set({
      mentorCapture,
      mentor: {
        ...state.mentor,
        ocrText: '',
        analysisText: '',
        status: 'collecting',
        error: '',
        inputQuality: mentorCapture.warnings.length > 0 ? 'low' : 'high',
        ocrConfidence: undefined
      }
    })
  },

  cancelMentorContinuousCapture: () => {
    const state = get()
    if (!state.mentorCapture.active && state.mentorCapture.frames.length === 0) return
    if (state._mentorRollingTimer !== null) {
      window.clearInterval(state._mentorRollingTimer)
    }
    set({
      mentorCapture: createMentorCaptureSession(),
      _mentorRollingTimer: null,
      mentor: {
        ...state.mentor,
        ocrText: '',
        analysisText: '',
        summary: '',
        reasoning: '',
        status: 'idle',
        error: '',
        inputQuality: 'high',
        ocrConfidence: undefined
      }
    })
  },

  runMentorText: async (text) => {
    const normalizedText = text.trim()
    if (!normalizedText) {
      get().setMentorError('请输入要分析的文字内容')
      return
    }

    await get().runMentorCapture('', normalizedText)
  },

  runMentorCapture: async (imageBase64, recognizedText, options) => {
    const initialState = get()
    initialState._mentorAbort?.abort()
    if (
      !options?.preserveCaptureSession &&
      initialState._mentorRollingTimer !== null
    ) {
      window.clearInterval(initialState._mentorRollingTimer)
    }
    const previousAnswer = options?.previousAnswer?.trim() ?? ''
    const isRecheck =
      options?.recheck === true &&
      Boolean(previousAnswer) &&
      Boolean(options.analysisTextOverride?.trim())

    const requestId = initialState._mentorRequestId + 1

    set({
      mentor: {
        visible: true,
        ocrText: isRecheck ? initialState.mentor.ocrText : '',
        analysisText: isRecheck ? options?.analysisTextOverride?.trim() ?? '' : '',
        summary: '',
        reasoning: '',
        status: isRecheck
          ? 'rechecking'
          : recognizedText === undefined
            ? 'ocr'
            : 'ai',
        error: '',
        hasContext: false,
        inputQuality: options?.inputQualityOverride ?? 'high',
        ocrConfidence: options?.ocrConfidenceOverride,
        programmingLanguage: options?.programmingLanguage,
        answerConfidence: 'unverified',
        answerQualityNote: '',
        answerVerified: false,
        answerCorrected: false
      },
      mentorCapture: options?.preserveCaptureSession
        ? initialState.mentorCapture
        : createMentorCaptureSession(),
      _mentorAbort: null,
      _mentorRequestId: requestId,
      _mentorRollingTimer: options?.preserveCaptureSession
        ? initialState._mentorRollingTimer
        : null
    })

    const isActive = (): boolean => {
      const state = get()
      return state._mentorRequestId === requestId && state.mentor.visible
    }

    if (!isActive()) return

    let ocrText = recognizedText?.trim() ?? ''
    let analysisText = options?.analysisTextOverride?.trim() || ocrText
    let inputQuality: InputQuality = options?.inputQualityOverride ?? 'high'
    let ocrConfidence: number | undefined = options?.ocrConfidenceOverride
    if (recognizedText === undefined) {
      try {
        const recognition = await recognizeScreenText(imageBase64, {
          imageWidth: options?.imageWidth,
          imageHeight: options?.imageHeight,
          filterTopChrome: options?.captureMode !== 'region'
        })
        ocrText = recognition.rawText
        analysisText = recognition.analysisText
        ocrConfidence = recognition.confidence
        const readableLength = analysisText.replace(/\s/gu, '').length
        inputQuality = assessOcrInputQuality(
          recognition.confidence,
          readableLength,
          recognition.usedFallback
        )
      } catch (err) {
        if (!isActive()) return
        set({
          mentor: {
            ...get().mentor,
            status: 'error',
            error: `OCR 识别失败：${(err as Error).message}`
          }
        })
        return
      }
    }

    if (!isActive()) return
    if (!ocrText && !analysisText) {
      set({
        mentor: {
          ...get().mentor,
          status: 'error',
          error:
            recognizedText === undefined
              ? '未在屏幕中识别到可分析的文字内容'
              : '请输入要分析的文字内容'
        }
      })
      return
    }
    if (!ocrText) ocrText = analysisText
    if (!analysisText) analysisText = ocrText

    const controller = new AbortController()
    let timedOut = false
    let fullSummary = ''
    let fullReasoning = ''
    let aiError: Error | null = null
    let answerConfidence: AnswerConfidence = 'unverified'
    let answerQualityNote = ''
    let answerVerified = false
    let answerCorrected = false
    const timeout = window.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, 45_000)

    const { qaHistory, dialogHistory } = get()
    // qaHistory 以新到旧保存，发送给模型时恢复为自然的时间顺序。
    const recentQA = qaHistory.slice(0, 3).reverse()
    const recentDialog = dialogHistory.slice(-5)
    const hasContext = recentQA.length > 0 || recentDialog.length > 0
    const contextSections: string[] = []

    if (recentQA.length > 0) {
      contextSections.push(
        `最近问答：\n${recentQA
          .map((qa) => `Q: ${qa.question}\nA: ${qa.answer}`)
          .join('\n\n')}`
      )
    }
    if (recentDialog.length > 0) {
      const dialogText = recentDialog
        .map((turn) => {
          const roleLabel =
            turn.role === 'interviewer'
              ? '提问者'
              : turn.role === 'self'
                ? '我'
                : turn.role === 'candidate'
                  ? '回答者'
                  : '未知'
          return `[${roleLabel}] ${turn.text}`
        })
        .join('\n')
      contextSections.push(`最近对话转写：\n${dialogText}`)
    }

    const captureWarning =
      options?.captureWarnings && options.captureWarnings.length > 0
        ? `连续内容校验提示：${options.captureWarnings.join('；')}。不得擅自补全可能缺失的内容。\n`
        : ''
    const primaryContent =
      `以下是从主要内容区域提取的文字。输入质量为 ${inputQuality}。${captureWarning}将其作为唯一分析对象，忽略可能残留的菜单、标签栏、地址栏或操作栏内容：\n` +
      `<primary_content>\n${analysisText}\n</primary_content>`
    const programmingLanguageContext = options?.programmingLanguage
      ? `当前编辑器编程语言（来自页面语言选择框，必须严格遵守）：${options.programmingLanguage}\n\n`
      : ''
    const contextualMessage = hasContext
      ? `${programmingLanguageContext}当前对话上下文（仅用于关联，不要覆盖当前主要内容）：\n${contextSections.join('\n\n')}\n\n${primaryContent}`
      : `${programmingLanguageContext}${primaryContent}`
    const mentorUserMessage = isRecheck
      ? `用户已明确标记上一版解答错误。必须从题目原文重新独立求解，不得沿用上一版的算法、模板判断或结论。

重新核对要求：
1. 重新提取题目目标、全部硬约束与容易遗漏的关键词。
2. 如果是算法题，先从原文提取所有完整样例；在输出新代码前，逐例推演候选算法的实际输出并与期望输出比较。
3. 任一样例失败就丢弃候选方案并重新求解。特别检查贪心选择、二分检查函数、单调性、恰好 k 个与至多 k 个是否被混淆。
4. 最终答案必须指出上一版错误的根因，并在代码前给出“样例验证”表格。

<previous_wrong_answer>
${previousAnswer.slice(0, 12_000)}
</previous_wrong_answer>

${contextualMessage}`
      : contextualMessage

    set({
      mentor: {
        ...get().mentor,
        ocrText,
        analysisText,
        status: isRecheck ? 'rechecking' : 'ai',
        error: '',
        hasContext,
        inputQuality,
        ocrConfidence
      },
      _mentorAbort: controller
    })

    try {
      await chatStream(
        get().config.llm,
        [
          { role: 'system', content: MENTOR_SYSTEM_PROMPT },
          { role: 'user', content: mentorUserMessage }
        ],
        {
          onReasoning: (delta) => {
            if (!isActive()) return
            fullReasoning += delta
            set({
              mentor: {
                ...get().mentor,
                reasoning: fullReasoning
              }
            })
          },
          onChunk: (delta) => {
            if (!isActive()) return
            fullSummary += delta
          },
          onDone: (summary, reasoning) => {
            fullSummary = summary
            fullReasoning = reasoning || fullReasoning
            if (!isActive()) return
            set({
              mentor: {
                ...get().mentor,
                reasoning: fullReasoning
              }
            })
          },
          onError: (err) => {
            aiError = err
          }
        },
        controller.signal,
        undefined
      )

      if (!timedOut && !aiError && fullSummary.trim() && isActive()) {
        set({
          mentor: {
            ...get().mentor,
            status: 'verifying'
          }
        })
        try {
          const review = await reviewAnswer({
            llmConfig: get().config.llm,
            scope: 'mentor',
            subject: options?.programmingLanguage
              ? `当前编辑器编程语言：${options.programmingLanguage}\n\n${analysisText}`
              : analysisText,
            draftAnswer: fullSummary,
            evidence: contextSections.join('\n\n'),
            inputQuality,
            recheckRequested: isRecheck,
            signal: controller.signal
          })
          fullSummary = review.finalAnswer
          answerConfidence = review.confidence
          answerQualityNote = isRecheck ? `重新核对：${review.note}` : review.note
          answerVerified = review.verified
          answerCorrected = review.corrected
        } catch (err) {
          answerQualityNote = `答案复核失败：${(err as Error).message}`
        }
      }
    } finally {
      window.clearTimeout(timeout)
    }

    if (!isActive()) return

    if (timedOut) {
      set({
        mentor: {
          ...get().mentor,
          summary: fullSummary,
          reasoning: fullReasoning,
          status: 'error',
          error: fullSummary
            ? 'AI 生成或复核已在 45 秒后自动停止，以上内容尚未完成可靠性校验'
            : 'AI 生成或复核超时，已在 45 秒后自动取消',
          answerConfidence: 'unverified',
          answerQualityNote: '请求超时，未完成独立复核',
          answerVerified: false,
          answerCorrected: false
        },
        _mentorAbort: null
      })
      return
    }

    if (aiError) {
      set({
        mentor: {
          ...get().mentor,
          status: 'error',
          error: `AI 分析失败：${(aiError as Error).message}`
        },
        _mentorAbort: null
      })
      return
    }

    set({
      mentor: {
        ...get().mentor,
        summary: fullSummary,
        reasoning: fullReasoning,
        status: fullSummary.trim() ? 'done' : 'error',
        error: fullSummary.trim() ? '' : 'AI 未返回摘要内容',
        answerConfidence,
        answerQualityNote,
        answerVerified,
        answerCorrected
      },
      _mentorAbort: null
    })
  },

  recheckMentorAnswer: async () => {
    const state = get()
    const source = state.mentor.analysisText.trim()
    const previousAnswer = state.mentor.summary.trim()
    if (!source || !previousAnswer) {
      get().setMentorError('当前没有可重新核对的题目和答案，请先完成一次分析')
      return
    }

    await get().runMentorCapture('', state.mentor.ocrText || source, {
      analysisTextOverride: source,
      inputQualityOverride: state.mentor.inputQuality,
      ocrConfidenceOverride: state.mentor.ocrConfidence,
      programmingLanguage: state.mentor.programmingLanguage,
      previousAnswer,
      recheck: true,
      captureWarnings: state.mentorCapture.warnings,
      preserveCaptureSession: state.mentorCapture.frames.length > 0
    })
  },

  toggleMentorPanel: async () => {
    const {
      mentor: { visible }
    } = get()
    if (visible) {
      await get().dismissMentor()
      return
    }

    set({
      mentor: {
        ...get().mentor,
        visible: true,
        status: 'idle',
        error: ''
      }
    })
    try {
      await window.inview.mentorPanelOpen()
    } catch (err) {
      console.warn('[mentor] 通知主进程面板打开失败:', err)
    }
  },

  dismissMentor: async () => {
    const state = get()
    state._mentorAbort?.abort()
    if (state._mentorRollingTimer !== null) {
      window.clearInterval(state._mentorRollingTimer)
    }

    set({
      mentor: {
        visible: false,
        ocrText: '',
        analysisText: '',
        summary: '',
        reasoning: '',
        status: 'idle',
        error: '',
        hasContext: false,
        inputQuality: 'high',
        ocrConfidence: undefined,
        answerConfidence: 'unverified',
        answerQualityNote: '',
        answerVerified: false,
        answerCorrected: false
      },
      mentorCapture: createMentorCaptureSession(),
      _mentorAbort: null,
      _mentorRequestId: state._mentorRequestId + 1,
      _mentorRollingTimer: null
    })

    try {
      await window.inview.mentorPanelClose()
    } catch (err) {
      console.warn('[mentor] 通知主进程面板关闭失败:', err)
    }
  },

  startListening: async () => {
    const state = get()
    if (state.listening) return

    const { config } = state
    // 重置音量
    set({ micVolume: 0, systemVolume: 0, errorMessage: '' })

    // 预检系统音频权限
    if (config.stt.systemEnabled) {
      try {
        const permission = await window.inview.getSystemAudioPermission()
        set({ systemAudioPermission: permission as any })
      } catch {
        set({ systemAudioPermission: 'unknown' })
      }
    }

    const engine = createSTTEngine(config.stt, {
      onPartial: (text) => set({ partialText: text }),
      onFinal: (text) => {
        // 解析 [mic] / [system] 前缀
        const speakerMatch = text.match(/^\[(mic|system)\]\s*/)
        const speaker = (speakerMatch?.[1] as 'mic' | 'system') || 'mic'
        const cleanText = speakerMatch ? text.slice(speakerMatch[0].length) : text
        if (!cleanText.trim()) return

        // Whisper 已按真实静音切出完整语音段；这里只做短暂合并，避免极近的回调被拆开。
        // Web Speech 的 final 边界不稳定，因此仍保留更长等待。
        const PAUSE_MS = get().config.stt.provider === 'web' ? 2200 : 350

        const state = get()
        const prevBuffer = state._sttBuffer
        const prevSpeaker = state._sttBufferSpeaker
        const pendingPrefix =
          state._pendingTranscriptSpeaker === speaker ? state._pendingTranscript : ''

        // 如果说话者变了,立即提交之前的缓冲区
        if (prevSpeaker && prevSpeaker !== speaker && prevBuffer.trim()) {
          flushSttBuffer(get, set)
        }

        // 累积到缓冲区
        const parts = [
          pendingPrefix,
          prevSpeaker === speaker ? prevBuffer : '',
          cleanText
        ].filter((part) => part.trim())
        const newBuffer = parts.join(' ')
        set({
          _sttBuffer: newBuffer,
          _sttBufferSpeaker: speaker,
          _pendingTranscript: pendingPrefix ? '' : state._pendingTranscript,
          _pendingTranscriptSpeaker: pendingPrefix ? null : state._pendingTranscriptSpeaker,
          partialText: newBuffer,
          transcriptSpeaker: speaker
        })

        // 清除旧定时器,设置新定时器
        if (state._sttBufferTimer) clearTimeout(state._sttBufferTimer)
        const timer = setTimeout(() => {
          flushSttBuffer(get, set)
        }, PAUSE_MS)
        set({ _sttBufferTimer: timer })
      },
      onError: (err) => {
        set({ errorMessage: err.message, status: 'error' })
      },
      onStatus: (st) => {
        if (st === 'listening') {
          set({ status: 'listening', listening: true, errorMessage: '' })
        } else if (st === 'stopped') {
          set({ listening: false, status: 'idle' })
        }
      },
      onVolume: (source, volume) => {
        if (source === 'mic') {
          set({ micVolume: volume })
        } else {
          set({ systemVolume: volume })
        }
      }
    })

    try {
      await engine.start()
      const dual = engine as WhisperDualEngine
      if (config.stt.systemEnabled) {
        set({ systemAudioPermission: dual.getState().systemPermission as any })
      }
      set({ _stt: engine })
    } catch (err) {
      const msg = (err as Error).message
      set({ errorMessage: msg, status: 'error' })
    }
  },

  stopListening: () => {
    const { _stt, _abortAnswer, _sttBufferTimer } = get()
    _stt?.stop()
    _abortAnswer?.abort()
    if (_sttBufferTimer) clearTimeout(_sttBufferTimer)
    set({
      _stt: null,
      _abortAnswer: null,
      _sttBuffer: '',
      _sttBufferTimer: null,
      _sttBufferSpeaker: null,
      _pendingTranscript: '',
      _pendingTranscriptSpeaker: null,
      listening: false,
      status: 'idle',
      isTranslating: false,
      partialText: '',
      errorMessage: ''
    })
  },

  clearCurrent: () =>
    set({
      currentQuestion: '',
      currentAnswer: '',
      currentAnswerConfidence: 'unverified',
      currentAnswerQualityNote: '',
      currentAnswerVerified: false,
      currentAnswerCorrected: false,
      currentTranslation: '',
      currentDetectedLanguage: null,
      currentReasoning: '',
      isReasoning: false,
      isTranslating: false,
      partialText: '',
      qaInvitation: '',
      visibleMeetingQAId: null
    }),

  clearHistory: () => {
    const fresh = createConversationSession()
    set({
      dialogHistory: [],
      qaHistory: [],
      sessionId: fresh.id,
      sessionStartedAt: fresh.startedAt,
      contextSummary: '',
      contextCompressedAt: null,
      sessionFeedback: '',
      sessionFeedbackUpdatedAt: null,
      sessionPreset: createEmptySessionPreset(),
      meetingQAs: [],
      meetingNoteSelectionIds: [],
      qaInvitation: '',
      activeMeetingQA: null,
      visibleMeetingQAId: null,
      archivedSessions: [],
      currentQuestion: '',
      currentAnswer: '',
      currentAnswerConfidence: 'unverified',
      currentAnswerQualityNote: '',
      currentAnswerVerified: false,
      currentAnswerCorrected: false,
      currentTranslation: '',
      currentDetectedLanguage: null,
      isTranslating: false
    })
    localStorage.removeItem(HISTORY_STORAGE_KEY)
    localStorage.removeItem(LEGACY_HISTORY_STORAGE_KEY)
  },

  startNewConversation: () => {
    const state = get()
    if (
      state.status === 'answering' ||
      state.status === 'verifying' ||
      state.status === 'translating' ||
      state.status === 'compressing'
    ) return

    const hasContent =
      state.qaHistory.length > 0 ||
      state.dialogHistory.length > 0 ||
      state.meetingQAs.length > 0 ||
      Boolean(state.sessionFeedback)
    const archived = hasContent
      ? [currentSessionSnapshot(state), ...state.archivedSessions].slice(0, 30)
      : state.archivedSessions
    const fresh = createConversationSession()
    set({
      sessionId: fresh.id,
      sessionStartedAt: fresh.startedAt,
      dialogHistory: [],
      qaHistory: [],
      contextSummary: '',
      contextCompressedAt: null,
      sessionFeedback: '',
      sessionFeedbackUpdatedAt: null,
      sessionPreset: createEmptySessionPreset(),
      meetingQAs: [],
      meetingNoteSelectionIds: [],
      qaInvitation: '',
      activeMeetingQA: null,
      visibleMeetingQAId: null,
      archivedSessions: archived,
      currentQuestion: '',
      currentAnswer: '',
      currentAnswerConfidence: 'unverified',
      currentAnswerQualityNote: '',
      currentAnswerVerified: false,
      currentAnswerCorrected: false,
      currentTranslation: '',
      currentDetectedLanguage: null,
      currentReasoning: '',
      isReasoning: false,
      isTranslating: false,
      partialText: '',
      errorMessage: ''
    })
    persistConversationState(get())
  },

  saveSessionPreset: (preset) => {
    const normalized = normalizeSessionPreset(preset)
    const next = hasSessionPreset(normalized)
      ? { ...normalized, updatedAt: Date.now() }
      : createEmptySessionPreset()
    set({ sessionPreset: next, errorMessage: '' })
    persistConversationState(get())
  },

  showPreparedQuestions: (invitation = '手动打开预置提问') => {
    if (get().sessionPreset.preparedQuestions.length === 0) {
      set({ errorMessage: '请先在会话预设中添加“我准备向发言者提问”的问题。' })
      return
    }
    set({
      qaInvitation: invitation.trim() || '进入 QA 环节',
      visibleMeetingQAId: null,
      errorMessage: ''
    })
  },

  dismissPreparedQuestions: () => {
    set({ qaInvitation: '' })
  },

  startPreparedQuestionCapture: (preparedQuestionId) => {
    const question = get().sessionPreset.preparedQuestions.find(
      (item) => item.id === preparedQuestionId
    )
    if (!question) {
      set({ errorMessage: '这个预置提问已不存在，请重新打开会话预设。' })
      return
    }
    set({
      activeMeetingQA: {
        id: genId(),
        preparedQuestionId: question.id,
        question: question.question,
        answer: '',
        sourceTurnIds: [],
        askedAt: Date.now(),
        heardOwnQuestion: false
      },
      qaInvitation: '',
      visibleMeetingQAId: null,
      errorMessage: ''
    })
  },

  confirmPreparedQuestionAsked: () => {
    set((state) => ({
      activeMeetingQA: state.activeMeetingQA
        ? { ...state.activeMeetingQA, heardOwnQuestion: true }
        : null
    }))
  },

  finishPreparedQuestionCapture: () => {
    const active = get().activeMeetingQA
    if (!active) return
    const answer = active.answer.trim()
    if (!answer) {
      set({ errorMessage: '尚未记录到发言者回答，暂时不能完成这条 QA。' })
      return
    }
    const record: MeetingQARecord = {
      id: active.id,
      preparedQuestionId: active.preparedQuestionId,
      question: active.question,
      answer,
      sourceTurnIds: active.sourceTurnIds,
      askedAt: active.askedAt,
      completedAt: Date.now()
    }
    set((state) => ({
      meetingQAs: [record, ...state.meetingQAs].slice(0, 200),
      activeMeetingQA: null,
      visibleMeetingQAId: record.id,
      status: state.listening ? 'listening' : 'idle',
      errorMessage: ''
    }))
    persistConversationState(get())
  },

  cancelPreparedQuestionCapture: () => {
    set({
      activeMeetingQA: null,
      qaInvitation:
        get().sessionPreset.preparedQuestions.length > 0
          ? '已取消本次记录，可重新选择问题'
          : '',
      status: get().listening ? 'listening' : 'idle',
      errorMessage: ''
    })
  },

  dismissMeetingQAResult: () => {
    set({ visibleMeetingQAId: null })
  },

  toggleMeetingNoteSelection: (sourceId) => {
    const normalized = sourceId.trim().slice(0, 240)
    if (!normalized) return
    set((state) => ({
      meetingNoteSelectionIds: state.meetingNoteSelectionIds.includes(normalized)
        ? state.meetingNoteSelectionIds.filter((item) => item !== normalized)
        : [...state.meetingNoteSelectionIds, normalized]
    }))
    persistConversationState(get())
  },

  compressContext: async () => {
    const state = get()
    if (state.qaHistory.length === 0 && state.dialogHistory.length === 0) return
    if (
      state.status === 'answering' ||
      state.status === 'verifying' ||
      state.status === 'translating' ||
      state.status === 'compressing'
    ) return

    const controller = new AbortController()
    const returnStatus: RunStatus = state.listening ? 'listening' : 'idle'
    set({ status: 'compressing', _abortAnswer: controller, errorMessage: '' })
    try {
      const summary = await chatOnce(
        state.config.llm,
        buildContextCompressionMessages(
          state.dialogHistory,
          state.qaHistory,
          state.contextSummary,
          state.sessionFeedback
        ),
        controller.signal,
        { thinkingOverride: 'disabled', responseLanguage: 'zh' }
      )
      if (controller.signal.aborted) return
      if (!summary.trim()) {
        set({ status: returnStatus, _abortAnswer: null })
        return
      }
      set({
        contextSummary: summary.trim(),
        contextCompressedAt: Date.now(),
        status: returnStatus,
        _abortAnswer: null
      })
      persistConversationState(get())
    } catch (err) {
      set({
        status: 'error',
        _abortAnswer: null,
        errorMessage: `压缩上下文失败: ${(err as Error).message}`
      })
    }
  },

  updateQAFeedback: (sessionId, qaId, feedback, detail) => {
    const normalized = feedback.trim().slice(0, 2000)
    const hasStructuredEvidence = Boolean(
      detail?.approved ||
      detail?.preferredAnswer?.trim() ||
      detail?.dimensions.length
    )
    const feedbackUpdatedAt =
      normalized || hasStructuredEvidence ? Date.now() : undefined

    set((state) => {
      if (sessionId === state.sessionId) {
        return {
          qaHistory: state.qaHistory.map((qa) =>
            qa.id === qaId
              ? {
                  ...qa,
                  feedback: normalized || undefined,
                  feedbackDetail:
                    normalized || hasStructuredEvidence ? detail : undefined,
                  feedbackUpdatedAt
                }
              : qa
          )
        }
      }

      return {
        archivedSessions: state.archivedSessions.map((session) =>
          session.id === sessionId
            ? {
                ...session,
                updatedAt: Date.now(),
                qaHistory: session.qaHistory.map((qa) =>
                  qa.id === qaId
                    ? {
                        ...qa,
                        feedback: normalized || undefined,
                        feedbackDetail:
                          normalized || hasStructuredEvidence ? detail : undefined,
                        feedbackUpdatedAt
                      }
                    : qa
                )
              }
            : session
        )
      }
    })
    persistConversationState(get())

    const state = get()
    const qa =
      sessionId === state.sessionId
        ? state.qaHistory.find((item) => item.id === qaId)
        : state.archivedSessions
            .find((session) => session.id === sessionId)
            ?.qaHistory.find((item) => item.id === qaId)
    if (!qa) return

    const now = Date.now()
    const existingEvidence = state.personalizationEvidence.find(
      (item) => item.id === `qa:${sessionId}:${qaId}`
    )
    void window.inview
      .upsertPersonalizationEvidence({
        id: `qa:${sessionId}:${qaId}`,
        kind: 'qa',
        sessionId,
        qaId,
        question: qa.question,
        answer: qa.answer,
        feedback: normalized,
        feedbackDetail: qa.feedbackDetail,
        createdAt: existingEvidence?.createdAt ?? now,
        updatedAt: now
      })
      .then((records) => {
        const pendingFeedbackRecords = records.filter(
          (item) => !item.processedProfileVersion
        ).length
        set((current) => ({
          personalizationEvidence: records,
          personalization: {
            ...current.personalization,
            sourceStats: {
              ...current.personalization.sourceStats,
              feedbackRecords: records.length,
              approvedAnswers: records.filter(
                (item) => item.feedbackDetail?.approved
              ).length,
              pendingFeedbackRecords
            }
          }
        }))

        const current = get()
        if (
          !current.personalization.enabled ||
          !current.personalization.autoDistillFeedback ||
          pendingFeedbackRecords < current.personalization.feedbackDistillThreshold ||
          !current.config.llm.apiKey
        ) {
          return
        }
        if (current._personalizationTimer) {
          window.clearTimeout(current._personalizationTimer)
        }
        const timer = window.setTimeout(() => {
          set({ _personalizationTimer: null })
          void get().distillPersonalization(false, true)
        }, 1500)
        set({ _personalizationTimer: timer })
      })
      .catch((error) => {
        set({
          personalizationError: `保存持续蒸馏证据失败：${(error as Error).message}`
        })
      })
  },

  updateSessionFeedback: (sessionId, feedback) => {
    const normalized = feedback.trim().slice(0, 6000)
    const overallFeedbackUpdatedAt = normalized ? Date.now() : undefined

    set((state) => {
      if (sessionId === state.sessionId) {
        return {
          sessionFeedback: normalized,
          sessionFeedbackUpdatedAt: overallFeedbackUpdatedAt ?? null
        }
      }

      return {
        archivedSessions: state.archivedSessions.map((session) =>
          session.id === sessionId
            ? {
                ...session,
                updatedAt: Date.now(),
                overallFeedback: normalized || undefined,
                overallFeedbackUpdatedAt
              }
            : session
        )
      }
    })
    persistConversationState(get())

    const now = Date.now()
    const existingEvidence = get().personalizationEvidence.find(
      (item) => item.id === `session:${sessionId}`
    )
    void window.inview
      .upsertPersonalizationEvidence({
        id: `session:${sessionId}`,
        kind: 'session',
        sessionId,
        feedback: normalized,
        createdAt: existingEvidence?.createdAt ?? now,
        updatedAt: now
      })
      .then((records) => {
        const pendingFeedbackRecords = records.filter(
          (item) => !item.processedProfileVersion
        ).length
        set((current) => ({
          personalizationEvidence: records,
          personalization: {
            ...current.personalization,
            sourceStats: {
              ...current.personalization.sourceStats,
              feedbackRecords: records.length,
              approvedAnswers: records.filter(
                (item) => item.feedbackDetail?.approved
              ).length,
              pendingFeedbackRecords
            }
          }
        }))
        const current = get()
        if (
          current.personalization.enabled &&
          current.personalization.autoDistillFeedback &&
          pendingFeedbackRecords >=
            current.personalization.feedbackDistillThreshold &&
          current.config.llm.apiKey
        ) {
          if (current._personalizationTimer) {
            window.clearTimeout(current._personalizationTimer)
          }
          const timer = window.setTimeout(() => {
            set({ _personalizationTimer: null })
            void get().distillPersonalization(false, true)
          }, 1500)
          set({ _personalizationTimer: timer })
        }
      })
      .catch((error) => {
        set({
          personalizationError: `保存持续蒸馏证据失败：${(error as Error).message}`
        })
      })
  }
}))

// ============== 主流程编排:语音 → 问题提取 → 答案生成 ==============

type SetFn = (
  partial:
    | Partial<InterviewStore>
    | ((state: InterviewStore) => Partial<InterviewStore>)
) => void
type GetFn = () => InterviewStore

/** 把用户选择的模式解析为本次请求的实际输出语言。 */
export function resolveAnswerLanguage(
  mode: Region,
  detectedLanguage: DetectedLanguage
): ResponseLanguage {
  if (mode === 'zh' || mode === 'en') return mode
  return detectedLanguage
}

export function shouldGenerateTranslation(
  mode: Region,
  enabled: boolean,
  detectedLanguage: DetectedLanguage
): boolean {
  return mode === 'mixed' && enabled && !detectedLanguage.isChinese
}

/**
 * 提交 STT 缓冲区:把累积的文本交给问题检测器,然后清空缓冲区
 * Whisper 已在真实停顿后返回完整语音段；这里短暂合并相邻结果后再触发。
 */
function flushSttBuffer(get: GetFn, set: SetFn): void {
  const state = get()
  const buffer = state._sttBuffer.trim()
  const speaker = state._sttBufferSpeaker

  // 清空缓冲区
  set({ _sttBuffer: '', _sttBufferTimer: null, _sttBufferSpeaker: null, partialText: '' })

  if (!buffer || !speaker) return

  console.log(`[STT flush] speaker=${speaker}, text="${buffer}"`)
  handleFinalTranscript(buffer, speaker, set, get)
}

/**
 * 处理一段完整的语音识别文本
 *  1. 加入对话历史
 *  2. 调用 LLM 判断是否是正式提问
 *  3. 如果是,提取问题并生成答案(流式)
 */
async function handleFinalTranscript(
  text: string,
  speaker: 'mic' | 'system',
  set: SetFn,
  get: GetFn
): Promise<void> {
  if (!text.trim()) return

  const state = get()
  const { config } = state

  // 1. 加入对话历史(角色由音源推断:mic = self, system = interviewer)
  const turn: DialogTurn = {
    id: genId(),
    role: speaker === 'mic' ? 'self' : 'interviewer',
    text,
    timestamp: Date.now()
  }
  set((s) => ({ dialogHistory: [...s.dialogHistory, turn] }))

  // 用户已从预置提问中开始记录时，后续系统声音就是发言者回答。
  // 这条分支不再走“为用户生成答案”的旧流程，避免把对方回答误判成新问题。
  if (state.activeMeetingQA) {
    if (speaker === 'mic') {
      set((current) => ({
        activeMeetingQA: current.activeMeetingQA
          ? { ...current.activeMeetingQA, heardOwnQuestion: true }
          : null,
        status: current.listening ? 'listening' : 'idle'
      }))
    } else {
      set((current) => {
        if (!current.activeMeetingQA) return {}
        if (!current.activeMeetingQA.heardOwnQuestion) {
          return { status: current.listening ? 'listening' : 'idle' }
        }
        return {
          activeMeetingQA: {
            ...current.activeMeetingQA,
            answer: [current.activeMeetingQA.answer, text]
              .filter(Boolean)
              .join('\n'),
            sourceTurnIds: [...current.activeMeetingQA.sourceTurnIds, turn.id]
          },
          status: current.listening ? 'listening' : 'idle'
        }
      })
    }
    persistConversationState(get())
    return
  }

  // 2. 调用 LLM 判断是否是问题(如果当前正在回答,跳过,避免打断)
  if (
    state.status === 'answering' ||
    state.status === 'verifying' ||
    state.status === 'translating'
  ) return

  set({ status: 'extracting' })
  let result
  try {
    result = await extractQuestion(
      config.llm,
      text,
      // 当前文本通过 currentText 单独传入，避免在历史中重复出现一次。
      state.dialogHistory,
      config.interview.region,
      buildSessionPresetDetectionContext(state.sessionPreset)
    )
  } catch (err) {
    set({ status: 'idle', errorMessage: (err as Error).message })
    return
  }

  // LLM 可能进一步修正角色,回写到最近一条对话
  set((s) => {
    const history = [...s.dialogHistory]
    if (history.length > 0) {
      const last = { ...history[history.length - 1], role: result.role }
      history[history.length - 1] = last
    }
    return { dialogHistory: history }
  })

  const isQaInvitation =
    speaker === 'system' &&
    (result.isQaInvitation || looksLikeQaInvitation(text))
  if (isQaInvitation) {
    set({
      qaInvitation:
        get().sessionPreset.preparedQuestions.length > 0 ? text : '',
      status: get().listening ? 'listening' : 'idle'
    })
    persistConversationState(get())
    return
  }

  if (!result.isComplete) {
    // 暂时移除这条半句历史，下一段同一说话者到来时重新拼成完整文本检测。
    set((s) => ({
      dialogHistory: s.dialogHistory.filter((item) => item.id !== turn.id),
      _pendingTranscript: text,
      _pendingTranscriptSpeaker: speaker,
      partialText: text,
      transcriptSpeaker: speaker,
      status: 'idle'
    }))
    return
  }

  if (!result.isQuestion || !result.question) {
    set({ status: get().listening ? 'listening' : 'idle' })
    persistConversationState(get())
    return
  }

  // 3. 生成答案(流式,支持思维链)
  // 问题提取是异步的,此处重新读取配置,确保期间切换的回答语言立即生效。
  const answerConfig = get().config
  const languageMode = answerConfig.interview.region
  const answerLanguage = resolveAnswerLanguage(languageMode, result.detectedLanguage)
  const question = result.question
  const sessionPresetInstructions = buildSessionPresetInstructions(
    get().sessionPreset,
    question,
    answerConfig.llm.millionContextEnabled
  )
  set({
    currentQuestion: question,
    currentAnswer: '',
    currentAnswerConfidence: 'unverified',
    currentAnswerQualityNote: '',
    currentAnswerVerified: false,
    currentAnswerCorrected: false,
    currentTranslation: '',
    currentDetectedLanguage: result.detectedLanguage,
    currentReasoning: '',
    isReasoning: false,
    isTranslating: false,
    status: 'answering'
  })

  const messages = buildAnswerMessages(
    question,
    get().dialogHistory,
    get().qaHistory,
    answerConfig.interview.position,
    answerConfig.interview.mode,
    answerLanguage,
    answerConfig.interview.resume,
    answerConfig.interview.knowledgeBase,
    get().contextSummary,
    get().contextCompressedAt ?? undefined,
    answerConfig.llm.millionContextEnabled,
    [
      ...get().qaHistory,
      ...get().archivedSessions.flatMap((session) => session.qaHistory)
    ],
    [currentSessionSnapshot(get()), ...get().archivedSessions],
    [
      buildPersonalizationInstructions(get().personalization),
      buildPendingFeedbackInstructions(get().personalizationEvidence)
    ]
      .filter(Boolean)
      .join('\n\n'),
    sessionPresetInstructions
  )

  const controller = new AbortController()
  set({ _abortAnswer: controller })

  let fullAnswer = ''
  let fullReasoning = ''
  let answerError: Error | null = null
  let answerConfidence: AnswerConfidence = 'unverified'
  let answerQualityNote = ''
  let answerVerified = false
  let answerCorrected = false
  await chatStream(
    answerConfig.llm,
    messages,
    {
      onReasoning: (delta) => {
        // 思维链阶段:先输出思维链,UI 显示"思考中"
        fullReasoning += delta
        set({ currentReasoning: fullReasoning, isReasoning: true })
      },
      onChunk: (delta) => {
        // 最终答案阶段:思维链结束,开始输出答案
        fullAnswer += delta
        set({ currentAnswer: fullAnswer, isReasoning: false })
      },
      onDone: (final, reasoning) => {
        fullAnswer = final
        fullReasoning = reasoning || fullReasoning
        set({ currentAnswer: final, currentReasoning: fullReasoning, isReasoning: false })
      },
      onError: (err) => {
        answerError = err
        set({ status: 'error', errorMessage: err.message, _abortAnswer: null, isReasoning: false })
      }
    },
    controller.signal,
    {
      responseLanguage: answerLanguage,
      maxTokensOverride: getSpokenAnswerMaxTokens(
        answerConfig.interview.mode,
        answerLanguage
      )
    }
  )

  if (answerError || controller.signal.aborted || !fullAnswer.trim()) return

  set({ status: 'verifying' })
  const reviewEvidence = [
    sessionPresetInstructions
      ? `当前会话主题、资料和用户期望口径:\n${sessionPresetInstructions}`
      : '',
    answerConfig.interview.resume?.trim()
      ? `学习者背景资料:\n${answerConfig.interview.resume.trim().slice(0, 5000)}`
      : '',
    answerConfig.interview.knowledgeBase?.trim()
      ? `参考资料:\n${answerConfig.interview.knowledgeBase.trim().slice(0, 8000)}`
      : '',
    get().contextSummary.trim()
      ? `此前对话事实摘要:\n${get().contextSummary.trim().slice(0, 4000)}`
      : ''
  ]
    .filter(Boolean)
    .join('\n\n')

  try {
    const review = await reviewAnswer({
      llmConfig: answerConfig.llm,
      scope: 'qa',
      subject: question,
      draftAnswer: fullAnswer,
      evidence: reviewEvidence,
      responseLanguage: answerLanguage,
      personalizationInstructions: [
        buildPersonalizationInstructions(get().personalization),
        buildPendingFeedbackInstructions(get().personalizationEvidence)
      ]
        .filter(Boolean)
        .join('\n\n'),
      signal: controller.signal
    })
    fullAnswer = review.finalAnswer
    answerConfidence = review.confidence
    answerQualityNote = review.note
    answerVerified = review.verified
    answerCorrected = review.corrected
  } catch (err) {
    answerQualityNote = `答案复核失败：${(err as Error).message}`
  }

  if (controller.signal.aborted || !fullAnswer.trim()) return
  set({
    currentAnswer: fullAnswer,
    currentAnswerConfidence: answerConfidence,
    currentAnswerQualityNote: answerQualityNote,
    currentAnswerVerified: answerVerified,
    currentAnswerCorrected: answerCorrected
  })

  // 4. 混合模式 + 非中文输入 + 设置已开启时,额外生成可折叠的中文翻译。
  const shouldTranslate = shouldGenerateTranslation(
    languageMode,
    answerConfig.interview.bilingualTranslationEnabled,
    result.detectedLanguage
  )

  let fullTranslation = ''
  let translationError: Error | null = null
  if (shouldTranslate) {
    set({ status: 'translating', isTranslating: true, currentTranslation: '' })
    await chatStream(
      answerConfig.llm,
      buildTranslationMessages(fullAnswer, result.detectedLanguage),
      {
        onChunk: (delta) => {
          fullTranslation += delta
          set({ currentTranslation: fullTranslation })
        },
        onDone: (final) => {
          fullTranslation = final
          set({ currentTranslation: final })
        },
        onError: (err) => {
          translationError = err
        }
      },
      controller.signal,
      { thinkingOverride: 'disabled', responseLanguage: 'zh' }
    )
  }

  if (controller.signal.aborted) return

  const qa: QARecord = {
    id: genId(),
    question,
    answer: fullAnswer,
    reasoning: fullReasoning || undefined,
    translation: fullTranslation || undefined,
    detectedLanguage: result.detectedLanguage,
    answerLanguageCode:
      typeof answerLanguage === 'string' ? answerLanguage : answerLanguage.code,
    answerConfidence,
    answerQualityNote: answerQualityNote || undefined,
    answerVerified,
    answerCorrected,
    timestamp: Date.now(),
    mode: answerConfig.interview.mode
  }
  set((s) => ({
    qaHistory: [qa, ...s.qaHistory].slice(0, 1000),
    status: s.listening ? 'listening' : 'idle',
    isReasoning: false,
    isTranslating: false,
    _abortAnswer: null,
    errorMessage: translationError
      ? `中文翻译生成失败: ${translationError.message}`
      : s.errorMessage
  }))
  persistConversationState(get())
}
