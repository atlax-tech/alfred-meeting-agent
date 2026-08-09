import { performance } from 'perf_hooks'
import type {
  AnswerStrategyKind,
  RepositoryEvidence,
  RepositoryRetrievalRequest,
  RepositorySnapshot,
  RetrievedRepositoryContext
} from '@shared/types'
import {
  estimateTokens,
  type RankedEvidence,
  searchLexicalIndex,
  tokenizeSearchText
} from './lexical-index'
import { loadStoredSnapshot, type StoredRepositorySnapshot } from './store'

const cache = new Map<string, StoredRepositorySnapshot>()
const CACHE_LIMIT = 3

function load(snapshotId: string, storageRoot?: string): StoredRepositorySnapshot {
  const cached = cache.get(snapshotId)
  if (cached) {
    cache.delete(snapshotId)
    cache.set(snapshotId, cached)
    return cached
  }
  const stored = loadStoredSnapshot(snapshotId, storageRoot)
  cache.set(snapshotId, stored)
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value as string | undefined
    if (!oldest) break
    cache.delete(oldest)
  }
  return stored
}

function intersects(left: string, right: string): boolean {
  const leftTokens = new Set(tokenizeSearchText(left))
  return tokenizeSearchText(right).some((token) => leftTokens.has(token))
}

function expandedQuery(stored: StoredRepositorySnapshot, request: RepositoryRetrievalRequest): string {
  const values = [request.question, request.sessionTopic ?? '', request.sessionBackground ?? '']
  for (const item of stored.snapshot.knowledgePack.glossary) {
    if ([item.term, ...item.aliases].some((value) => intersects(request.question, value))) {
      values.push(item.term, ...item.aliases)
    }
  }
  for (const item of stored.snapshot.knowledgePack.facts) {
    if (item.aliases.some((value) => intersects(request.question, value))) {
      values.push(...item.aliases)
    }
  }
  return values.filter(Boolean).join('\n')
}

function strategyFacetQueries(strategy: AnswerStrategyKind | undefined): string[] {
  if (strategy === 'project-scenario') {
    return [
      'evidence incomplete uncertainty assumption limited information unknown decision risk 证据不足 信息有限 不确定 假设 决策 风险',
      'specific problem constraint trade-off chose because scope boundary 具体问题 约束 取舍 选择 原因 范围 边界',
      'implementation workflow component changed built action 解决方式 实现 工作流 组件 改动 动作',
      'manual test feedback acceptance verify rollback fallback stop condition result PM 手测 反馈 验收 验证 回滚 降级 停止条件 结果'
    ]
  }
  if (strategy === 'technical-design' || strategy === 'project-deep-dive') {
    return [
      'goal constraint architecture design data flow boundary 目标 约束 架构 设计 数据流 边界',
      'implementation component interface state persistence 实现 组件 接口 状态 持久化',
      'failure error retry rollback fallback risk 异常 失败 重试 回滚 降级 风险',
      'test validation acceptance measurement trade-off 测试 验证 验收 衡量 取舍'
    ]
  }
  if (strategy === 'incident-or-failure') {
    return [
      'symptom failure root cause evidence diagnosis 现象 故障 根因 证据 排查',
      'fix recovery rollback prevention test 修复 恢复 回滚 预防 测试'
    ]
  }
  if (strategy === 'comparison') {
    return [
      'decision constraint trade-off alternative why choose 约束 取舍 备选 为什么 选择',
      'boundary failure cost validation 边界 失败 成本 验证'
    ]
  }
  if (strategy === 'progress-and-result') {
    return [
      'goal completed evidence acceptance remaining risk 目标 完成 证据 验收 剩余 风险',
      'result measurement test validation outcome 结果 衡量 测试 验证 产出'
    ]
  }
  return []
}

interface MergedCandidate extends RankedEvidence {
  facetHits: number
}

function mergeRankedEvidence(
  groups: RankedEvidence[][]
): MergedCandidate[] {
  const merged = new Map<string, MergedCandidate>()
  for (const [groupIndex, group] of groups.entries()) {
    const topScore = group[0]?.score ?? 1
    const groupWeight = groupIndex === 0 ? 1.35 : 1
    for (const item of group) {
      const contribution = groupWeight * item.score / Math.max(0.01, topScore)
      const existing = merged.get(item.evidence.id)
      if (existing) {
        existing.score += contribution
        existing.facetHits += 1
      } else {
        merged.set(item.evidence.id, {
          ...item,
          score: contribution,
          facetHits: 1
        })
      }
    }
  }
  return [...merged.values()].sort(
    (a, b) =>
      b.score - a.score ||
      b.facetHits - a.facetHits ||
      a.evidence.id.localeCompare(b.evidence.id)
  )
}

function coherentScenarioCandidates(
  stored: StoredRepositorySnapshot,
  ranked: MergedCandidate[]
): MergedCandidate[] {
  if (ranked.length === 0) return []
  const fileScores = new Map<string, { score: number; facetCoverage: number }>()
  for (const [index, item] of ranked.slice(0, 32).entries()) {
    const current = fileScores.get(item.evidence.relativePath) ?? {
      score: 0,
      facetCoverage: 0
    }
    current.score += item.score / (1 + index * 0.08)
    current.facetCoverage += item.facetHits / (1 + index * 0.12)
    fileScores.set(item.evidence.relativePath, current)
  }
  const anchorPath = [...fileScores.entries()]
    .sort((a, b) =>
      (b[1].score + b[1].facetCoverage * 0.18) -
      (a[1].score + a[1].facetCoverage * 0.18)
    )[0]?.[0]
  if (!anchorPath) return ranked

  const anchor = ranked.find((item) => item.evidence.relativePath === anchorPath)
  if (!anchor) return ranked
  const lineDistanceFromAnchor = (item: RepositoryEvidence): number => {
    if (
      item.startLine <= anchor.evidence.endLine &&
      item.endLine >= anchor.evidence.startLine
    ) {
      return 0
    }
    return item.startLine > anchor.evidence.endLine
      ? item.startLine - anchor.evidence.endLine
      : anchor.evidence.startLine - item.endLine
  }
  const scenarioWindow = 120
  const byId = new Map(ranked.map((item) => [item.evidence.id, item]))
  for (const [documentIndex, item] of stored.evidence.entries()) {
    if (item.relativePath !== anchorPath) continue
    const distance = lineDistanceFromAnchor(item)
    if (distance > scenarioWindow || byId.has(item.id)) continue
    byId.set(item.id, {
      evidence: item,
      documentIndex,
      score: anchor.score * 0.7 / (1 + distance / 60),
      facetHits: 0
    })
  }

  return [...byId.values()].sort((a, b) => {
    const coherentScore = (item: MergedCandidate): number => {
      if (item.evidence.relativePath !== anchorPath) return item.score
      const distance = lineDistanceFromAnchor(item.evidence)
      if (distance > scenarioWindow) return item.score * 0.45
      return 3 + item.score + 1.2 / (1 + distance / 50)
    }
    return (
      coherentScore(b) - coherentScore(a) ||
      b.facetHits - a.facetHits ||
      a.evidence.startLine - b.evidence.startLine
    )
  })
}

function lineOverlapRatio(left: RepositoryEvidence, right: RepositoryEvidence): number {
  if (left.relativePath !== right.relativePath) return 0
  const overlap = Math.max(
    0,
    Math.min(left.endLine, right.endLine) - Math.max(left.startLine, right.startLine) + 1
  )
  const shorter = Math.min(
    left.endLine - left.startLine + 1,
    right.endLine - right.startLine + 1
  )
  return shorter > 0 ? overlap / shorter : 0
}

function fallbackEvidence(stored: StoredRepositorySnapshot): RepositoryEvidence[] {
  const evidenceById = new Map(stored.evidence.map((item) => [item.id, item]))
  const ids = stored.snapshot.knowledgePack.facts.flatMap((item) => item.evidenceIds)
  return [...new Set(ids)]
    .map((id) => evidenceById.get(id))
    .filter((item): item is RepositoryEvidence => Boolean(item))
}

function selectEvidence(
  stored: StoredRepositorySnapshot,
  request: RepositoryRetrievalRequest
): { evidence: RepositoryEvidence[]; topScore: number } {
  const maxEvidence = Math.max(1, Math.min(12, request.maxEvidence ?? 8))
  const maxCharacters = Math.max(1500, Math.min(20_000, request.maxCharacters ?? 10_000))
  const queryLimit = Math.max(24, maxEvidence * 4)
  const queries = [
    expandedQuery(stored, request),
    ...strategyFacetQueries(request.answerStrategy).map((query) =>
      [request.question, request.sessionTopic ?? '', query].filter(Boolean).join('\n')
    )
  ]
  const merged = mergeRankedEvidence(
    queries.map((query) =>
      searchLexicalIndex(stored.index, stored.evidence, query, queryLimit)
    )
  )
  const ranked = request.answerStrategy === 'project-scenario'
    ? coherentScenarioCandidates(stored, merged)
    : merged
  const candidates = ranked.length > 0
    ? ranked.map((item) => item.evidence)
    : fallbackEvidence(stored)
  const selected: RepositoryEvidence[] = []
  const perFile = new Map<string, number>()
  let characters = 0
  for (const item of candidates) {
    const fileCount = perFile.get(item.relativePath) ?? 0
    const perFileLimit = request.answerStrategy === 'project-scenario' ? 5 : 2
    if (fileCount >= perFileLimit) continue
    if (selected.some((chosen) => lineOverlapRatio(chosen, item) > 0.72)) continue
    if (selected.length > 0 && characters + item.content.length > maxCharacters) continue
    const remaining = maxCharacters - characters
    if (remaining <= 0) break
    const truncatedContent = item.content.slice(0, remaining)
    selected.push(item.content.length > remaining
      ? {
          ...item,
          content: truncatedContent,
          endLine: item.startLine + Math.max(0, truncatedContent.split('\n').length - 1)
        }
      : item)
    perFile.set(item.relativePath, fileCount + 1)
    characters += Math.min(item.content.length, remaining)
    if (selected.length >= maxEvidence) break
  }
  return { evidence: selected, topScore: ranked[0]?.score ?? 0 }
}

function buildBrief(stored: StoredRepositorySnapshot, selected: RepositoryEvidence[]): string {
  const selectedIds = new Set(selected.map((item) => item.id))
  const facts = stored.snapshot.knowledgePack.facts
    .filter((item) => item.evidenceIds.some((id) => selectedIds.has(id)))
    .slice(0, 8)
  const glossary = stored.snapshot.knowledgePack.glossary
    .filter((item) => item.evidenceIds.some((id) => selectedIds.has(id)))
    .slice(0, 8)
  return [
    stored.snapshot.knowledgePack.overview,
    facts.length > 0
      ? `相关事实卡：\n${facts.map((item) => `- [${item.id}] ${item.statement}`).join('\n')}`
      : '',
    glossary.length > 0
      ? `项目术语：\n${glossary.map((item) => `- ${item.term}：${item.plainExplanation}`).join('\n')}`
      : ''
  ].filter(Boolean).join('\n\n')
}

export function prewarmRepositorySnapshot(
  snapshotId: string,
  storageRoot?: string
): RepositorySnapshot {
  return load(snapshotId, storageRoot).snapshot
}

export function retrieveRepositoryContext(
  request: RepositoryRetrievalRequest,
  storageRoot?: string
): RetrievedRepositoryContext {
  const startedAt = performance.now()
  const stored = load(request.snapshotId, storageRoot)
  const selected = selectEvidence(stored, request)
  const tokenEstimate = estimateTokens(selected.evidence.map((item) => item.content).join('\n'))
  const warnings = stored.snapshot.warnings.slice()
  if (selected.evidence.length === 0) warnings.push('当前问题没有检索到可用仓库证据')
  if (tokenEstimate > 4000) warnings.push(`仓库证据约 ${tokenEstimate} tokens，已接近实时上下文预算`)
  const stale = stored.snapshot.state === 'stale'
  return {
    snapshotId: stored.snapshot.id,
    repositoryName: stored.snapshot.repositoryName,
    knowledgeBrief: buildBrief(stored, selected.evidence),
    evidence: selected.evidence,
    confidence:
      stale || selected.evidence.length === 0
        ? 'low'
        : selected.topScore >= 3 || selected.evidence.some((item) => item.kind === 'manifest')
          ? 'high'
          : 'medium',
    stale,
    warnings,
    retrievalMs: Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100)
  }
}

export function clearRepositoryCache(): void {
  cache.clear()
}

export function getRepositoryEvidence(
  snapshotId: string,
  evidenceIds: string[],
  storageRoot?: string
): RepositoryEvidence[] {
  const requested = new Set(evidenceIds.slice(0, 20))
  return load(snapshotId, storageRoot).evidence.filter((item) => requested.has(item.id))
}
