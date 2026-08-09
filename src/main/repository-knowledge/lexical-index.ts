import type { RepositoryEvidence } from '@shared/types'

export interface SerializedLexicalIndex {
  version: 1
  averageDocumentLength: number
  documentLengths: number[]
  postings: Record<string, Array<[number, number]>>
  /** 由相对 import/require/include 解析出的轻量文件关系图。 */
  relatedDocuments: Record<number, number[]>
}

export interface RankedEvidence {
  evidence: RepositoryEvidence
  score: number
  documentIndex: number
}

function identifierParts(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .split(/[\s_./:$-]+/gu)
    .filter((item) => item.length > 1)
}

export function tokenizeSearchText(value: string): string[] {
  const normalized = value.normalize('NFKC')
  const tokens: string[] = []
  const words = normalized.match(/[A-Za-z0-9_$][A-Za-z0-9_$.-]*/gu) ?? []
  for (const word of words) {
    const lowered = word.toLocaleLowerCase()
    if (lowered.length > 1) tokens.push(lowered)
    for (const part of identifierParts(word)) {
      const loweredPart = part.toLocaleLowerCase()
      if (loweredPart.length > 1 && loweredPart !== lowered) tokens.push(loweredPart)
    }
  }
  const han = normalized.toLocaleLowerCase().match(/\p{Script=Han}/gu) ?? []
  for (let index = 0; index < han.length; index++) {
    tokens.push(han[index])
    if (index + 1 < han.length) tokens.push(`${han[index]}${han[index + 1]}`)
  }
  return tokens
}

function documentTokens(evidence: RepositoryEvidence): string[] {
  return [
    ...tokenizeSearchText(evidence.content),
    ...tokenizeSearchText(evidence.relativePath),
    ...tokenizeSearchText(evidence.title),
    ...evidence.searchTerms.flatMap(tokenizeSearchText),
    ...evidence.searchTerms.flatMap(tokenizeSearchText)
  ]
}

export async function buildLexicalIndex(
  evidence: RepositoryEvidence[]
): Promise<SerializedLexicalIndex> {
  const postings = new Map<string, Array<[number, number]>>()
  const documentLengths: number[] = []
  const firstDocumentByFile = new Map<string, number>()

  for (const [documentIndex, item] of evidence.entries()) {
    if (!firstDocumentByFile.has(item.relativePath)) {
      firstDocumentByFile.set(item.relativePath, documentIndex)
    }
    const tokens = documentTokens(item)
    documentLengths.push(Math.max(1, tokens.length))
    const frequencies = new Map<string, number>()
    for (const token of tokens) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
    }
    for (const [token, frequency] of frequencies) {
      const rows = postings.get(token) ?? []
      rows.push([documentIndex, frequency])
      postings.set(token, rows)
    }
    if (documentIndex % 200 === 0) {
      await new Promise<void>((resolveYield) => setImmediate(resolveYield))
    }
  }

  const serialized: Record<string, Array<[number, number]>> = {}
  for (const token of [...postings.keys()].sort()) {
    serialized[token] = postings.get(token) ?? []
  }
  const totalLength = documentLengths.reduce((sum, value) => sum + value, 0)
  const relatedDocuments = buildRelationshipGraph(evidence, firstDocumentByFile)
  return {
    version: 1,
    averageDocumentLength: evidence.length > 0 ? totalLength / evidence.length : 1,
    documentLengths,
    postings: serialized,
    relatedDocuments
  }
}

function normalizeModulePath(value: string): string {
  const parts: string[] = []
  for (const part of value.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/')
}

function directoryOf(relativePath: string): string {
  const index = relativePath.lastIndexOf('/')
  return index >= 0 ? relativePath.slice(0, index) : ''
}

function importTargets(content: string): string[] {
  const targets: string[] = []
  const pattern = /(?:from\s+|import\s*\(|require\s*\(|#include\s*)['"<]([^'">)]+)['">)]/gu
  for (const match of content.matchAll(pattern)) {
    const target = match[1]?.trim()
    if (target?.startsWith('.')) targets.push(target)
  }
  return [...new Set(targets)].slice(0, 80)
}

function buildRelationshipGraph(
  evidence: RepositoryEvidence[],
  firstDocumentByFile: Map<string, number>
): Record<number, number[]> {
  const relationships = new Map<number, Set<number>>()
  const knownFiles = [...firstDocumentByFile.keys()]
  const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.go', '.rs', '.java', '.swift', '.vue']
  for (const [documentIndex, item] of evidence.entries()) {
    const related = relationships.get(documentIndex) ?? new Set<number>()
    for (const target of importTargets(item.content)) {
      const base = normalizeModulePath(`${directoryOf(item.relativePath)}/${target}`)
      const candidates = extensions.flatMap((extension) => [
        `${base}${extension}`,
        `${base}/index${extension}`
      ])
      const resolved = candidates.find((candidate) => firstDocumentByFile.has(candidate)) ??
        knownFiles.find((file) => file.startsWith(`${base}.`) || file.startsWith(`${base}/index.`))
      const relatedIndex = resolved ? firstDocumentByFile.get(resolved) : undefined
      if (relatedIndex !== undefined && relatedIndex !== documentIndex) {
        related.add(relatedIndex)
        const reverse = relationships.get(relatedIndex) ?? new Set<number>()
        reverse.add(documentIndex)
        relationships.set(relatedIndex, reverse)
      }
    }
    if (related.size > 0) relationships.set(documentIndex, related)
  }
  const result: Record<number, number[]> = {}
  for (const [documentIndex, related] of relationships) {
    result[documentIndex] = [...related].sort((a, b) => a - b).slice(0, 20)
  }
  return result
}

function kindBoost(kind: RepositoryEvidence['kind']): number {
  if (kind === 'manifest' || kind === 'decision') return 1.3
  if (kind === 'documentation' || kind === 'test') return 1.18
  if (kind === 'configuration') return 1.12
  return 1
}

export function searchLexicalIndex(
  index: SerializedLexicalIndex,
  evidence: RepositoryEvidence[],
  query: string,
  limit = 24
): RankedEvidence[] {
  const queryTokens = [...new Set(tokenizeSearchText(query))]
  if (queryTokens.length === 0 || evidence.length === 0) return []
  const scores = new Map<number, number>()
  const totalDocuments = evidence.length
  const k1 = 1.2
  const b = 0.75

  for (const token of queryTokens) {
    const posting = index.postings[token]
    if (!posting?.length) continue
    const idf = Math.log(1 + (totalDocuments - posting.length + 0.5) / (posting.length + 0.5))
    for (const [documentIndex, frequency] of posting) {
      const length = index.documentLengths[documentIndex] ?? 1
      const denominator = frequency + k1 * (1 - b + b * length / index.averageDocumentLength)
      const score = idf * ((frequency * (k1 + 1)) / denominator)
      scores.set(documentIndex, (scores.get(documentIndex) ?? 0) + score)
    }
  }

  const directScores = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
  for (const [documentIndex, score] of directScores) {
    for (const related of index.relatedDocuments?.[documentIndex] ?? []) {
      scores.set(related, Math.max(scores.get(related) ?? 0, score * 0.22))
    }
  }

  const normalizedQuery = query.normalize('NFKC').toLocaleLowerCase().trim()
  return [...scores.entries()]
    .map(([documentIndex, rawScore]) => {
      const item = evidence[documentIndex]
      const searchable = `${item.relativePath}\n${item.title}\n${item.content}`
        .normalize('NFKC')
        .toLocaleLowerCase()
      const phraseBoost = normalizedQuery.length > 3 && searchable.includes(normalizedQuery) ? 6 : 0
      const pathBoost = item.relativePath.toLocaleLowerCase().includes(normalizedQuery) ? 4 : 0
      return {
        evidence: item,
        score: (rawScore + phraseBoost + pathBoost) * kindBoost(item.kind),
        documentIndex
      }
    })
    .sort((a, b) => b.score - a.score || a.evidence.id.localeCompare(b.evidence.id))
    .slice(0, Math.max(1, limit))
}

export function estimateTokens(value: string): number {
  const han = value.match(/\p{Script=Han}/gu)?.length ?? 0
  const remaining = Math.max(0, value.length - han)
  return Math.ceil(han * 0.85 + remaining / 3.8)
}
