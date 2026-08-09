/**
 * 问题提取服务
 *
 * 核心职责:
 *  1. 从连续语音识别文本流中判断"这段话是否是一个正式提问"
 *  2. 把口语化的提问提炼成清晰的问题文本(指代消解)
 *  3. 利用对话历史做上下文关联,例如:
 *       前文:提问者问"vue2 和 vue3 有什么区别"
 *       后文:提问者说"区别是啥呢"
 *     → 应识别为"vue2 和 vue3 的区别"而非泛化提问
 *
 * 实现方式:
 *  - 用一个轻量的 LLM 调用做判断 + 提取
 *  - 使用 system prompt 严格控制输出(JSON),避免污染主流程
 *  - 同时维护最近 N 条对话历史作为上下文
 */

import type {
  LLMConfig,
  DialogTurn,
  AnswerMode,
  AnswerStrategyKind,
  DetectedLanguage,
  Region,
  QARecord,
  ConversationSession,
  LLMCallPerformance
} from '@shared/types'
import {
  chatOnce,
  getResponseLanguageMeta,
  type ChatMessage,
  type ResponseLanguage
} from './llm'
import { hasCorrectiveQAFeedback } from './answer-strategy'

export interface ExtractResult {
  /** 是否是一个正式提问 */
  isQuestion: boolean
  /** 问题是否已经表达完整；false 时继续等待后续语音 */
  isComplete: boolean
  /** 是否在邀请用户/听众进入 QA 环节并主动提出问题。 */
  isQaInvitation: boolean
  /** 提取后的问题文本(已做指代消解),isQuestion=false 时为空 */
  question: string
  /** 推断的说话人角色 */
  role: 'interviewer' | 'candidate' | 'unknown'
  /** 最新语音文本的主要语言 */
  detectedLanguage: DetectedLanguage
}

const DETECTION_CONTEXT_TURNS = 12
const NORMAL_DIALOG_TURNS = 8
const NORMAL_QA_PAIRS = 4
const EXTENDED_CONTEXT_ITEMS = 80
const EXTENDED_MATERIAL_TOKENS = 40_000
const EXTENDED_QA_TOKENS = 40_000
const EXTENDED_DIALOG_TOKENS = 20_000
const NORMAL_DIALOG_TOKENS = 1_800
const NORMAL_QA_TOKENS = 2_500
const FEEDBACK_ITEMS = 12
const FEEDBACK_TOKENS = 3_000
const OVERALL_FEEDBACK_ITEMS = 6
const OVERALL_FEEDBACK_TOKENS = 3_000

const LANGUAGE_NAMES: Record<string, string> = {
  zh: 'Simplified Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  ru: 'Russian',
  ar: 'Arabic',
  hi: 'Hindi'
}

function inferLanguageFromText(text: string): DetectedLanguage {
  const hanCount = text.match(/\p{Script=Han}/gu)?.length ?? 0
  const letterCount = text.match(/\p{L}/gu)?.length ?? 0

  if (hanCount > 0 && (letterCount === 0 || hanCount / letterCount >= 0.25)) {
    return { code: 'zh', name: LANGUAGE_NAMES.zh, isChinese: true }
  }
  if (/[A-Za-z]/.test(text)) {
    return { code: 'en', name: LANGUAGE_NAMES.en, isChinese: false }
  }
  return { code: 'und', name: 'Detected language', isChinese: false }
}

/** 对模型返回的语言信息做清洗,JSON 缺失时使用轻量本地检测降级。 */
export function normalizeDetectedLanguage(value: unknown, text: string): DetectedLanguage {
  if (!value || typeof value !== 'object') return inferLanguageFromText(text)

  const raw = value as Partial<DetectedLanguage>
  const code =
    typeof raw.code === 'string' && /^[a-z]{2,3}(?:-[a-z]{2,4})?$/i.test(raw.code)
      ? raw.code.toLowerCase()
      : 'und'
  const baseCode = code.split('-')[0]
  const fallback = inferLanguageFromText(text)
  const name =
    LANGUAGE_NAMES[baseCode] ??
    ((typeof raw.name === 'string'
      ? raw.name.replace(/[^\p{L}\p{M}\s()_-]/gu, '').trim().slice(0, 40)
      : '') || fallback.name)
  const isChinese = baseCode === 'zh' || (baseCode === 'und' && fallback.isChinese)

  return { code: code === 'und' ? fallback.code : code, name, isChinese }
}

/**
 * 构造问题提取的 system prompt
 */
function buildSystemPrompt(region: Region): string {
  const langHint =
    region === 'zh'
      ? 'question 字段只使用简体中文。'
      : region === 'en'
        ? 'The question field must be in English only.'
        : 'question 字段保持原文语言,不翻译。'
  return `判断最新语音文本是否构成正式提问。规则:
- 正式提问:”请说X””介绍X””X怎么实现””X和Y区别””为什么X”等。追问也是提问,须结合对话历史补全对象
- 闲聊/应答/自言自语 → 非问题
- “你还有什么问题吗”“大家有问题可以提问”“Any questions?” 等邀请用户或听众主动提问的话，isQaInvitation=true；不要把它误当成需要用户回答的知识问题
- 有指代须结合对话历史消解,补全省略的主语
- isComplete: 问题意图和询问点均明确才true。文本像半句话、以连接词或铺垫结尾(如”我想问一下…””除了这个还有…”)→false,宁可多等一段也不要抢答
- 从最新文本检测语言,不参考历史
- 只输出JSON,键名必须为 isQuestion/isComplete/isQaInvitation/question/role/detectedLanguage

{
  “isQuestion”: bool,
  “isComplete”: bool,
  “isQaInvitation”: bool,
  “question”: “完整问题或空字符串”,
  “role”: “interviewer|candidate|unknown”,
  “detectedLanguage”: {“code”:”zh|en”,”name”:”English”,”isChinese”:bool}
}
${langHint}`
}

/**
 * 把对话历史 + 当前文本构造为 LLM messages
 */
function buildMessages(
  currentText: string,
  history: DialogTurn[],
  region: Region,
  sessionPresetContext = ''
): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(region) }
  ]

  // 拼接对话历史(最近 N 条)
  const presetText = sessionPresetContext.trim()
    ? `本轮会话预设（只用于理解话题、指代和省略，不要把其中列出的问题当成当前已经被问到的问题）:\n${sessionPresetContext.trim().slice(0, 5000)}\n\n`
    : ''
  const recent = history.slice(-DETECTION_CONTEXT_TURNS)
  if (recent.length > 0) {
    const historyText = recent
      .map((t) => {
        const roleLabel =
          t.role === 'interviewer' ? '提问者' : t.role === 'self' ? '我' : t.role === 'candidate' ? '回答者' : '未知'
        return `[${roleLabel}] ${t.text}`
      })
      .join('\n')
    messages.push({
      role: 'user',
      content: `${presetText}对话历史:\n${historyText}\n\n最新一段语音识别文本:\n${currentText}\n\n请判断这段最新文本是否是一个正式提问,并提取。`
    })
  } else {
    messages.push({
      role: 'user',
      content: `${presetText}最新一段语音识别文本:\n${currentText}\n\n请判断这段文本是否是一个正式提问,并提取。`
    })
  }

  return messages
}

/**
 * 从一段识别文本中提取正式提问
 *
 * 优化:使用 JSON Output + 关闭思考模式
 *  - 问题提取是简单判断任务,不需要思维链,关闭思考可大幅降低延迟
 *  - JSON Output 保证输出结构合法,避免解析失败
 */
export async function extractQuestion(
  llmConfig: LLMConfig,
  currentText: string,
  history: DialogTurn[],
  region: Region,
  sessionPresetContext = '',
  signal?: AbortSignal,
  metricsCallback?: (metrics: LLMCallPerformance) => void
): Promise<ExtractResult> {
  const messages = buildMessages(
    currentText,
    history,
    region,
    sessionPresetContext
  )

  let raw = ''
  try {
    raw = await chatOnce(
      llmConfig,
      messages,
      signal,
      {
        // 强制关闭思考:问题提取要快,毫秒级响应
        thinkingOverride: 'disabled',
        // 启用 JSON Output:保证输出合法 JSON
        jsonOutput: true,
        task: 'extract',
        metricsCallback,
        // JSON 响应很短,收紧上限加速输出
        maxTokensOverride: 150
      }
    )
  } catch (err) {
    throw new Error(`问题提取 LLM 调用失败: ${(err as Error).message}`)
  }

  // 解析 JSON(即便用了 JSON Output,仍做容错:某些兼容端点可能不严格遵循)
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()

  try {
    const parsed = JSON.parse(cleaned) as Partial<ExtractResult>
    return {
      isQuestion: Boolean(parsed.isQuestion),
      isComplete: parsed.isComplete === true,
      isQaInvitation: parsed.isQaInvitation === true,
      question: parsed.question?.trim() ?? '',
      role: parsed.role ?? 'unknown',
      detectedLanguage: normalizeDetectedLanguage(parsed.detectedLanguage, currentText)
    }
  } catch {
    // JSON 解析失败,降级:整段文本作为问题
    return {
      isQuestion: true,
      // 无法可靠解析模型结果时宁可多等一段，也不要对半句话抢答。
      isComplete: false,
      isQaInvitation: looksLikeQaInvitation(currentText),
      question: currentText.trim(),
      role: 'interviewer',
      detectedLanguage: inferLanguageFromText(currentText)
    }
  }
}

/** LLM 漏判时的保守本地降级，只匹配明确的听众提问邀请。 */
export function looksLikeQaInvitation(text: string): boolean {
  const normalized = text.normalize('NFKC').toLocaleLowerCase().trim()
  if (!normalized) return false
  return [
    /(?:你|您|大家|各位|听众|参会者).{0,12}(?:还有|有没有|是否有|有).{0,8}(?:问题|疑问).{0,8}(?:问|提|交流|讨论|吗|呢)?/u,
    /(?:还有|有没有|是否有).{0,8}(?:什么)?(?:问题|疑问).{0,8}(?:问我|提问|交流|吗|呢)?/u,
    /(?:现在|接下来|下面).{0,8}(?:进入|开始|开放).{0,4}(?:qa|q&a|问答|提问)(?:环节|时间)?/u,
    /(?:欢迎|可以|请).{0,8}(?:大家|各位|你|您)?.{0,8}(?:提问|问我|交流问题)/u,
    /\b(?:any|more) questions?(?: for me| from (?:you|the audience))?\b/u,
    /\b(?:open|move|moving) (?:the floor|up) (?:for|to) (?:questions|q&a)\b/u,
    /\bquestions? (?:are|is) welcome\b/u
  ].some((pattern) => pattern.test(normalized))
}

// ============== 答案生成 ==============

/**
 * 构造答案生成的 system prompt
 */
function estimateTokens(text: string): number {
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0
  return Math.ceil(han * 0.85 + Math.max(0, text.length - han) / 3.8)
}

function takeTextWithTokenBudget(text: string, tokenBudget: number): string {
  if (estimateTokens(text) <= tokenBudget) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (estimateTokens(text.slice(0, middle)) <= tokenBudget) low = middle
    else high = middle - 1
  }
  return text.slice(0, low)
}

function contextText(text: string | undefined, extended: boolean, normalLimit: number): string {
  if (!text?.trim()) return ''
  // 1M 是整个请求的总窗口，不应让单份资料独占全部空间。
  const limit = extended ? EXTENDED_MATERIAL_TOKENS : normalLimit
  return takeTextWithTokenBudget(text.trim(), limit)
}

function takeRecentWithBudget<T>(
  items: T[],
  limit: number,
  tokenBudget: number,
  getText: (item: T) => string
): T[] {
  const selected: T[] = []
  let used = 0
  for (let index = items.length - 1; index >= 0 && selected.length < limit; index--) {
    const item = items[index]
    const size = estimateTokens(getText(item))
    if (selected.length > 0 && used + size > tokenBudget) break
    selected.push(item)
    used += size
  }
  return selected.reverse()
}

export function buildAnswerSystemPrompt(
  position: string,
  mode: AnswerMode,
  language: ResponseLanguage,
  resume?: string,
  knowledgeBase?: string,
  extendedContext = false
): string {
  const languageMeta = getResponseLanguageMeta(language)
  const modeHintZh: Record<AnswerMode, string> = {
    normal: '直接讲清核心逻辑，通常用 2–3 句话，回答到位就停。',
    concise: '普通问题只说最关键的逻辑；项目经历和技术探索题仍要用短句补齐必要的场景、机制与验证，不得用“简洁”掩盖信息缺口。',
    algorithm: '先用 2–3 句话讲清思路；只有对方明确要代码时才给代码，再用一句话说明复杂度。',
    'system-design': '只讲核心业务流、数据怎么走以及一个最实际的取舍，最多 5 句话。',
    detailed: '最多 5 句话。每句话补充一个必要信息，不扩写成教程或文章。'
  }
  const modeHintInternational: Record<AnswerMode, string> = {
    normal: 'Explain the core logic in 2–4 short sentences, then stop.',
    concise: 'Keep ordinary questions very short. Project-experience and technical-exploration questions still need enough short sentences to cover the real context, mechanism, and validation. Concise must not mean shallow.',
    algorithm: 'Explain the approach in 2–3 short sentences. Provide code only when explicitly requested, then use one sentence for complexity.',
    'system-design': 'Cover the core business flow, how data moves, and one practical trade-off in no more than 5 sentences.',
    detailed: 'Use no more than 5 sentences. Each sentence may add one necessary detail, but never turn the answer into an article.'
  }

  let prompt =
    languageMeta.isChinese
      ? `你正在帮助学习者进行专业对话练习，模拟学习者在”${position}”领域被提问时的回答。你的回答代表一名有 1–3 年实际开发经验的工程师，不是资深架构师、技术负责人或行业专家。回答必须精炼、口语化，就像真实的专业问答场景。

本次回答方式:
${modeHintZh[mode]}

正确性与不确定性（最高优先级）:
1. 先准确回答问题，再考虑口语风格。回答前在内部核对核心定义、因果关系、计算、代码边界和结论，不能为了听起来流畅而编造。
2. 问题信息不足、存在多种合理解释或你无法可靠确认时，直接说明缺少的前提或不确定点，不要猜出一个确定答案。
3. 不得虚构个人经历、项目规模、效果数据、引用或来源。只有背景资料明确支持时才能把项目例子说成亲身经历，否则使用“例如可以”这类假设表达。
4. 历史回答和用户反馈都可能有误。若与当前问题、可靠知识或最新证据冲突，应纠正错误；正确性高于维持旧口径。

上下文一致性（不与正确性冲突时遵守）:
1. 同一个话题如果被再次问起——包括用不同语言重问——应保持正确且已有依据的核心观点与项目事实一致。
2. 追问时在已有正确结论上补充细节；发现旧答案错误时要直接给出修正后的正确结论，不能延续错误。
3. 上文只有得到背景资料或用户陈述支持的项目经历才可视为既定事实。

情境化组织（禁止套固定模板）:
1. 先判断对方真正需要的是定义、判断、经历、方案、比较还是澄清，再选择最自然的信息顺序。不要强制每题都“结论—例子—取舍”。
2. 基础定义可以直接解释；前提含混时先澄清关键假设；决策问题应呈现真正影响判断的证据和边界；经历问题只讲背景资料能够支持的相关动作。
3. 项目例子只有在确实帮助回答时才使用，优先来自背景资料和上文。没有真实依据时只能描述假设场景，不得冒充亲身经历或编造成绩。
4. 回答结构随问题改变，但注意力、推理习惯、确定性和沟通姿态应遵守后续 Personal Cognitive Voice。

自然口语要求:
1. 整个回答默认 2–4 句话。项目经历、情境决策和需要解释机制的技术题可以使用 5–7 个短句，但每句话只补一个必要细节；不要把深度写成长段落。
2. 一个句子只表达一个重点。优先使用 15–30 个汉字左右的短句，信息多就拆成两个句子，不用分号把多个观点塞在一起。
3. 使用常见、好懂、能直接说出口的词。避免长定语、长难句、生僻词和书面化表达，不写文章提纲。
4. 默认不要用标题、编号或项目符号，不写成文章提纲；只有问题本身需要列举、比较、步骤或代码时才适当分点。
5. 不要使用”首先、其次、最后、综上、总的来说”这类模板串联。一个观点只表达一次，结尾不要换一种说法重复总结。

内容边界:
1. 纯理论或基础知识问题，先说正确的定义或核心逻辑；只有背景资料支持且能帮助理解时才补一个很短的项目例子。
2. 项目例子只选一个动作或场景，不讲完整项目背景。对方明确追问经历时，才增加必要细节。
3. 优先讲清楚业务目标、数据或请求怎么流转、为什么这样处理。能用普通话说明的，不堆技术术语、设计模式或方法论名称。
4. 除非对方明确追问，否则不要主动罗列具体方法名、类名、框架内部 API、架构术语或冷门概念。
5. 按 1–3 年开发者能合理掌握的深度回答。遇到大型架构问题时说明最核心、最实际的做法，不假装做过超大规模系统，也不主动做容量估算和复杂治理方案。
6. 严格遵守上文已经确定的业务背景、技术选择和个人经历。若新问题与旧约束冲突，以对方最新表达为准；不要机械复述上一轮答案。
7. 历史回答只用于保持事实和口径一致。不要模仿历史回答的长度、长句、术语密度或结构，本轮始终执行上面的短答规则。

你必须只使用简体中文回答。即使问题、对话历史、背景资料或参考资料包含英文,也不要附带英文解释或英文对照。技术专有名词、代码、API 名称和标识符可保留原文。
直接输出自然回答，不要加”好的””我来回答”之类的引导语。`
      : `You are helping a learner practice professional Q&A scenarios, answering as if the learner (a developer with 1–3 years of hands-on experience, not a senior architect, tech lead, or industry expert) were responding to a “${position}” question. The learner may say your answer aloud word for word. Write what a native English-speaking engineer would naturally say in a real team conversation, not what they would write in a document.

Answer approach:
${modeHintInternational[mode]}

Correctness and calibrated uncertainty (HIGHEST PRIORITY):
1. Answer accurately before optimizing for spoken style. Internally verify the core definition, causal claim, calculation, code edge case, and conclusion. Never invent details to sound fluent.
2. If the question lacks essential facts, has multiple reasonable interpretations, or cannot be confirmed reliably, state the missing premise or uncertainty instead of guessing a definite answer.
3. Never fabricate personal experience, project scale, metrics, citations, or sources. Claim firsthand experience only when the learner background explicitly supports it; otherwise use hypothetical wording.
4. Earlier answers and user feedback can be wrong. Correct them when they conflict with the current question, reliable knowledge, or newer evidence. Correctness is more important than preserving an old stance.

Cross-turn consistency (when it does not conflict with correctness):
1. Keep supported project facts and correct technical judgments consistent when the same topic is asked again.
2. Add detail to earlier correct conclusions on follow-ups. If an earlier answer was wrong, give the corrected conclusion instead of continuing the error.
3. Treat a project example as established fact only when it is supported by the learner background or an explicit user statement.

Context-sensitive organization (NEVER use a fixed response template):
1. Identify whether the question needs a definition, judgment, experience, plan, comparison, or clarification, then choose the most natural information order. Do not force every answer into “claim, example, trade-off.”
2. Explain a basic definition directly. Clarify a crucial premise when it is ambiguous. For a decision, expose only the evidence and boundary that truly affect the judgment. For experience, use only relevant actions supported by the background.
3. Use a project example only when it materially helps. Ground it in the background or earlier context; otherwise describe a hypothetical scenario without claiming it happened.
4. Let structure change with the question while preserving the attention, reasoning, uncertainty, and communication posture in the Personal Cognitive Voice below.

Natural spoken style:
1. Use 2–4 sentences by default. A project experience, situational decision, or technical mechanism may use 5–7 short sentences when that is needed to preserve the evidence chain. Keep every sentence focused; depth must not become a long paragraph.
2. Put only one main idea in each sentence. Aim for 6–14 words. Treat 18 words as a hard maximum except for an unavoidable code name or technical term.
3. Split any sentence that needs a semicolon, more than one comma, or a chain of clauses. A short answer is more useful than a polished paragraph.
4. Think directly in everyday spoken English. Do not translate a formal or Chinese-style sentence into English. Use natural contractions when they make the line easier to say.
5. Prefer plain verbs such as “use”, “check”, “fix”, “help”, “keep”, “change”, and “send”. Avoid noun-heavy phrases, rare words, business language, and stacked technical terms.
6. Give the direct answer in the first sentence. For a “how”, “why”, or experience question, use one clear situation and one concrete action when the context supports it. Do not stay at the level of concepts.
7. Avoid headings, numbered lists, and article-like outlines unless the question itself calls for a list, comparison, steps, or code.
8. State each idea once. Do not restate the conclusion at the end. Avoid essay bridges such as “moreover”, “furthermore”, “therefore”, “in conclusion”, and “it is important to note”.

Spoken rewrite examples:
- Do not say: “I would leverage a structured approach to facilitate cross-functional alignment.”
- Say: “I first check what each team needs. Then we agree on one next step.”
- Do not say: “This solution provides a robust and scalable mechanism for optimizing performance.”
- Say: “This keeps the slow work out of the request. It also makes failures easier to retry.”

Content boundaries:
1. For a theory or fundamentals question, state the correct core logic. Add a short project application only when the learner background supports it and it improves understanding.
2. Keep the project example to one action or scenario. Add more experience details only when the questioner asks for them.
3. Explain the business goal, request/data flow, and practical reason before terminology. Replace an abstract concept with a concrete actor, action, or result whenever possible. Do not pile on pattern names, methodologies, or buzzwords.
4. Unless explicitly asked, do not enumerate method names, class names, internal framework APIs, architecture labels, or obscure concepts.
5. Stay within the credible depth of a 1–3 year developer. For large-system questions, explain the practical core without pretending to have built hyperscale systems or volunteering elaborate governance and capacity plans.
6. Follow constraints, choices, and experience established earlier. If they conflict, the questioner's latest statement wins. Do not mechanically repeat the previous answer.
7. Prior answers are factual context only. Never copy their length, sentence style, terminology density, or structure. Always follow the short-answer rules above for the current turn.

You must answer in ${languageMeta.name} (${languageMeta.code}) only. Even if the conversation history, background material, or reference material contains another language, do not switch languages and do not include a bilingual translation in the main answer. Proper nouns, code, API names, and identifiers may remain in their original form.
Output the answer directly without introductory filler.`

  const resumeContext = contextText(resume, extendedContext, 1600)
  if (resumeContext) {
    prompt +=
      languageMeta.isChinese
        ? `\n\n学习者的背景资料（项目例子优先从这里选择，但每题只取最相关的一个动作，不要复述整段经历）:\n${resumeContext}`
        : `\n\nLearner background (ground the short project example here when relevant; use only one relevant action and do not retell the full project):\n${resumeContext}`
  }
  const knowledgeContext = contextText(knowledgeBase, extendedContext, 2800)
  if (knowledgeContext) {
    prompt +=
      languageMeta.isChinese
        ? `\n\n参考资料/自定义问答库（只吸收相关事实，不照抄其中的书面表达）:\n${knowledgeContext}`
        : `\n\nReference material (use relevant facts, but do not copy its written style):\n${knowledgeContext}`
  }

  return prompt
}

/** 短答场景的输出上限，避免模型在满足核心问题后继续扩写。 */
export function getSpokenAnswerMaxTokens(
  mode: AnswerMode,
  language: ResponseLanguage,
  strategy?: AnswerStrategyKind
): number {
  const isEnglish = getResponseLanguageMeta(language).code === 'en'
  const limits: Record<AnswerMode, number> = isEnglish
    ? { normal: 150, concise: 90, algorithm: 800, 'system-design': 220, detailed: 260 }
    : { normal: 280, concise: 180, algorithm: 900, 'system-design': 360, detailed: 420 }
  const strategyMinimum =
    strategy === 'project-scenario'
      ? isEnglish
        ? 240
        : 440
      : strategy === 'technical-design' ||
          strategy === 'project-deep-dive' ||
          strategy === 'project-overview'
        ? isEnglish
          ? 210
          : 380
        : 0
  return Math.max(limits[mode], strategyMinimum)
}

/**
 * 生成 AI Mentor 回答(流式)
 */
export function buildAnswerMessages(
  question: string,
  history: DialogTurn[],
  qaHistory: QARecord[],
  position: string,
  mode: AnswerMode,
  language: ResponseLanguage,
  resume?: string,
  knowledgeBase?: string,
  contextSummary?: string,
  contextCompressedAt?: number,
  extendedContext = false,
  feedbackHistory: QARecord[] = qaHistory,
  sessionHistory: ConversationSession[] = [],
  personalizationInstructions = '',
  sessionPresetInstructions = ''
): ChatMessage[] {
  const languageMeta = getResponseLanguageMeta(language)
  let system = buildAnswerSystemPrompt(
    position,
    mode,
    language,
    resume,
    knowledgeBase,
    extendedContext
  )

  if (contextSummary?.trim()) {
    system += languageMeta.isChinese
      ? `\n\n此前对话的压缩上下文（这是事实和约束摘要，不要在回答中复述摘要本身）:\n${contextSummary.trim()}`
      : `\n\nCompressed context from the earlier conversation (treat it as facts and constraints; do not repeat the summary itself):\n${contextSummary.trim()}`
  }

  if (sessionPresetInstructions.trim()) {
    system += `\n\n${sessionPresetInstructions.trim()}`
  }

  if (personalizationInstructions.trim()) {
    system += `\n\n${personalizationInstructions.trim()}`
  }

  const recentFeedback = feedbackHistory
    .filter((qa) => qa.feedback?.trim())
    .sort((a, b) => (b.feedbackUpdatedAt ?? b.timestamp) - (a.feedbackUpdatedAt ?? a.timestamp))
    .slice(0, FEEDBACK_ITEMS)
  const feedbackText = takeRecentWithBudget(
    recentFeedback.slice().reverse(),
    FEEDBACK_ITEMS,
    FEEDBACK_TOKENS,
    (qa) => `${qa.question}\n${qa.feedback ?? ''}`
  )
    .map((qa) => `- ${qa.feedback?.trim()}（来自问题：${qa.question.slice(0, 120)}）`)
    .join('\n')

  if (feedbackText) {
    system += languageMeta.isChinese
      ? `\n\n用户对之前回答的复盘反馈（后续回答必须自动改进，越新的反馈优先；只应用要求，不要在答案中提到反馈本身）:\n${feedbackText}`
      : `\n\nUser feedback on earlier answers (adapt future answers automatically; newer feedback wins; apply it silently and never mention the feedback itself):\n${feedbackText}`
  }

  const recentOverallFeedback = sessionHistory
    .filter((session) => session.overallFeedback?.trim())
    .sort((a, b) =>
      (b.overallFeedbackUpdatedAt ?? b.updatedAt) - (a.overallFeedbackUpdatedAt ?? a.updatedAt)
    )
    .slice(0, OVERALL_FEEDBACK_ITEMS)
  const overallFeedbackText = takeRecentWithBudget(
    recentOverallFeedback.slice().reverse(),
    OVERALL_FEEDBACK_ITEMS,
    OVERALL_FEEDBACK_TOKENS,
    (session) => session.overallFeedback ?? ''
  )
    .map((session) => `- ${session.overallFeedback?.trim()}`)
    .join('\n')

  if (overallFeedbackText) {
    system += languageMeta.isChinese
      ? `\n\n用户对整轮练习对话的总体反馈（优先级高于单条回答反馈；后续回答必须持续改进，越新的反馈优先；不要在答案中提到反馈本身）:\n${overallFeedbackText}`
      : `\n\nOverall session feedback (higher priority than per-answer feedback; keep improving future answers; newer feedback wins; never mention the feedback itself):\n${overallFeedbackText}`
  }

  const messages: ChatMessage[] = [{ role: 'system', content: system }]
  const itemLimit = extendedContext ? EXTENDED_CONTEXT_ITEMS : NORMAL_DIALOG_TURNS
  // 最后一条就是本次问题的原始转写，下面会以提炼后的 question 单独加入，避免重复输入。
  const eligibleDialog = history.slice(0, -1)
    .filter((turn) => !contextCompressedAt || turn.timestamp > contextCompressedAt)
  const recentDialog = takeRecentWithBudget(
    eligibleDialog,
    itemLimit,
    extendedContext ? EXTENDED_DIALOG_TOKENS : NORMAL_DIALOG_TOKENS,
    (turn) => turn.text
  )
  const qaLimit = extendedContext ? EXTENDED_CONTEXT_ITEMS : NORMAL_QA_PAIRS
  const eligibleQA = qaHistory
    .filter((qa) => !contextCompressedAt || qa.timestamp > contextCompressedAt)
    .slice()
    .reverse()
  const recentQA = takeRecentWithBudget(
    eligibleQA,
    qaLimit,
    extendedContext ? EXTENDED_QA_TOKENS : NORMAL_QA_TOKENS,
    (qa) => `${qa.question}\n${qa.answer}`
  )

  // 把模型之前的真实回答也放回消息序列，才能保持前后口径一致。
  for (const qa of recentQA) {
    // 已被用户纠正的答案不是对话事实。反馈会通过高优先级指令单独进入，
    // 这里不再把旧答案作为 assistant 示例喂回模型，避免只做表面改写。
    if (hasCorrectiveQAFeedback(qa)) continue
    messages.push({ role: 'user', content: qa.question })
    messages.push({ role: 'assistant', content: qa.answer })
  }

  if (recentDialog.length > 0) {
    const historyText = recentDialog
      .map((t) => {
        const roleLabel =
          languageMeta.isChinese
            ? t.role === 'interviewer'
              ? '提问者'
              : t.role === 'self'
                ? '我'
                : '回答者'
            : t.role === 'interviewer'
              ? 'Questioner'
              : t.role === 'self'
                ? 'Me'
                : 'Respondent'
        return `${roleLabel}: ${t.text}`
      })
      .join('\n')
    messages.push({
      role: 'user',
      content:
        languageMeta.isChinese
          ? `最近的现场对话转写:\n${historyText}\n\n提问者最新问题:${question}\n\n自然回答这个问题，并保持与上文约束一致。`
          : `Recent live transcript:\n${historyText}\n\nLatest question: ${question}\n\nAnswer naturally while staying consistent with the established context.`
    })
  } else {
    messages.push({
      role: 'user',
      content:
        languageMeta.isChinese
          ? `提问者问题:${question}\n\n请给出自然、口语化且不重复的回答。`
          : `Question: ${question}\n\nGive a natural spoken answer without repetition.`
    })
  }

  return messages
}

/** 把较长会话压缩成后续可继续使用的事实与约束摘要。 */
export function buildContextCompressionMessages(
  dialogHistory: DialogTurn[],
  qaHistory: QARecord[],
  previousSummary?: string,
  overallFeedback?: string
): ChatMessage[] {
  const dialogForCompression = takeRecentWithBudget(
    dialogHistory,
    EXTENDED_CONTEXT_ITEMS,
    30_000,
    (turn) => turn.text
  )
  const qaForCompression = takeRecentWithBudget(
    qaHistory.slice().reverse(),
    EXTENDED_CONTEXT_ITEMS,
    100_000,
    (item) => `${item.question}\n${item.answer}\n${item.feedback ?? ''}`
  )
  const transcript = dialogForCompression
    .map((turn) => `[${turn.role}] ${turn.text}`)
    .join('\n')
  const qa = qaForCompression
    .map((item) => `Q: ${item.question}\nA: ${item.answer}${item.feedback ? `\n用户反馈: ${item.feedback}` : ''}`)
    .join('\n\n')

  return [
    {
      role: 'system',
      content: `你负责压缩对话上下文，供后续回答继续使用。只保留会影响后续回答的内容：
1. 提问者已经确定的业务背景、需求、限制和技术选择。
2. 回答者已经明确表达过的经历、立场、做法和边界，避免后续自相矛盾。
3. 尚未解决或可能继续追问的话题。
4. 用户对回答的反馈，以及后续回答需要持续遵守的表达偏好。
5. 不保留客套话、重复解释、具体措辞和无关细节。

用简洁中文分成”背景约束 / 已有口径 / 待跟进”三段。不要评价回答质量，不要创造新事实。`
    },
    {
      role: 'user',
      content: `${previousSummary ? `已有摘要:\n${previousSummary.slice(0, 100_000)}\n\n` : ''}${overallFeedback ? `整轮对话反馈:\n${overallFeedback.slice(0, 6000)}\n\n` : ''}现场转写:\n${transcript || '无'}\n\n历史问答与反馈:\n${qa || '无'}`
    }
  ]
}

/** 为混合模式下的非中文问题生成独立中文翻译请求。 */
export function buildQuestionTranslationMessages(
  question: string,
  sourceLanguage: DetectedLanguage
): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `你是专业翻译。请把下面的 ${sourceLanguage.name} 问题准确翻译成简体中文。

要求:
1. 忠实保留问题原意、技术术语、专有名词、代码、API 名称和标识符。
2. 不要回答、解释、总结、点评或补充问题。
3. 只输出中文译文,不要重复原文,不要添加“翻译如下”等引导语。`
    },
    {
      role: 'user',
      content: `待翻译的原语言问题:\n<source_question>\n${question}\n</source_question>`
    }
  ]
}

/** 为混合模式下的非中文答案生成独立中文翻译请求。 */
export function buildTranslationMessages(
  answer: string,
  sourceLanguage: DetectedLanguage
): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `你是专业翻译。请把下面的 ${sourceLanguage.name} 回答完整翻译成简体中文。

要求:
1. 忠实保留原意、结构、Markdown、代码块、API 名称和标识符。
2. 不要缩写、总结、点评或补充内容。
3. 只输出中文译文,不要重复原文,不要添加“翻译如下”等引导语。`
    },
    {
      role: 'user',
      content: `待翻译的原语言回答:\n<source_answer>\n${answer}\n</source_answer>`
    }
  ]
}
