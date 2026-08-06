/**
 * 主进程与渲染进程共享的类型定义
 */

/** AI 回答模式 */
export type AnswerMode = 'normal' | 'concise' | 'algorithm' | 'system-design' | 'detailed'

/** 回答语言(沿用 region 字段以兼容已有配置) */
export type Region = 'zh' | 'en' | 'mixed'

/** AI 答案经过独立复核后的可靠性等级。 */
export type AnswerConfidence = 'high' | 'medium' | 'low' | 'unverified'

/** 从最新语音文本中检测到的语言 */
export interface DetectedLanguage {
  /** ISO 639 风格语言码,如 zh / en / ja */
  code: string
  /** 用于界面和提示词的语言名称 */
  name: string
  /** 是否属于中文 */
  isChinese: boolean
}

/** 窗口显示偏好(隐私与专注模式) */
export interface StealthState {
  /** 任务栏隐藏 */
  hideTaskbar: boolean
  /** 窗口透明度 0.1 ~ 1.0 */
  opacity: number
  /** 屏幕共享隐私保护(不对共享/录屏可见) */
  hideFromCapture: boolean
  /** 专注模式(窗口置顶但不抢焦点,练习时不打断主窗口) */
  antiSwitchDetect: boolean
  /** 窗口置顶 */
  alwaysOnTop: boolean
}

/** LLM 接入配置(用户自定义) */
export interface LLMConfig {
  /** OpenAI 兼容接口的 base URL,如 https://api.openai.com/v1 */
  baseURL: string
  /** API Key */
  apiKey: string
  /** 模型名,如 deepseek-v4-flash */
  model: string
  /** 采样温度(思考模式下不生效,但保留字段) */
  temperature: number
  /** 单次最大 tokens */
  maxTokens: number
  /** 思考模式开关(DeepSeek v4 系列):enabled / disabled */
  thinking: 'enabled' | 'disabled'
  /** 思考强度(仅 thinking=enabled 时生效):high / max */
  reasoningEffort: 'high' | 'max'
  /** 使用模型的大上下文窗口，尽量携带完整会话、简历和知识库 */
  millionContextEnabled: boolean
}

/** 音频源类型 */
export type AudioSourceType = 'mic' | 'system'

/** 语音识别配置 */
export interface STTConfig {
  /** 服务类型:浏览器内置 / Whisper API / 自定义 */
  provider: 'web' | 'whisper-api' | 'custom'
  /** 当 provider=whisper-api 或 custom 时使用 */
  baseURL?: string
  apiKey?: string
  model?: string
  /** 识别语言:auto(自动检测) / zh-CN / en-US */
  language: string
  /** 是否自动检测输入语言;新增字段默认 true,可让旧配置自动升级为多语言识别 */
  autoDetectLanguage: boolean
  /** 检测到多长静音后认为一句话已经说完 */
  endOfSpeechDelayMs: number
  /** 麦克风开关 */
  micEnabled: boolean
  /** 系统声音开关 */
  systemEnabled: boolean
  /** 麦克风音量 0~1 */
  micVolume: number
  /** 系统声音音量 0~1 */
  systemVolume: number
  /** 采样率(Whisper 推荐用 16000,但浏览器录音通常 44100/48000,内部重采样) */
  sampleRate?: number
}

/** 模拟训练配置 */
export interface InterviewConfig {
  /** 目标岗位 */
  position: string
  /** 回答语言:zh = 仅中文,en = 仅英文,mixed = 跟随输入语言 */
  region: Region
  /** 混合模式下,非中文回答是否额外生成中文翻译 */
  bilingualTranslationEnabled: boolean
  /** 回答模式 */
  mode: AnswerMode
  /** 简历文本(可选) */
  resume?: string
  /** 自定义问答库文本(可选) */
  knowledgeBase?: string
}

/** AI Mentor 屏幕提取配置 */
export interface MentorConfig {
  /** 是否在 Mentor 面板打开时监测全局鼠标静止状态 */
  delayedCaptureEnabled: boolean
  /** 鼠标停止移动、点击、拖拽或滚动多久后自动全屏截取 */
  delayedCaptureDelaySeconds: number
}

/** 主问答区显示配置 */
export interface DisplayConfig {
  /** 当前识别问题的正文字号(px) */
  questionFontSize: number
  /** AI 回答与当前翻译的正文字号(px) */
  answerFontSize: number
  /** 主窗口上次关闭前的横坐标 */
  windowX?: number
  /** 主窗口上次关闭前的纵坐标 */
  windowY?: number
  /** 主窗口上次关闭前的宽度 */
  windowWidth?: number
  /** 主窗口上次关闭前的高度 */
  windowHeight?: number
}

/** 应用全部配置 */
export interface AppConfig {
  llm: LLMConfig
  stt: STTConfig
  interview: InterviewConfig
  mentor: MentorConfig
  display: DisplayConfig
  stealth: StealthState
}

/** 会话事件类型 */
export type InterviewEventType =
  | 'partial' // 语音识别中间结果
  | 'transcript' // 语音识别最终结果
  | 'question' // 提取到问题
  | 'answer-chunk' // 答案流式 chunk
  | 'answer-done' // 答案生成完成
  | 'status' // 状态变更
  | 'error' // 错误

/** 会话事件载荷 */
export interface InterviewEvent {
  type: InterviewEventType
  data?: unknown
  timestamp: number
}

/** 运行状态 */
export type RunStatus =
  | 'idle' // 未启动
  | 'listening' // 监听中
  | 'extracting' // 正在提取问题
  | 'answering' // 正在生成答案
  | 'verifying' // 正在独立复核答案
  | 'translating' // 正在生成双语翻译
  | 'compressing' // 正在压缩当前上下文
  | 'error'

/** 一条对话记录(用于上下文关联) */
export interface DialogTurn {
  id: string
  role: 'interviewer' | 'candidate' | 'self' | 'unknown'
  text: string
  timestamp: number
}

/** 用户指出一条回答需要从哪个维度调整。 */
export type FeedbackDimension =
  | 'thinking'
  | 'speaking'
  | 'accuracy'
  | 'length'
  | 'tone'
  | 'example'
  | 'other'

/** 一条反馈应影响多大的回答范围。 */
export type FeedbackScope = 'general' | 'similar-situations' | 'current-language'

/** 可被持续蒸馏的结构化回答反馈。 */
export interface QAFeedbackDetail {
  dimensions: FeedbackDimension[]
  scope: FeedbackScope
  /** 用户确认当前回答已经像自己，可作为正向样本。 */
  approved: boolean
  /** 用户亲自改写或明确认可的表达，证据权重高于文字点评。 */
  preferredAnswer?: string
  /** 保存反馈时的回答语言，current-language 规则只在该语言中生效。 */
  languageCode?: string
}

/** 一次问答记录 */
export interface QARecord {
  id: string
  question: string
  answer: string
  /** 思维链(思考模式开启时) */
  reasoning?: string
  /** 混合模式下的中文翻译 */
  translation?: string
  /** 当前问题检测到的语言 */
  detectedLanguage?: DetectedLanguage
  /** 该条答案实际使用的输出语言。 */
  answerLanguageCode?: string
  /** 独立复核后的可靠性等级；旧历史记录可能没有该字段 */
  answerConfidence?: AnswerConfidence
  /** 不展示隐藏推理，只记录简短的可靠性说明 */
  answerQualityNote?: string
  /** 是否成功完成独立复核 */
  answerVerified?: boolean
  /** 复核阶段是否修正过候选答案 */
  answerCorrected?: boolean
  /** 用户对本轮回答的复盘反馈；后续回答会自动吸收 */
  feedback?: string
  /** 结构化反馈；旧历史只有 feedback 字符串时仍可继续使用。 */
  feedbackDetail?: QAFeedbackDetail
  /** 反馈最后更新时间，用于按最新反馈顺序控制上下文 */
  feedbackUpdatedAt?: number
  timestamp: number
  mode: AnswerMode
}

/** 当前问答会话内使用的一份参考资料。只保存提取后的纯文本，不保存原文件路径。 */
export interface SessionPresetDocument {
  id: string
  name: string
  text: string
  characterCount: number
  truncated: boolean
  addedAt: number
}

/** 用户为当前会话预设的一组“可能问题 → 期望回答”。 */
export interface SessionPresetQA {
  id: string
  question: string
  expectedAnswer: string
}

/** 用户准备在会议 QA 环节主动向发言者提出的问题。 */
export interface SessionPreparedQuestion {
  id: string
  question: string
}

/** 一次由用户预置提问、发言者现场回答组成的会议 QA 记录。 */
export interface MeetingQARecord {
  id: string
  preparedQuestionId: string
  question: string
  answer: string
  sourceTurnIds: string[]
  askedAt: number
  completedAt: number
}

/**
 * 仅作用于单次问答窗口的主题、背景和提词资料。
 *
 * 它随当前 ConversationSession 保存，开启新会话时不会继承，也不会进入长期画像。
 */
export interface SessionPreset {
  topic: string
  background: string
  documents: SessionPresetDocument[]
  qaPairs: SessionPresetQA[]
  preparedQuestions: SessionPreparedQuestion[]
  updatedAt: number
}

export function createEmptySessionPreset(): SessionPreset {
  return {
    topic: '',
    background: '',
    documents: [],
    qaPairs: [],
    preparedQuestions: [],
    updatedAt: 0
  }
}

/** 一次可复盘的对话记录。历史与模型当前上下文分离保存。 */
export interface ConversationSession {
  id: string
  title: string
  startedAt: number
  updatedAt: number
  qaHistory: QARecord[]
  dialogHistory: DialogTurn[]
  /** 用户对整轮对话的复盘反馈；优先于单条回答反馈 */
  overallFeedback?: string
  /** 整轮反馈最后更新时间 */
  overallFeedbackUpdatedAt?: number
  /** 压缩后的上下文摘要，仅供后续模型理解，不替代可复盘历史 */
  contextSummary?: string
  /** 摘要覆盖到的时间点；之后产生的问答仍按原文加入上下文 */
  contextCompressedAt?: number
  /** 仅在这轮问答中生效的主题、资料和预设问答。 */
  sessionPreset?: SessionPreset
  /** 用户在会议 QA 环节主动提问并记录到的发言者回答。 */
  meetingQAs?: MeetingQARecord[]
  /** 当前会话中被用户手动加入待落库笔记的记录 ID。 */
  meetingNoteSelectionIds?: string[]
}

export type MeetingNoteEntryType =
  | 'qa-session'
  | 'chat-qa'
  | 'transcript'

/** 渲染进程提交给主进程的已选择会议记录快照。 */
export interface MeetingNoteEntry {
  id: string
  type: MeetingNoteEntryType
  timestamp: number
  question?: string
  answer?: string
  content?: string
  speaker?: DialogTurn['role']
  preparedQuestionId?: string
}

export interface MeetingNoteExportPayload {
  title: string
  sessionId: string
  sessionStartedAt: number
  exportedAt: number
  entries: MeetingNoteEntry[]
  /** 只要本轮有预置内容，就完整随所选记录一并落库。 */
  sessionPreset?: SessionPreset
}

export interface KnowledgeMaintenanceResult {
  success: boolean
  message: string
}

export interface MeetingNoteSaveResult {
  notePath: string
  maintenance: KnowledgeMaintenanceResult
}

/** 个人认知—表达画像中的规则证据来源。 */
export type PersonalizationRuleSource =
  | 'knowledge-base'
  | 'qa-feedback'
  | 'session-feedback'
  | 'user-confirmed'

/** 规则当前通过证据验证的程度。 */
export type PersonalizationConfidence = 'candidate' | 'supported' | 'stable'

/**
 * 一条跨语言、按情境触发的个人规则。
 *
 * 规则描述行为选择，而不是固定句式或答案模板。
 */
export interface PersonalizationRule {
  id: string
  title: string
  instruction: string
  appliesWhen: string
  avoid?: string
  evidenceCount: number
  confidence: PersonalizationConfidence
  sources: PersonalizationRuleSource[]
}

export interface PersonalizationSourceStats {
  knowledgeFilesScanned: number
  knowledgeFilesSampled: number
  knowledgeCharactersSampled: number
  feedbackRecords: number
  approvedAnswers: number
  pendingFeedbackRecords: number
}

/** 独立于对话历史保存的持续蒸馏证据。 */
export interface PersonalizationFeedbackEvidence {
  id: string
  kind: 'qa' | 'session'
  sessionId: string
  qaId?: string
  question?: string
  answer?: string
  feedback: string
  feedbackDetail?: QAFeedbackDetail
  createdAt: number
  updatedAt: number
  /** 已合并进哪个画像版本；缺失时表示仍待增量蒸馏。 */
  processedProfileVersion?: number
}

/**
 * 一套共享于所有输出语言的 Personal Cognitive Voice。
 *
 * cognitiveRules / expressionRules / spokenRules 是同一人格在不同层面的
 * 可观察规律，不是中文、英文两套 Persona。
 */
export interface PersonalizationProfile {
  schemaVersion: 1
  profileVersion: number
  enabled: boolean
  /** 新反馈达到阈值后在后台自动增量更新画像。 */
  autoDistillFeedback: boolean
  feedbackDistillThreshold: number
  status: 'empty' | 'active'
  knowledgeBasePath: string
  updatedAt: number
  cognitiveRules: PersonalizationRule[]
  expressionRules: PersonalizationRule[]
  spokenRules: PersonalizationRule[]
  antiPatterns: PersonalizationRule[]
  /** 画像不能推断或不能对外使用的边界。 */
  boundaries: string[]
  sourceStats: PersonalizationSourceStats
}

export interface PersonalizationVersionSummary {
  profileVersion: number
  updatedAt: number
  cognitiveRuleCount: number
  expressionRuleCount: number
  spokenRuleCount: number
}

export interface KnowledgeBaseSampleChunk {
  id: string
  text: string
  characterCount: number
}

/** 主进程完成目录白名单、隐私过滤和抽样后交给蒸馏器的语料。 */
export interface KnowledgeBaseCorpus {
  rootPath: string
  chunks: KnowledgeBaseSampleChunk[]
  filesScanned: number
  filesSampled: number
  charactersSampled: number
  excludedRoots: string[]
}

export function createEmptyPersonalizationProfile(): PersonalizationProfile {
  return {
    schemaVersion: 1,
    profileVersion: 0,
    enabled: true,
    autoDistillFeedback: true,
    feedbackDistillThreshold: 3,
    status: 'empty',
    knowledgeBasePath: '',
    updatedAt: 0,
    cognitiveRules: [],
    expressionRules: [],
    spokenRules: [],
    antiPatterns: [],
    boundaries: [
      '知识库只用于提炼抽象的思考与写作规律，不得输出其中的个人事实',
      '对外个人经历只能使用简历或用户在当前对话中明确授权的内容',
      '说话风格只能由用户确认过的回答和问答反馈支持',
      '同一套认知—表达规律必须跨语言保持一致，不套用固定回答模板'
    ],
    sourceStats: {
      knowledgeFilesScanned: 0,
      knowledgeFilesSampled: 0,
      knowledgeCharactersSampled: 0,
      feedbackRecords: 0,
      approvedAnswers: 0,
      pendingFeedbackRecords: 0
    }
  }
}

/** 默认配置(DeepSeek v4-flash 最佳实践) */
export const DEFAULT_CONFIG: AppConfig = {
  llm: {
    // DeepSeek 官方 OpenAI 兼容端点(不带 /v1,DeepSeek 同时兼容 /v1 路径)
    baseURL: 'https://api.deepseek.com',
    apiKey: '',
    // v4-flash:快速、成本低,适合实时语音对话场景
    model: 'deepseek-v4-flash',
    // 思考模式下 temperature 不生效;非思考模式建议 0.3(更确定、结构化)
    temperature: 0.3,
    // 4096 保证系统设计/详细模式答案不被截断(flash 最大输出 384K)
    maxTokens: 4096,
    // 默认关闭思考模式:实时对话场景速度优先,flash 本身够快够准
    // 复杂问题(算法/系统设计等)可在设置面板临时开启
    thinking: 'disabled',
    // 若开启思考,high 是性价比最优;max 更准但更慢
    reasoningEffort: 'high',
    millionContextEnabled: false
  },
  stt: {
    provider: 'whisper-api',
    // Groq 免费 Whisper:https://console.groq.com/docs/speech-text
    // 也可换 OpenAI: https://api.openai.com/v1 + whisper-1
    // 或本地 whisper.cpp: http://localhost:8080/v1 + whisper-1
    baseURL: 'https://api.groq.com/openai/v1',
    apiKey: '',
    model: 'whisper-large-v3',
    // 自动识别输入语言,与最终回答语言完全解耦
    language: 'auto',
    autoDetectLanguage: true,
    // 说话者思考或换气时经常有短暂停顿，2.5 秒可减少半句话就触发回答。
    endOfSpeechDelayMs: 2500,
    micEnabled: true,
    systemEnabled: false,
    micVolume: 1,
    systemVolume: 1,
    sampleRate: 16000
  },
  interview: {
    position: '前端工程师',
    region: 'zh',
    bilingualTranslationEnabled: true,
    mode: 'normal',
    resume: '',
    knowledgeBase: ''
  },
  mentor: {
    delayedCaptureEnabled: false,
    delayedCaptureDelaySeconds: 15
  },
  display: {
    // 回答是训练时需要快速阅读的主内容，默认大于识别到的问题。
    questionFontSize: 14,
    answerFontSize: 18
  },
  stealth: {
    hideTaskbar: false,
    opacity: 0.92,
    hideFromCapture: false,
    antiSwitchDetect: false,
    alwaysOnTop: true
  }
}
