/**
 * 个人认知—表达画像蒸馏与运行时指令。
 *
 * 知识库只进入 cognitiveRules / expressionRules；spokenRules 只能来自用户对
 * App 问答的反馈或用户确认的回答。所有规则都描述跨语言、按情境触发的行为，
 * 不生成固定答案模板。
 */

import type {
  ConversationSession,
  KnowledgeBaseCorpus,
  LLMConfig,
  PersonalizationConfidence,
  PersonalizationFeedbackEvidence,
  PersonalizationProfile,
  PersonalizationRule,
  PersonalizationRuleSource,
  QARecord
} from '@shared/types'
import { chatOnce, type ChatMessage } from './llm'

interface RawRule {
  title?: unknown
  instruction?: unknown
  appliesWhen?: unknown
  avoid?: unknown
  evidenceCount?: unknown
  confidence?: unknown
  sources?: unknown
}

interface RawCandidate {
  cognitiveRules?: unknown
  expressionRules?: unknown
  spokenRules?: unknown
  antiPatterns?: unknown
  boundaries?: unknown
}

interface CandidateBundle {
  cognitiveRules: PersonalizationRule[]
  expressionRules: PersonalizationRule[]
  spokenRules: PersonalizationRule[]
  antiPatterns: PersonalizationRule[]
  boundaries: string[]
}

export interface PersonalizationDistillationProgress {
  stage: 'knowledge' | 'feedback' | 'synthesis' | 'saving'
  completed: number
  total: number
  message: string
}

interface DistillPersonalizationOptions {
  llmConfig: LLMConfig
  existing: PersonalizationProfile
  corpus?: KnowledgeBaseCorpus
  evidence: PersonalizationFeedbackEvidence[]
  qaHistory: QARecord[]
  sessionHistory: ConversationSession[]
  signal?: AbortSignal
  onProgress?: (progress: PersonalizationDistillationProgress) => void
}

const PRIVATE_FACT_PATTERN =
  /(?:https?:\/\/|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:\+?86[-\s]?)?1[3-9]\d{9}|\d{4}[年./-]\d{1,2}|身份证|银行卡|验证码|私钥|恢复码|家庭住址|出生日期|薪资|工资|房租|存款|负债|家人|父母|伴侣|男朋友|女朋友|病历|疾病诊断|个人现金流|就职于|毕业于)/iu
const MAX_FEEDBACK_ITEMS = 80
const MAX_FEEDBACK_CHARACTERS = 100_000

function cleanText(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

function cleanJsonFence(raw: string): string {
  return raw
    .trim()
    .replace(/^```json\s*/iu, '')
    .replace(/^```\s*/u, '')
    .replace(/```\s*$/u, '')
    .trim()
}

function extractCompleteJsonObject(raw: string): string {
  const cleaned = cleanJsonFence(raw)
  const start = cleaned.indexOf('{')
  if (start < 0) throw new Error('模型没有返回 JSON 对象')

  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < cleaned.length; index++) {
    const character = cleaned[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }

    if (character === '"') {
      inString = true
      continue
    }
    if (character === '{') depth += 1
    if (character === '}') {
      depth -= 1
      if (depth === 0) return cleaned.slice(start, index + 1)
    }
  }

  throw new Error(
    inString || depth > 0
      ? '模型返回的 JSON 被截断'
      : '模型返回的 JSON 结构不完整'
  )
}

function parseJson(raw: string): RawCandidate {
  const parsed = JSON.parse(extractCompleteJsonObject(raw)) as unknown
  if (!parsed || typeof parsed !== 'object') throw new Error('蒸馏结果不是 JSON 对象')
  return parsed as RawCandidate
}

function normalizeSources(
  value: unknown,
  fallbackSource: PersonalizationRuleSource
): PersonalizationRuleSource[] {
  const valid = Array.isArray(value)
    ? value.filter(
        (item): item is PersonalizationRuleSource =>
          item === 'knowledge-base' ||
          item === 'qa-feedback' ||
          item === 'session-feedback' ||
          item === 'user-confirmed'
      )
    : []
  if (valid.length === 0) valid.push(fallbackSource)
  return [...new Set(valid)]
}

function normalizeConfidence(
  value: unknown,
  evidenceCount: number
): PersonalizationConfidence {
  if (value === 'stable' && evidenceCount >= 3) return 'stable'
  if ((value === 'stable' || value === 'supported') && evidenceCount >= 2) {
    return 'supported'
  }
  return 'candidate'
}

function normalizeRule(
  raw: RawRule,
  index: number,
  source: PersonalizationRuleSource
): PersonalizationRule | null {
  const instruction = cleanText(raw.instruction, 1000)
  const title = cleanText(raw.title, 120)
  const appliesWhen = cleanText(raw.appliesWhen, 500)
  const avoid = cleanText(raw.avoid, 500)
  const combined = `${title}\n${instruction}\n${appliesWhen}\n${avoid}`
  if (!instruction || PRIVATE_FACT_PATTERN.test(combined)) return null

  const evidenceCount = Math.max(
    1,
    Math.min(999, Math.floor(Number(raw.evidenceCount) || 1))
  )
  return {
    id: `${source}-${Date.now()}-${index + 1}`,
    title: title || `个人规律 ${index + 1}`,
    instruction,
    appliesWhen: appliesWhen || '当该规律与当前问题相关时',
    avoid: avoid || undefined,
    evidenceCount,
    confidence: normalizeConfidence(raw.confidence, evidenceCount),
    sources: normalizeSources(raw.sources, source)
  }
}

function normalizeRuleList(
  value: unknown,
  source: PersonalizationRuleSource,
  maxItems: number
): PersonalizationRule[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item, index) =>
      item && typeof item === 'object'
        ? normalizeRule(item as RawRule, index, source)
        : null
    )
    .filter((item): item is PersonalizationRule => item !== null)
    .slice(0, maxItems)
}

function normalizeCandidate(
  value: RawCandidate,
  source: PersonalizationRuleSource | 'synthesis'
): CandidateBundle {
  const cognitiveSource = source === 'synthesis' ? 'knowledge-base' : source
  const spokenSource = source === 'synthesis' ? 'qa-feedback' : source
  return {
    cognitiveRules: normalizeRuleList(value.cognitiveRules, cognitiveSource, 10),
    expressionRules: normalizeRuleList(
      value.expressionRules,
      cognitiveSource,
      10
    ),
    spokenRules:
      source === 'knowledge-base'
        ? []
        : normalizeRuleList(value.spokenRules, spokenSource, 10),
    antiPatterns: normalizeRuleList(value.antiPatterns, cognitiveSource, 8),
    boundaries: Array.isArray(value.boundaries)
      ? value.boundaries
          .map((item) => cleanText(item, 500))
          .filter((item) => item && !PRIVATE_FACT_PATTERN.test(item))
          .slice(0, 8)
      : []
  }
}

function extractionMessages(
  corpusText: string,
  chunkIndex: number,
  chunkCount: number
): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `你正在从私人知识库中提炼一套跨语言的 Personal Cognitive Voice。

目标不是总结内容、复述作者经历、生成 Persona 传记或套用回答模板，而是识别可迁移的认知和写作行为：
- 他首先注意什么、如何定义和拆解问题
- 如何比较证据、处理矛盾、不确定性、边界与取舍
- 如何从事实走向判断和行动
- 写作时如何控制抽象程度、信息顺序、论证密度和读者关系
- 明确反复出现的反模式

绝对隐私规则：
1. 不得输出姓名、人物关系、公司、学校、项目名、地点、日期、金额、健康、情绪、家庭、求职、财务或具体事件。
2. 不得引用原句，不得保留专有名词，不得概括个人处境。
3. 知识库不能作为说话风格证据，因此 spokenRules 必须为空。
4. 每条规则必须描述“在什么情况下如何选择”，不能是固定句式、万能结构或内容观点。
5. 仅凭单次出现的内容标为 candidate；至少两个独立片段支持才可标 supported；至少三个跨场景证据且能预测新问题时才可标 stable。
6. 控制输出规模：cognitiveRules 最多 4 条、expressionRules 最多 4 条、antiPatterns 最多 2 条；每个文本字段不超过 100 个汉字。

只输出 JSON：
{
  "cognitiveRules": [
    {
      "title": "短标题",
      "instruction": "可执行的抽象规律",
      "appliesWhen": "触发情境",
      "avoid": "容易偏离的做法",
      "evidenceCount": 1,
      "confidence": "candidate|supported|stable",
      "sources": ["knowledge-base"]
    }
  ],
  "expressionRules": [],
  "spokenRules": [],
  "antiPatterns": [],
  "boundaries": []
}`
    },
    {
      role: 'user',
      content: `知识库匿名样本 ${chunkIndex + 1}/${chunkCount}：\n<private_corpus>\n${corpusText}\n</private_corpus>`
    }
  ]
}

function feedbackEvidence(
  evidence: PersonalizationFeedbackEvidence[],
  qaHistory: QARecord[],
  sessionHistory: ConversationSession[]
): {
  text: string
  records: number
  approvedAnswers: number
} {
  const evidenceQAIds = new Set(
    evidence.filter((item) => item.qaId).map((item) => item.qaId as string)
  )
  const legacy = qaHistory
    .filter(
      (qa) =>
        !evidenceQAIds.has(qa.id) &&
        Boolean(
          qa.feedback?.trim() ||
          qa.feedbackDetail?.approved ||
          qa.feedbackDetail?.preferredAnswer?.trim()
        )
    )
    .sort(
      (a, b) =>
        (b.feedbackUpdatedAt ?? b.timestamp) - (a.feedbackUpdatedAt ?? a.timestamp)
    )
    .slice(0, MAX_FEEDBACK_ITEMS)

  const selected = [
    ...evidence.map((item) => ({
      id: item.qaId ?? item.id,
      question: item.question ?? '',
      answer: item.answer ?? '',
      feedback: item.feedback,
      feedbackDetail: item.feedbackDetail,
      feedbackUpdatedAt: item.updatedAt,
      timestamp: item.createdAt,
      mode: 'normal' as const,
      detectedLanguage: undefined,
      answerLanguageCode: item.feedbackDetail?.languageCode
    })),
    ...legacy
  ]
    .sort(
      (a, b) =>
        (b.feedbackUpdatedAt ?? b.timestamp) - (a.feedbackUpdatedAt ?? a.timestamp)
    )
    .slice(0, MAX_FEEDBACK_ITEMS)

  const blocks: string[] = []
  let characters = 0
  let approvedAnswers = 0
  for (const qa of selected) {
    const detail = qa.feedbackDetail
    if (detail?.approved) approvedAnswers += 1
    const block = [
      `<qa language="${detail?.languageCode ?? qa.answerLanguageCode ?? qa.detectedLanguage?.code ?? 'unknown'}">`,
      `问题：${qa.question.slice(0, 1200)}`,
      `AI 回答：${qa.answer.slice(0, 4000)}`,
      qa.feedback ? `用户反馈：${qa.feedback.slice(0, 2000)}` : '',
      detail?.dimensions?.length
        ? `反馈维度：${detail.dimensions.join(', ')}`
        : '',
      detail ? `适用范围：${detail.scope}` : '',
      detail?.approved ? '用户确认：这版已经像我' : '',
      detail?.preferredAnswer
        ? `用户认可的改写：${detail.preferredAnswer.slice(0, 4000)}`
        : '',
      '</qa>'
    ]
      .filter(Boolean)
      .join('\n')
    if (blocks.length > 0 && characters + block.length > MAX_FEEDBACK_CHARACTERS) break
    blocks.push(block)
    characters += block.length
  }

  const evidenceSessionIds = new Set(
    evidence
      .filter((item) => item.kind === 'session')
      .map((item) => item.sessionId)
  )
  const overall = sessionHistory
    .filter(
      (session) =>
        !evidenceSessionIds.has(session.id) && session.overallFeedback?.trim()
    )
    .sort(
      (a, b) =>
        (b.overallFeedbackUpdatedAt ?? b.updatedAt) -
        (a.overallFeedbackUpdatedAt ?? a.updatedAt)
    )
    .slice(0, 8)
    .map(
      (session) =>
        `<session_feedback>${session.overallFeedback?.slice(0, 5000)}</session_feedback>`
    )
  blocks.push(...overall)

  return {
    text: blocks.join('\n\n'),
    records: selected.length + overall.length,
    approvedAnswers
  }
}

function feedbackMessages(text: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `你正在从用户对 App 问答的明确反馈中提炼跨语言的 Personal Cognitive Voice。

证据解释：
- 用户亲自改写的 preferredAnswer 权重最高。
- approved 回答是正向说话样本。
- 用户点评揭示“AI 做错了什么”和应采用的替代行为。
- AI 原回答本身不是用户风格证据，除非用户确认或改写。

提炼目标：
1. cognitiveRules：反馈明确揭示的思考、判断与取舍规律。
2. spokenRules：真实问答中如何组织口语、控制语气、信息密度、确定性和听者关系。重点识别用户对短句、常用词、具体场景、自然语序和可直接朗读性的要求。
3. antiPatterns：用户明确不接受的思路和表达行为。
4. 规则默认跨语言成立；只有反馈明确说“仅当前语言”时才限制语言。

禁止：
- 不复述问答内容、个人经历或原句。
- 不生成固定开头、三段式、万能模板或口头禅集合。
- 不从知识库写作推断说话习惯。
- 不把事实纠错误判成稳定人格。
- 不把“口语化”弱化为随意语气。用户明确拒绝的书面腔、翻译腔、长难句、抽象概念堆叠和 AI 套话必须进入 spokenRules 或 antiPatterns。
- 控制输出规模：cognitiveRules 最多 4 条、spokenRules 最多 4 条、antiPatterns 最多 3 条；每个文本字段不超过 100 个汉字。

只输出 JSON，字段结构与规则格式如下：
{
  "cognitiveRules": [],
  "expressionRules": [],
  "spokenRules": [
    {
      "title": "短标题",
      "instruction": "按情境执行的跨语言规律",
      "appliesWhen": "触发情境",
      "avoid": "不像用户的做法",
      "evidenceCount": 1,
      "confidence": "candidate|supported|stable",
      "sources": ["qa-feedback|session-feedback|user-confirmed"]
    }
  ],
  "antiPatterns": [],
  "boundaries": []
}`
    },
    {
      role: 'user',
      content: `<feedback_evidence>\n${text}\n</feedback_evidence>`
    }
  ]
}

function compactCandidate(candidate: CandidateBundle): object {
  const compactRule = (rule: PersonalizationRule) => ({
    title: rule.title,
    instruction: rule.instruction,
    appliesWhen: rule.appliesWhen,
    avoid: rule.avoid,
    evidenceCount: rule.evidenceCount,
    confidence: rule.confidence,
    sources: rule.sources
  })
  return {
    cognitiveRules: candidate.cognitiveRules.map(compactRule),
    expressionRules: candidate.expressionRules.map(compactRule),
    spokenRules: candidate.spokenRules.map(compactRule),
    antiPatterns: candidate.antiPatterns.map(compactRule),
    boundaries: candidate.boundaries
  }
}

function synthesisMessages(
  existing: PersonalizationProfile,
  candidates: CandidateBundle[]
): ChatMessage[] {
  const existingCandidate: CandidateBundle = {
    cognitiveRules: existing.cognitiveRules,
    expressionRules: existing.expressionRules,
    spokenRules: existing.spokenRules,
    antiPatterns: existing.antiPatterns,
    boundaries: existing.boundaries
  }

  return [
    {
      role: 'system',
      content: `把多批候选规律合并成一套统一、跨语言、按情境运行的 Personal Cognitive Voice。

合并原则：
1. 这是一个人格系统，不是中文/英文两套风格；规则必须在不同语言中保持相同的注意力、推理、确定性、信息顺序与沟通姿态。
2. 不能生成答案模板、固定段落顺序、万能句式或角色扮演台词。
3. cognitiveRules 描述怎么想；expressionRules 描述知识库支持的写作与语义组织习惯；spokenRules 只能由反馈证据支持。
4. 在口语回答中 spokenRules 优先于 expressionRules；写作习惯只能在不破坏自然口语时提供语义层参考。
5. 合并语义重复规则；冲突时保留更具体、证据更多、更新来源更直接的版本。
6. user-confirmed 是最高优先级的直接偏好证据。除非有更新的 user-confirmed 规则明确冲突，否则不得删除或弱化。
7. 三重验证：跨场景复现、能预测新问题、具有区分度。证据不足的保留为 candidate，不能伪装成稳定规律。
8. 最多保留 cognitiveRules 6 条、expressionRules 6 条、spokenRules 8 条、antiPatterns 6 条；每个文本字段不超过 120 个汉字。

隐私门禁：
- 最终结果不得包含任何姓名、人物关系、公司、学校、项目名、地点、日期、金额、健康、情绪、家庭、求职、财务或具体事件。
- 不得保留原文引用或专有名词。
- boundaries 必须明确：知识库个人事实不可对外；经历只来自简历；说话风格只来自用户确认与反馈。

只输出 JSON，不要解释。`
    },
    {
      role: 'user',
      content: JSON.stringify({
        existing: compactCandidate(existingCandidate),
        newCandidates: candidates.map(compactCandidate)
      })
    }
  ]
}

async function runJsonTask(
  llmConfig: LLMConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
  maxTokensOverride = 3200
): Promise<RawCandidate> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    const retryInstruction: ChatMessage[] =
      attempt === 0
        ? []
        : [
            {
              role: 'user',
              content:
                '上一次响应不是完整 JSON。请从头重新生成更精简的完整 JSON：减少规则数量和字段长度，确保所有字符串、数组和对象闭合；只输出 JSON，不要解释。'
            }
          ]
    const raw = await chatOnce(
      llmConfig,
      [...messages, ...retryInstruction],
      signal,
      {
        jsonOutput: true,
        thinkingOverride: 'disabled',
        maxTokensOverride: Math.min(
          llmConfig.maxTokens,
          maxTokensOverride + attempt * 500
        )
      }
    )
    try {
      return parseJson(raw)
    } catch (error) {
      if (signal?.aborted) throw error
      lastError = error as Error
    }
  }

  throw new Error(
    `模型连续三次没有返回完整画像 JSON：${lastError?.message ?? '未知格式错误'}`
  )
}

export async function distillPersonalization(
  options: DistillPersonalizationOptions
): Promise<PersonalizationProfile> {
  if (!options.llmConfig.apiKey) throw new Error('请先配置 LLM API Key')

  const feedback = feedbackEvidence(
    options.evidence,
    options.qaHistory,
    options.sessionHistory
  )
  const knowledgeChunks = options.corpus?.chunks ?? []
  if (knowledgeChunks.length === 0 && !feedback.text) {
    throw new Error('没有可蒸馏的知识库样本或问答反馈')
  }

  const candidates: CandidateBundle[] = []
  for (let index = 0; index < knowledgeChunks.length; index++) {
    options.onProgress?.({
      stage: 'knowledge',
      completed: index,
      total: knowledgeChunks.length,
      message: `正在提炼知识库中的思考与写作规律 ${index + 1}/${knowledgeChunks.length}`
    })
    const raw = await runJsonTask(
      options.llmConfig,
      extractionMessages(knowledgeChunks[index].text, index, knowledgeChunks.length),
      options.signal,
      3200
    )
    candidates.push(normalizeCandidate(raw, 'knowledge-base'))
  }

  if (feedback.text) {
    options.onProgress?.({
      stage: 'feedback',
      completed: 0,
      total: 1,
      message: '正在从已反馈问答中提炼说话与思考规律'
    })
    const raw = await runJsonTask(
      options.llmConfig,
      feedbackMessages(feedback.text),
      options.signal,
      3200
    )
    candidates.push(normalizeCandidate(raw, 'qa-feedback'))
  }

  options.onProgress?.({
    stage: 'synthesis',
    completed: 0,
    total: 1,
    message: '正在进行跨场景验证、去重与隐私检查'
  })
  const synthesis = await runJsonTask(
    options.llmConfig,
    synthesisMessages(options.existing, candidates),
    options.signal,
    4096
  )
  const merged = normalizeCandidate(synthesis, 'synthesis')
  const requiredBoundaries = [
    '知识库只用于提炼抽象的思考与写作规律，不得输出其中的个人事实',
    '对外个人经历只能使用简历或用户在当前对话中明确授权的内容',
    '说话风格只能由用户确认过的回答和问答反馈支持',
    '同一套认知—表达规律必须跨语言保持一致，不套用固定回答模板'
  ]

  return {
    schemaVersion: 1,
    profileVersion: options.existing.profileVersion + 1,
    enabled: options.existing.enabled,
    autoDistillFeedback: options.existing.autoDistillFeedback,
    feedbackDistillThreshold: options.existing.feedbackDistillThreshold,
    status: 'active',
    knowledgeBasePath:
      options.corpus?.rootPath ?? options.existing.knowledgeBasePath,
    updatedAt: Date.now(),
    cognitiveRules: merged.cognitiveRules,
    expressionRules: merged.expressionRules,
    spokenRules: merged.spokenRules,
    antiPatterns: merged.antiPatterns,
    boundaries: [...new Set([...requiredBoundaries, ...merged.boundaries])].slice(0, 12),
    sourceStats: {
      knowledgeFilesScanned:
        options.corpus?.filesScanned ??
        options.existing.sourceStats.knowledgeFilesScanned,
      knowledgeFilesSampled:
        options.corpus?.filesSampled ??
        options.existing.sourceStats.knowledgeFilesSampled,
      knowledgeCharactersSampled:
        options.corpus?.charactersSampled ??
        options.existing.sourceStats.knowledgeCharactersSampled,
      feedbackRecords: Math.max(options.evidence.length, feedback.records),
      approvedAnswers: Math.max(
        options.evidence.filter((item) => item.feedbackDetail?.approved).length,
        feedback.approvedAnswers
      ),
      pendingFeedbackRecords: options.evidence.filter(
        (item) => !item.processedProfileVersion
      ).length
    }
  }
}

function formatRules(title: string, rules: PersonalizationRule[]): string {
  if (rules.length === 0) return ''
  return `${title}\n${rules
    .map((rule) => {
      const avoid = rule.avoid ? `；避免：${rule.avoid}` : ''
      return `- [${rule.confidence}] 当${rule.appliesWhen}：${rule.instruction}${avoid}`
    })
    .join('\n')}`
}

/** 注入生成器和复核器的紧凑运行时画像。 */
export function buildPersonalizationInstructions(
  profile: PersonalizationProfile
): string {
  if (!profile.enabled || profile.status !== 'active') return ''
  const sections = [
    formatRules('真实问答中的说话规律（口语回答时优先）', profile.spokenRules),
    formatRules('明确反模式', profile.antiPatterns),
    formatRules('认知与判断规律', profile.cognitiveRules),
    formatRules('跨语言的语义表达规律', profile.expressionRules)
  ].filter(Boolean)
  if (sections.length === 0) return ''

  return `以下是用户经证据蒸馏的 Personal Cognitive Voice。它是一套跨语言、按情境触发的行为规律，不是答案模板：

${sections.join('\n\n')}

运行要求：
1. 只激活与当前问题相关的规则，不要为了展示风格而把所有规则塞进一条回答。
2. 无论输出中文还是英文，都保持相同的注意力分配、推理方式、确定性、信息顺序和沟通姿态；使用目标语言自然表达，禁止逐句翻译腔。
3. 口语回答以“说话规律”为最高风格证据。若写作规律会带来长句、概念堆叠、表格、报告结构或高信息密度，口语回答必须忽略该写作规律。
4. 不得提及画像、蒸馏、规则或反馈，不得使用固定开头、三段式和万能句式。
5. 画像不提供事实权威。正确性、题目证据、简历和用户当前明确表达始终优先。
6. 不得从画像或知识库泄露、推断个人事实。对外经历只能来自简历或当前对话明确授权的内容。`
}

/**
 * 新反馈在完成下一轮画像合并前先直接生效，保证“保存反馈 → 下一次回答调整”
 * 不依赖后台蒸馏是否已经跑完。
 */
export function buildPendingFeedbackInstructions(
  evidence: PersonalizationFeedbackEvidence[]
): string {
  const pending = evidence
    .filter((item) => !item.processedProfileVersion)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 12)
  if (pending.length === 0) return ''

  const items = pending.map((item) => {
    const detail = item.feedbackDetail
    const parts = [
      item.feedback ? `要求：${item.feedback}` : '',
      detail?.dimensions.length
        ? `调整维度：${detail.dimensions.join('、')}`
        : '',
      detail?.preferredAnswer
        ? `用户认可的改写：${detail.preferredAnswer.slice(0, 1200)}`
        : '',
      detail?.approved ? '当前回答已被用户确认为正向样本' : '',
      detail?.scope === 'current-language'
        ? `只适用于 ${detail.languageCode ?? '当前'} 语言`
        : detail?.scope === 'similar-situations'
          ? `只用于相似场景：${item.question?.slice(0, 300) ?? '本次场景'}`
          : '可作为跨语言的通用候选规律'
    ].filter(Boolean)
    return `- ${parts.join('；')}`
  })

  return `以下是尚未合并进稳定画像的新反馈。它们立即生效，但仍是待验证的增量证据；不要在答案中提及反馈：
${items.join('\n')}`
}
