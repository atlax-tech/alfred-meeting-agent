/**
 * LLM 客户端 —— OpenAI 兼容接口
 *
 * 支持流式输出(SSE),可接入:
 *  - DeepSeek v4-flash / v4-pro(支持思考模式 thinking + reasoning_effort)
 *  - OpenAI 官方 API
 *  - 国内大模型(智谱 GLM、通义千问等,均提供 OpenAI 兼容接口)
 *  - 本地 Ollama / vLLM / LM Studio 等
 *
 * DeepSeek v4 思考模式关键点:
 *  - 流式响应中,delta.reasoning_content 是思维链,delta.content 是最终答案
 *  - 思考模式下 temperature/top_p 等不生效(填了不报错)
 *  - 思维链先输出,最终答案后输出
 */

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

/**
 * 构造请求 body
 */
function buildBody(
  config: LLMConfig,
  messages: ChatMessage[],
  options?: ChatOptions
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: applyResponseLanguageGuard(messages, options?.responseLanguage),
    stream: true,
    max_tokens: Math.min(config.maxTokens, options?.maxTokensOverride ?? config.maxTokens)
  }

  // 思考模式(thinking 字段是 DeepSeek 扩展,其他厂商会忽略)
  const thinking = options?.thinkingOverride ?? config.thinking
  body.thinking = { type: thinking }

  // 思考强度(仅 thinking=enabled 时有意义)
  if (thinking === 'enabled') {
    body.reasoning_effort = config.reasoningEffort
  }

  // temperature:思考模式下不生效,但非思考模式下传给模型
  // (思考模式填了不报错,所以无脑传也可以,这里为了清晰仅在非思考时传)
  if (thinking === 'disabled') {
    body.temperature = config.temperature
  }

  // JSON Output
  if (options?.jsonOutput) {
    body.response_format = { type: 'json_object' }
  }

  return body
}

/**
 * 调用 OpenAI 兼容的 /chat/completions 接口(流式)
 */
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
  let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } = {}
  let metricsSent = false
  const emitMetrics = (): void => {
    if (metricsSent) return
    metricsSent = true
    options?.metricsCallback?.({
      task,
      model: requestConfig.model,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      timeToFirstTokenMs:
        firstTokenAt === undefined
          ? undefined
          : Math.max(0, Math.round(firstTokenAt - startedAt)),
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens
    })
  }
  if (!requestConfig.apiKey) {
    cb.onError?.(new Error('未配置 LLM API Key,请到设置面板填写'))
    emitMetrics()
    return
  }
  if (!requestConfig.baseURL) {
    cb.onError?.(new Error('未配置 LLM baseURL'))
    emitMetrics()
    return
  }

  // DeepSeek 同时支持 https://api.deepseek.com 和 https://api.deepseek.com/v1
  // 统一拼接 /chat/completions
  const url = `${requestConfig.baseURL.replace(/\/$/, '')}/chat/completions`
  const body = buildBody(requestConfig, messages, options)

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${requestConfig.apiKey}`
      },
      body: JSON.stringify(body),
      signal
    })
  } catch (err) {
    cb.onError?.(new Error(`LLM 请求失败: ${(err as Error).message}`))
    emitMetrics()
    return
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    cb.onError?.(new Error(`LLM HTTP ${response.status}: ${text.slice(0, 300)}`))
    emitMetrics()
    return
  }

  if (!response.body) {
    cb.onError?.(new Error('LLM 响应无 body'))
    emitMetrics()
    return
  }

  // 解析 SSE 流 —— 同时处理 reasoning_content 和 content
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let fullText = ''
  let fullReasoning = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE 以 \n\n 分隔事件
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') {
          cb.onDone?.(fullText, fullReasoning)
          emitMetrics()
          return
        }
        try {
          const json = JSON.parse(data)
          if (json.usage && typeof json.usage === 'object') {
            usage = { ...usage, ...json.usage }
          }
          const delta = json.choices?.[0]?.delta
          if (!delta) continue

          // 思维链(思考模式)
          if (delta.reasoning_content) {
            fullReasoning += delta.reasoning_content
            cb.onReasoning?.(delta.reasoning_content)
          }
          // 最终答案
          if (delta.content) {
            if (firstTokenAt === undefined) firstTokenAt = performance.now()
            fullText += delta.content
            cb.onChunk?.(delta.content)
          }
        } catch {
          // 忽略解析失败的 chunk
        }
      }
    }
    cb.onDone?.(fullText, fullReasoning)
    emitMetrics()
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      cb.onDone?.(fullText, fullReasoning)
    } else {
      cb.onError?.(err as Error)
    }
    emitMetrics()
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
