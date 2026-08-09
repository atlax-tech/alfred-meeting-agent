import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { LLMConfig } from '@shared/types'
import type { AnswerStrategyKind } from '@shared/types'
import { resolveAnswerStrategy } from '@shared/answer-strategy'
import {
  checkRepositorySnapshotFreshness,
  indexRepository
} from './indexer'
import {
  getRepositoryEvidence,
  prewarmRepositorySnapshot,
  retrieveRepositoryContext
} from './retriever'
import { loadStoredSnapshot } from './store'
import {
  buildDeterministicKnowledgePack,
  distillRepositoryKnowledgePack
} from './knowledge-pack'

interface RetrievalFixture {
  question: string
  expectedPath: string
}

const RETRIEVAL_FIXTURES: RetrievalFixture[] = [
  { question: 'What problem does this payment project solve?', expectedPath: 'README.md' },
  { question: '请介绍这个支付项目解决的问题', expectedPath: 'README.md' },
  { question: 'How are payment requests retried?', expectedPath: 'src/payment.ts' },
  { question: '支付请求失败后怎么重试', expectedPath: 'src/payment.ts' },
  { question: 'What is the retry boundary?', expectedPath: 'src/payment.ts' },
  { question: '重试次数的边界在哪里', expectedPath: 'src/payment.ts' },
  { question: 'How does exponential backoff work here?', expectedPath: 'src/payment.ts' },
  { question: '这里的退避等待怎么实现', expectedPath: 'src/payment.ts' },
  { question: 'How are duplicate payment calls prevented?', expectedPath: 'src/payment.ts' },
  { question: '如何避免重复支付请求', expectedPath: 'src/payment.ts' },
  { question: 'Where is idempotency handled?', expectedPath: 'src/payment.ts' },
  { question: '幂等键在哪里处理', expectedPath: 'src/payment.ts' },
  { question: 'What happens after the final retry?', expectedPath: 'src/payment.ts' },
  { question: '最后一次重试失败后怎么处理', expectedPath: 'src/payment.ts' },
  { question: 'How is authentication checked?', expectedPath: 'src/auth.ts' },
  { question: '身份认证是怎么检查的', expectedPath: 'src/auth.ts' },
  { question: 'What does validateToken do?', expectedPath: 'src/auth.ts' },
  { question: 'validateToken 的作用是什么', expectedPath: 'src/auth.ts' },
  { question: 'How are expired tokens rejected?', expectedPath: 'src/auth.ts' },
  { question: '过期 token 如何拒绝', expectedPath: 'src/auth.ts' },
  { question: 'Where is the authorization boundary?', expectedPath: 'src/auth.ts' },
  { question: '授权边界写在哪里', expectedPath: 'src/auth.ts' },
  { question: 'How is payment retry tested?', expectedPath: 'tests/payment.test.ts' },
  { question: '支付重试如何测试', expectedPath: 'tests/payment.test.ts' },
  { question: 'Which test covers duplicate requests?', expectedPath: 'tests/payment.test.ts' },
  { question: '哪个测试覆盖重复请求', expectedPath: 'tests/payment.test.ts' },
  { question: 'What is the expected retry count in tests?', expectedPath: 'tests/payment.test.ts' },
  { question: '测试里的重试次数是多少', expectedPath: 'tests/payment.test.ts' },
  { question: 'How is failure handling verified?', expectedPath: 'tests/payment.test.ts' },
  { question: '失败处理如何验证', expectedPath: 'tests/payment.test.ts' },
  { question: 'What command runs the tests?', expectedPath: 'package.json' },
  { question: '运行测试使用什么命令', expectedPath: 'package.json' },
  { question: 'What is the package description?', expectedPath: 'package.json' },
  { question: 'package description 写了什么', expectedPath: 'package.json' },
  { question: 'Which runtime does the project use?', expectedPath: 'package.json' },
  { question: '项目使用什么 runtime', expectedPath: 'package.json' },
  { question: 'What is the payment service goal?', expectedPath: 'README.md' },
  { question: '支付服务的目标是什么', expectedPath: 'README.md' },
  { question: 'What constraint keeps retries safe?', expectedPath: 'README.md' },
  { question: '重试安全的约束是什么', expectedPath: 'README.md' },
  { question: 'How does the request flow through the service?', expectedPath: 'README.md' },
  { question: '请求在服务里怎么流转', expectedPath: 'README.md' },
  { question: 'What is measured after a retry?', expectedPath: 'README.md' },
  { question: '重试后测量什么指标', expectedPath: 'README.md' },
  { question: 'Where is the API timeout configured?', expectedPath: 'config/service.yaml' },
  { question: 'API 超时在哪里配置', expectedPath: 'config/service.yaml' },
  { question: 'What is the retry delay configuration?', expectedPath: 'config/service.yaml' },
  { question: '重试等待配置是多少', expectedPath: 'config/service.yaml' },
  { question: 'Which endpoint handles payments?', expectedPath: 'config/service.yaml' },
  { question: '支付 endpoint 配在哪里', expectedPath: 'config/service.yaml' }
]

const STRATEGY_FIXTURES: Array<[string, AnswerStrategyKind]> = [
  ['讲讲一次你信息有限但必须推进项目的经历', 'project-scenario'],
  ['Tell me about a time you had limited data but still had to move forward.', 'project-scenario'],
  ['What did you do and why?', 'project-scenario'],
  ['请介绍一下这个项目', 'project-overview'],
  ['Tell me about this project', 'project-overview'],
  ['这个系统主要做什么', 'project-overview'],
  ['Give me a repository overview', 'project-overview'],
  ['这个项目最难的部分是什么', 'project-deep-dive'],
  ['What was the hardest challenge?', 'project-deep-dive'],
  ['你在项目里具体做了什么', 'project-deep-dive'],
  ['What was your main idea?', 'project-deep-dive'],
  ['这个请求链路是怎么设计的', 'technical-design'],
  ['How did you implement the retry flow?', 'technical-design'],
  ['系统边界怎么处理', 'technical-design'],
  ['Explain the data flow and fallback', 'technical-design'],
  ['这两个方案有什么区别', 'comparison'],
  ['Why did you choose A over B?', 'comparison'],
  ['Redis 和本地缓存怎么取舍', 'comparison'],
  ['Compare these two designs', 'comparison'],
  ['线上故障的根因是什么', 'incident-or-failure'],
  ['How did you recover from the outage?', 'incident-or-failure'],
  ['失败以后怎么排查', 'incident-or-failure'],
  ['What caused this incident?', 'incident-or-failure'],
  ['项目现在进度怎么样', 'progress-and-result'],
  ['What was the main result?', 'progress-and-result'],
  ['上线后看哪些指标', 'progress-and-result'],
  ['What impact did it have?', 'progress-and-result'],
  ['幂等是什么意思', 'definition'],
  ['What is idempotency?', 'definition'],
  ['这个原理是什么', 'definition'],
  ['Define exponential backoff', 'definition'],
  ['How do you prioritize ordinary work?', 'general'],
  ['为什么', 'clarification'],
  ['Which one?', 'clarification']
]

function writeFixture(root: string, relativePath: string, content: string): void {
  const path = join(root, relativePath)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf-8')
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function testConfig(): LLMConfig {
  return {
    baseURL: '',
    apiKey: '',
    model: 'self-test',
    temperature: 0,
    maxTokens: 1024,
    thinking: 'disabled',
    reasoningEffort: 'high',
    millionContextEnabled: false,
    adaptiveReviewEnabled: false
  }
}

export interface RepositoryKnowledgeSelfTestResult {
  passed: boolean
  assertions: number
  retrievalFixtures: number
  maxRetrievalMs: number
  firstSnapshotId: string
  secondSnapshotId: string
}

export async function runRepositoryKnowledgeSelfTest(): Promise<RepositoryKnowledgeSelfTestResult> {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'alfred-repository-self-test-'))
  const repositoryRoot = join(temporaryRoot, 'sample-work-repository')
  const storageRoot = join(temporaryRoot, 'knowledge-store')
  mkdirSync(repositoryRoot, { recursive: true })
  let assertions = 0
  const check = (condition: unknown, message: string): void => {
    assert(condition, message)
    assertions += 1
  }

  try {
    writeFixture(repositoryRoot, 'README.md', `# Payment Reliability Service

This project keeps payment requests reliable without charging a customer twice.
这个项目让支付请求可以安全重试，同时避免重复扣款。

The request flow checks authentication, creates an idempotency key, calls the payment endpoint, and records retry latency.
请求先做身份认证，再创建幂等键，然后调用支付接口，并记录重试延迟指标。

Retries stop after three attempts. The service reports the final failure instead of hiding it.`)
    writeFixture(repositoryRoot, 'package.json', JSON.stringify({
      name: 'payment-reliability-service',
      description: 'A Node.js service for safe payment retries and duplicate request prevention',
      scripts: { test: 'node --test' },
      engines: { node: '>=20' },
      runtime: 'Node.js 20'
    }, null, 2))
    writeFixture(repositoryRoot, 'src/payment.ts', `export async function retryPayment(idempotencyKey: string): Promise<string> {
  // 支付失败最多重试三次，使用退避等待，并通过幂等键避免重复扣款。
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await sendPayment(idempotencyKey)
    if (result.ok) return result.id
    if (attempt < 3) await exponentialBackoff(attempt)
  }
  throw new Error('payment failed after final retry')
}

declare function sendPayment(key: string): Promise<{ ok: boolean; id: string }>
declare function exponentialBackoff(attempt: number): Promise<void>`)
    writeFixture(repositoryRoot, 'src/auth.ts', `export function validateToken(token: { expired: boolean; scope: string }): boolean {
  // 身份认证和授权边界：拒绝过期 token，并要求 payment:write scope。
  // Authentication and authorization boundary rejects expired tokens.
  return !token.expired && token.scope === 'payment:write'
}`)
    writeFixture(repositoryRoot, 'tests/payment.test.ts', `import test from 'node:test'

test('payment retry stops after three attempts', async () => {
  // 验证支付重试、重复请求和最终失败处理。
  // This test verifies duplicate requests and final failure handling.
  const expectedRetryCount = 3
  if (expectedRetryCount !== 3) throw new Error('invalid fixture')
})`)
    writeFixture(repositoryRoot, 'config/service.yaml', `payment_endpoint: /v1/payments
api_timeout_ms: 1200
retry_delay_ms: 200
# 支付 endpoint、API 超时和重试等待配置`)
    writeFixture(repositoryRoot, '.env', 'API_KEY=sk-this-must-never-be-indexed-1234567890')
    writeFixture(repositoryRoot, 'node_modules/ignored/index.js', 'secret dependency text')

    const first = await indexRepository(
      { rootPath: repositoryRoot, generateKnowledgePack: false },
      testConfig(),
      { storageRoot }
    )
    check(first.state === 'ready' || first.state === 'ready-with-warnings', 'first snapshot is not ready')
    check(first.filesIndexed >= 6, 'expected repository files were not indexed')
    const stored = loadStoredSnapshot(first.id, storageRoot)
    check(!stored.evidence.some((item) => item.relativePath === '.env'), '.env entered the evidence index')
    check(!stored.evidence.some((item) => item.content.includes('sk-this-must-never')), 'secret content entered evidence')
    check(!stored.evidence.some((item) => item.relativePath.includes('node_modules')), 'dependency directory entered evidence')
    check(stored.snapshot.knowledgePack.facts.every((item) => item.evidenceIds.every((id) => stored.evidence.some((evidence) => evidence.id === id))), 'knowledge fact has invalid evidence')
    check(prewarmRepositorySnapshot(first.id, storageRoot).id === first.id, 'prewarm returned the wrong snapshot')

    const mockEvidence = stored.evidence.find((item) => item.relativePath === 'README.md')
    check(Boolean(mockEvidence), 'mock distillation evidence was not found')
    const fallbackPack = buildDeterministicKnowledgePack(
      first.id,
      first.repositoryName,
      stored.evidence
    )
    const originalFetch = globalThis.fetch
    let mockFetchCalls = 0
    let validationRequestBody = ''
    try {
      globalThis.fetch = (async (_input, init): Promise<Response> => {
        mockFetchCalls += 1
        if (mockFetchCalls === 3) validationRequestBody = String(init?.body ?? '')
        const content = mockFetchCalls === 1
          ? '{"facts":[{"id":"truncated"'
          : mockFetchCalls === 2
          ? JSON.stringify({
              facts: [{
                id: 'mock-fact',
                category: 'design',
                statement: 'Payment requests use an idempotency key before the payment call.',
                evidenceIds: [mockEvidence!.id],
                confidence: 'high',
                aliases: ['idempotency', '幂等']
              }],
              glossary: [],
              likelyQuestions: [{
                question: 'How are duplicate payment requests prevented?',
                factIds: ['mock-fact'],
                evidenceIds: [mockEvidence!.id]
              }]
            })
          : JSON.stringify({
              approvedFactIds: ['mock-fact'],
              approvedGlossaryTerms: [],
              approvedQuestionIndexes: [0],
              warnings: []
            })
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }) as typeof fetch
      const verifiedPack = await distillRepositoryKnowledgePack(
        { ...testConfig(), baseURL: 'https://self-test.invalid', apiKey: 'self-test-key' },
        first.id,
        first.repositoryName,
        stored.evidence,
        fallbackPack
      )
      check(mockFetchCalls === 3, 'offline knowledge pack did not retry truncated JSON before independent validation')
      check(verifiedPack.generatedBy === 'llm-verified', 'verified mock knowledge pack was not published')
      check(verifiedPack.facts[0]?.evidenceIds[0] === mockEvidence!.id, 'verified fact lost provenance')
      check(validationRequestBody.includes(mockEvidence!.id), 'validation request omitted referenced evidence')
      const unrelatedEvidence = stored.evidence.find((item) => item.relativePath === 'src/auth.ts')
      check(
        !unrelatedEvidence || !validationRequestBody.includes(unrelatedEvidence.id),
        'validation request retained unrelated evidence and missed the cost boundary'
      )
    } finally {
      globalThis.fetch = originalFetch
    }
    for (const [question, expected] of STRATEGY_FIXTURES) {
      check(
        resolveAnswerStrategy(question) === expected,
        `answer strategy mismatch for “${question}”: expected ${expected}`
      )
    }

    let maxRetrievalMs = 0
    for (const fixture of RETRIEVAL_FIXTURES) {
      const context = retrieveRepositoryContext({
        snapshotId: first.id,
        question: fixture.question,
        maxEvidence: 8,
        maxCharacters: 10_000
      }, storageRoot)
      maxRetrievalMs = Math.max(maxRetrievalMs, context.retrievalMs)
      check(
        context.evidence.some((item) => item.relativePath === fixture.expectedPath),
        `retrieval missed ${fixture.expectedPath} for: ${fixture.question}`
      )
      check(context.evidence.length <= 8, 'retrieval exceeded evidence count budget')
      check(
        context.evidence.reduce((sum, item) => sum + item.content.length, 0) <= 10_000,
        'retrieval exceeded character safety budget'
      )
    }
    check(maxRetrievalMs <= 50, `retrieval P95 target exceeded in fixture: ${maxRetrievalMs}ms`)
    const exactEvidence = getRepositoryEvidence(
      first.id,
      stored.evidence.slice(0, 3).map((item) => item.id),
      storageRoot
    )
    check(exactEvidence.length === 3, 'exact provenance lookup failed')

    const reused = await indexRepository(
      { rootPath: repositoryRoot, generateKnowledgePack: false },
      testConfig(),
      { storageRoot }
    )
    check(reused.id === first.id, 'unchanged repository did not reuse immutable snapshot')

    writeFixture(repositoryRoot, 'src/metrics.ts', `export const retryMetric = 'payment_retry_total'`)
    const freshness = await checkRepositorySnapshotFreshness(first.id, storageRoot)
    check(freshness.state === 'stale', 'new file in a non-git working tree was not detected as stale')
    const second = await indexRepository(
      { rootPath: repositoryRoot, generateKnowledgePack: false },
      testConfig(),
      { storageRoot }
    )
    check(second.id !== first.id, 'changed repository did not create a new immutable snapshot')
    check(existsSync(join(storageRoot, 'snapshots', first.id)), 'previous immutable snapshot was removed')
    const pending = existsSync(join(storageRoot, 'snapshots'))
      ? readdirSync(join(storageRoot, 'snapshots')).filter((item) => item.startsWith('.pending-'))
      : []
    check(pending.length === 0, 'atomic publication left pending snapshot directories')

    return {
      passed: true,
      assertions,
      retrievalFixtures: RETRIEVAL_FIXTURES.length,
      maxRetrievalMs,
      firstSnapshotId: first.id,
      secondSnapshotId: second.id
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
}
