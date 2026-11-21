import type { LLMConfig } from './types'

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Accept a host, API prefix, or full endpoint; preserve custom versioned paths. */
export function apiEndpoint(baseURL: string, resource: string): string {
  const url = new URL(baseURL.trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Base URL 只支持不含账号、密码、查询参数的 HTTP(S) 接口地址')
  }
  let path = url.pathname.replace(/\/+$/, '').replace(/\/(chat\/completions|responses|audio\/transcriptions)$/, '')
  if (!path) path = '/v1'
  url.pathname = `${path}/${resource}`
  return url.toString()
}

export function buildOpenAIRequest(
  config: LLMConfig,
  messages: OpenAIMessage[],
  options: { stream?: boolean; jsonOutput?: boolean; maxTokens?: number; thinkingOverride?: 'enabled' | 'disabled' } = {}
): { url: string; body: Record<string, unknown> } {
  const responses = config.apiFormat === 'responses'
  const body: Record<string, unknown> = { model: config.model.trim(), stream: options.stream ?? true }
  const limit = Math.min(config.maxTokens, options.maxTokens ?? config.maxTokens)
  if (!body.model) throw new Error('请填写模型名')
  if (!Number.isFinite(limit) || limit < 1) throw new Error('输出 Token 上限必须为正数')
  if (responses) {
    body.input = messages
    body.max_output_tokens = limit
    body.store = false
    if (options.jsonOutput) body.text = { format: { type: 'json_object' } }
  } else {
    body.messages = messages
    body[config.tokenLimitField ?? 'max_tokens'] = limit
    if (options.jsonOutput) body.response_format = { type: 'json_object' }
  }
  // Parameters are opt-in: OpenAI-compatible services do not share every model capability.
  if (config.thinking === 'enabled' || options.thinkingOverride === 'enabled') {
    const effort = options.thinkingOverride === 'disabled' ? 'none' : config.reasoningEffort
    if (responses) body.reasoning = { effort }
    else body.reasoning_effort = effort
  }
  if (config.sendTemperature) body.temperature = config.temperature
  return { url: apiEndpoint(config.baseURL, responses ? 'responses' : 'chat/completions'), body }
}

export function redactAPIError(message: string, apiKey = ''): string {
  return (apiKey ? message.split(apiKey).join('[已隐藏密钥]') : message)
    .replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [已隐藏密钥]')
    .replace(/sk-[\w-]+/g, '[已隐藏密钥]')
    .slice(0, 500)
}

export function httpAPIError(status: number, detail: string, apiKey = ''): Error {
  const hint = status === 401 ? '请在设置中核对 Key（无需提供给他人）'
    : status === 403 ? '请检查服务端分组权限、地区或网关限制'
      : status === 404 ? '请检查 Base URL、/v1 前缀与 API 格式'
        : status === 429 ? '请求限流或额度不足，请检查服务端说明'
          : status === 400 ? '请检查模型名及思考、温度、Token 等参数是否受支持'
            : status >= 500 ? '服务端或上游暂时异常'
              : '请求未成功'
  return new Error(redactAPIError(`HTTP ${status}：${hint}。${detail}`, apiKey))
}

export function responseText(payload: any): string {
  const chat = payload?.choices?.[0]?.message?.content
  if (typeof chat === 'string') return chat
  const output = payload?.output
  if (!Array.isArray(output)) return ''
  return output.filter((item: any) => item.type === 'message')
    .flatMap((item: any) => item.content ?? [])
    .filter((item: any) => item.type === 'output_text')
    .map((item: any) => item.text ?? '').join('')
}

export interface OpenAIResult {
  text: string
  reasoning: string
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

/** Parse both standard SSE protocols, including split UTF-8 and a final frame without newline. */
export async function readOpenAIResponse(
  response: Response,
  callbacks: { onText?: (text: string) => void; onReasoning?: (text: string) => void } = {},
  apiKey = ''
): Promise<OpenAIResult> {
  const result: OpenAIResult = { text: '', reasoning: '', usage: {} }
  const append = (value: unknown, reasoning = false): void => {
    if (typeof value !== 'string' || !value) return
    if (reasoning) { result.reasoning += value; callbacks.onReasoning?.(value) }
    else { result.text += value; callbacks.onText?.(value) }
  }
  const updateUsage = (value: any): void => {
    if (!value) return
    result.usage = {
      prompt_tokens: value.prompt_tokens ?? value.input_tokens,
      completion_tokens: value.completion_tokens ?? value.output_tokens,
      total_tokens: value.total_tokens
    }
  }
  const checkPayload = (payload: any): void => {
    if (payload.error || payload.status === 'failed') {
      throw new Error(redactAPIError(payload.error?.message || '模型返回失败状态', apiKey))
    }
    if (payload.status === 'incomplete' || payload.choices?.[0]?.finish_reason === 'length') {
      throw new Error('模型输出未完成，请检查输出 Token 上限与思考程度')
    }
    if (payload.choices?.[0]?.finish_reason === 'content_filter') throw new Error('输出被服务端内容过滤')
  }
  if ((response.headers.get('content-type') ?? '').includes('application/json')) {
    const payload: any = await response.json()
    checkPayload(payload)
    append(responseText(payload))
    append(payload.choices?.[0]?.message?.reasoning_content, true)
    updateUsage(payload.usage)
  } else {
    if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      throw new Error('接口未返回 OpenAI JSON/SSE，可能填入了网页地址或协议不匹配')
    }
    if (!response.body) throw new Error('模型响应没有可读取的内容')
    let complete = false
    let endEvent = false
    let buffer = ''
    let dataLines: string[] = []
    const processEvent = (): void => {
      const data = dataLines.join('\n').trim()
      dataLines = []
      if (!data) return
      if (data === '[DONE]') { complete = true; endEvent = true; return }
      let payload: any
      try { payload = JSON.parse(data) } catch { throw new Error('模型返回了无效的 SSE JSON 数据') }
      checkPayload(payload)
      if (payload.type === 'error') throw new Error(redactAPIError(payload.message || '模型流错误', apiKey))
      if (payload.type === 'response.failed' || payload.type === 'response.incomplete') {
        throw new Error(redactAPIError(payload.response?.error?.message || '模型输出未完成或执行失败', apiKey))
      }
      if (payload.type === 'response.output_text.delta') append(payload.delta)
      if (payload.type === 'response.reasoning_summary_text.delta') append(payload.delta, true)
      if (payload.type === 'response.completed') {
        checkPayload(payload.response ?? {})
        if (!result.text) append(responseText(payload.response))
        updateUsage(payload.response?.usage)
        complete = true
        endEvent = true
      }
      const choice = payload.choices?.[0]
      append(choice?.delta?.content)
      append(choice?.delta?.reasoning_content, true)
      if (choice?.finish_reason) complete = true
      if (payload.usage) updateUsage(payload.usage)
    }
    const line = (value: string): void => {
      const text = value.replace(/\r$/, '')
      if (text === '') processEvent()
      else if (text.startsWith('data:')) dataLines.push(text.slice(5).replace(/^ /, ''))
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    try {
      while (!endEvent) {
        const chunk = await reader.read()
        buffer += decoder.decode(chunk.value, { stream: !chunk.done })
        let index: number
        while ((index = buffer.indexOf('\n')) !== -1) {
          line(buffer.slice(0, index)); buffer = buffer.slice(index + 1)
        }
        if (chunk.done) break
      }
      if (buffer) line(buffer)
      processEvent()
      if (!complete) throw new Error('模型流提前中断，未收到完成标记；不能视为成功')
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  if (!result.text.trim()) throw new Error('接口已响应，但没有返回有效的答案文本')
  return result
}
