import test from 'node:test'
import assert from 'node:assert/strict'
import { apiEndpoint, buildOpenAIRequest, httpAPIError, readOpenAIResponse } from '@shared/openai'
import { DEFAULT_CONFIG } from '@shared/types'
import { chatOnce, testLLMConnection } from '../src/renderer/src/services/llm'

const config = { ...DEFAULT_CONFIG.llm, baseURL: 'https://example.test', apiKey: 'test-secret', model: 'test-model' }
const messages = [{ role: 'user' as const, content: 'Reply OK.' }]
const sse = (value: string): Response => new Response(value, { headers: { 'content-type': 'text/event-stream' } })

test('API host, prefix, full endpoint and custom paths normalize without vendor branching', () => {
  assert.equal(apiEndpoint(' https://example.test/ ', 'responses'), 'https://example.test/v1/responses')
  assert.equal(apiEndpoint('https://example.test/v1///', 'chat/completions'), 'https://example.test/v1/chat/completions')
  assert.equal(apiEndpoint('https://example.test/api/v2', 'responses'), 'https://example.test/api/v2/responses')
  assert.equal(apiEndpoint('https://example.test/v1/chat/completions', 'responses'), 'https://example.test/v1/responses')
  assert.equal(apiEndpoint('http://localhost:8080/v1', 'audio/transcriptions'), 'http://localhost:8080/v1/audio/transcriptions')
  for (const url of ['file:///tmp/a', 'https://user:pass@example.test', 'https://example.test?key=x']) {
    assert.throws(() => apiEndpoint(url, 'responses'))
  }
})

test('optional parameters are opt-in; reasoning and token limits map to the selected protocol', () => {
  const chat = buildOpenAIRequest(config, messages).body
  assert.equal(chat.model, 'test-model')
  assert.equal(chat.max_tokens, 4096)
  for (const key of ['thinking', 'reasoning_effort', 'temperature', 'reasoning']) assert.equal(key in chat, false)
  const responses = buildOpenAIRequest({ ...config, apiFormat: 'responses', thinking: 'enabled', reasoningEffort: 'none' }, messages, { jsonOutput: true, maxTokens: 128 }).body
  assert.deepEqual(responses.input, messages)
  assert.equal(responses.max_output_tokens, 128)
  assert.deepEqual(responses.reasoning, { effort: 'none' })
  assert.deepEqual(responses.text, { format: { type: 'json_object' } })
  assert.equal('max_tokens' in responses, false)
  const reasoning = buildOpenAIRequest({ ...config, thinking: 'enabled', reasoningEffort: 'high', tokenLimitField: 'max_completion_tokens', sendTemperature: true }, messages, { thinkingOverride: 'disabled' }).body
  assert.equal(reasoning.reasoning_effort, 'none')
  assert.equal(reasoning.max_completion_tokens, 4096)
  assert.equal(reasoning.temperature, 0.3)
})

test('Chat SSE handles UTF-8 split at every byte, CRLF, usage and final event without newline', async () => {
  const text = 'data: '+JSON.stringify({ choices: [{ delta: { content: '你好' } }] })+'\r\n\r\n' +
    'data: '+JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 7 } })+'\r\n\r\n' + 'data: [DONE]'
  const bytes = new TextEncoder().encode(text)
  const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close() } })
  const result = await readOpenAIResponse(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
  assert.equal(result.text, '你好')
  assert.equal(result.usage.total_tokens, 7)
})

test('Responses SSE parses text and normalized usage with completion evidence', async () => {
  const events = [
    { type: 'response.created', response: { status: 'in_progress' } },
    { type: 'response.output_text.delta', delta: 'OK' },
    { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } }
  ]
  const result = await readOpenAIResponse(sse(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')))
  assert.equal(result.text, 'OK')
  assert.deepEqual(result.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 })
})

test('non-stream JSON is accepted for both standard response shapes', async () => {
  for (const payload of [
    { choices: [{ message: { content: 'OK' } }] },
    { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] }
  ]) assert.equal((await readOpenAIResponse(Response.json(payload))).text, 'OK')
})

test('HTML, empty output, stream errors, truncation and incomplete replies never pass as success', async () => {
  await assert.rejects(readOpenAIResponse(new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } })))
  await assert.rejects(readOpenAIResponse(Response.json({ choices: [] })))
  await assert.rejects(readOpenAIResponse(sse('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')))
  await assert.rejects(readOpenAIResponse(sse('data: {invalid}\n\n')))
  await assert.rejects(readOpenAIResponse(sse('data: {"error":{"message":"bad model"}}\n\n')), /bad model/)
  await assert.rejects(readOpenAIResponse(sse('data: {"choices":[{"delta":{"content":"part"},"finish_reason":"length"}]}\n\n')), /未完成/)
  await assert.rejects(readOpenAIResponse(sse('data: {"type":"response.incomplete","response":{}}\n\n')), /未完成/)
})

test('HTTP errors redact secrets, including servers that echo Authorization', () => {
  const error = httpAPIError(401, 'Bearer test-secret and test-secret sk-abc123', config.apiKey)
  assert.equal(error.message.includes('test-secret'), false)
  assert.equal(error.message.includes('sk-abc123'), false)
})

test('connection test uses the production stream path and sends no personal context', async () => {
  const original = globalThis.fetch
  let seenBody: any
  let seenURL = ''
  globalThis.fetch = (async (url, init) => {
    seenURL = String(url); seenBody = JSON.parse(String(init?.body))
    return sse('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]')
  }) as typeof fetch
  try {
    const result = await testLLMConnection(config)
    assert.match(result, /连接成功/)
    assert.equal(seenURL, 'https://example.test/v1/chat/completions')
    assert.deepEqual(seenBody.messages, [{ role: 'user', content: 'Reply exactly OK.' }])
    assert.equal(seenBody.stream, true)
    assert.equal(seenBody.max_tokens, 128)
    assert.equal(await chatOnce(config, messages), 'OK')
  } finally { globalThis.fetch = original }
})

test('cancellation cannot be reported as a successful connection', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async (_url, init) => {
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    throw new Error('unexpected call')
  }) as typeof fetch
  try {
    const controller = new AbortController(); controller.abort()
    await assert.rejects(testLLMConnection(config, controller.signal), /取消/)
  } finally { globalThis.fetch = original }
})
