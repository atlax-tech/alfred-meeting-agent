/** OpenAI-compatible Chat Completions / Responses client. */
import { buildOpenAIRequest, httpAPIError, readOpenAIResponse, redactAPIError } from '@shared/openai'
import type {
  DetectedLanguage,
  LLMCallPerformance,
  LLMConfig,
  Region
} from '@shared/types'

export type ResponseLanguage = Exclude<Region, 'mixed'> | DetectedLanguage

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface StreamCallbacks {
  /** 最终答案 chunk */
  onChunk?: (delta: string) => void
  /** 思维链 chunk(思考模式开启时) */
  onReasoning?: (delta: string) => void
  onDone?: (fullText: string, fullReasoning?: string) => void
  onError?: (err: Error) => void
}

export interface ChatOptions {
  /** 强制覆盖思考模式(用于问题提取场景要关闭思考) */
  thinkingOverride?: 'enabled' | 'disabled'
  /** 是否启用 JSON Output(response_format) */
  jsonOutput?: boolean
  /** 最终输出语言锁;仅答案生成场景使用 */
  responseLanguage?: ResponseLanguage
  /** 为特定短任务收紧输出长度，不影响设置中的全局上限 */
  maxTokensOverride?: number
  /** 用于模型路由和本地性能记录。 */
  task?: LLMCallPerformance['task']
  metricsCallback?: (metrics: LLMCallPerformance) => void
}

export function configForTask(
  config: LLMConfig,
  task: LLMCallPerformance['task'] = 'answer'
): LLMConfig {
  const routedModel =
    task === 'extract' || task === 'compression' || task === 'translation'
      ? config.fastModel?.trim()
      : task === 'review'
        ? config.reviewModel?.trim()
        : task === 'offline'
          ? config.offlineModel?.trim()
          : ''
  return routedModel ? { ...config, model: routedModel } : config
}

export function getResponseLanguageMeta(language: ResponseLanguage): DetectedLanguage {
  if (language === 'zh') return { code: 'zh', name: 'Simplified Chinese', isChinese: true }
  if (language === 'en') return { code: 'en', name: 'English', isChinese: false }

  const safeCode = /^[a-z]{2,3}(?:-[a-z]{2,4})?$/i.test(language.code)
    ? language.code.toLowerCase()
    : 'und'
  const safeName = language.name
    .replace(/[^\p{L}\p{M}\s()_-]/gu, '')
    .trim()
    .slice(0, 40) || 'the detected language'

  return {
    code: safeCode,
    name: safeName,
    isChinese: language.isChinese || safeCode === 'zh' || safeCode.startsWith('zh-')
  }
}

/**
 * 在请求发送层再次锁定输出语言,避免问题文本、历史或参考资料要求模型切换语言。
 * 这是一道独立于业务 prompt 的防线,后续调整回答模板时也不会意外丢失语言约束。
 */
export function applyResponseLanguageGuard(
  messages: ChatMessage[],
  language?: ResponseLanguage
): ChatMessage[] {
  if (!language) return messages

  const meta = getResponseLanguageMeta(language)
  const guard = meta.isChinese
      ? '【最高优先级输出语言锁】最终答案以及任何会展示给用户的推理内容必须只使用简体中文。无论输入问题、对话历史或资料使用何种语言,都不得改用其他语言或提供双语对照。技术专有名词、代码、API 名称和标识符可保留原文。'
      : meta.code === 'en'
        ? '[HIGHEST-PRIORITY OUTPUT LANGUAGE LOCK] The final answer and any reasoning shown to the user must be in English only. Regardless of the language used by the question, conversation history, or reference material, do not switch to another language and do not provide a bilingual translation. Proper nouns, code, API names, and identifiers may remain in their original form.'
        : `[HIGHEST-PRIORITY OUTPUT LANGUAGE LOCK] The final answer and any reasoning shown to the user must be in ${meta.name} (${meta.code}) only. Regardless of the language used by the conversation history or reference material, do not switch languages and do not provide a bilingual translation. Proper nouns, code, API names, and identifiers may remain in their original form.`

  const systemIndex = messages.findIndex((message) => message.role === 'system')
  if (systemIndex === -1) {
    return [{ role: 'system', content: guard }, ...messages]
  }

  return messages.map((message, index) =>
    index === systemIndex
      ? { ...message, content: `${guard}\n\n${message.content}` }
      : message
  )
}

export async function chatStream(
  config: LLMConfig,
  messages: ChatMessage[],
  cb: StreamCallbacks,
  signal?: AbortSignal,
  options?: ChatOptions
): Promise<void> {
  const task = options?.task ?? 'answer'
  const requestConfig = configForTask(config, task)
  const startedAt = performance.now()
  let firstTokenAt: number | undefined
  let text = ''
  let reasoning = ''
  let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } = {}
  try {
    if (!requestConfig.apiKey.trim()) throw new Error('请在设置中填写 LLM API Key')
    const request = buildOpenAIRequest(
      requestConfig,
      applyResponseLanguageGuard(messages, options?.responseLanguage),
      { ...options, maxTokens: options?.maxTokensOverride }
    )
    const response = await fetch(request.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${requestConfig.apiKey}` },
      body: JSON.stringify(request.body),
      signal
    })
    if (!response.ok) throw httpAPIError(response.status, (await response.text()).slice(0, 1000), requestConfig.apiKey)
    const result = await readOpenAIResponse(response, {
      onText: (delta) => {
        if (firstTokenAt === undefined) firstTokenAt = performance.now()
        text += delta
        cb.onChunk?.(delta)
      },
      onReasoning: (delta) => { reasoning += delta; cb.onReasoning?.(delta) }
    }, requestConfig.apiKey)
    usage = result.usage
    cb.onDone?.(result.text, result.reasoning)
  } catch (error) {
    if ((error as Error).name === 'AbortError') cb.onDone?.(text, reasoning)
    else cb.onError?.(new Error(redactAPIError((error as Error).message, requestConfig.apiKey)))
  } finally {
    options?.metricsCallback?.({
      task,
      model: requestConfig.model,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      timeToFirstTokenMs: firstTokenAt === undefined ? undefined : Math.max(0, Math.round(firstTokenAt - startedAt)),
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens
    })
  }
}

/** Uses the same streaming request and parser as real answers; contains no personal context. */
export async function testLLMConnection(config: LLMConfig, signal?: AbortSignal): Promise<string> {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  const timeout = setTimeout(abort, 30_000)
  const start = performance.now()
  try {
    const text = await chatOnce(config, [{ role: 'user', content: 'Reply exactly OK.' }], controller.signal, { maxTokensOverride: 128 })
    if (controller.signal.aborted) throw new Error('测试已取消或超过30秒；请检查网络、输出上限与思考配置')
    if (!text.trim()) throw new Error('模型未返回有效文本')
    return `连接成功：${config.model} · ${config.apiFormat === 'responses' ? 'Responses' : 'Chat Completions'} · ${(performance.now() - start).toFixed(0)} ms`
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

/**
 * 非流式调用(用于问题提取等短任务)
 */
export async function chatOnce(
  config: LLMConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
  options?: ChatOptions
): Promise<string> {
  return new Promise((resolve, reject) => {
    chatStream(
      config,
      messages,
      {
        onChunk: (delta) => {
          // 累积最终答案,忽略思维链
        },
        onDone: (full) => resolve(full),
        onError: (err) => reject(err)
      },
      signal,
      options
    )
  })
}
