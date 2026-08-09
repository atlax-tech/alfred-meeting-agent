import { createHash } from 'crypto'
import { basename } from 'path'
import type { RepositoryEvidence } from '@shared/types'
import type { ScannedRepositoryFile, ScanProgress } from './scanner'

const MAX_CHUNK_CHARACTERS = 1800
const MAX_CHUNK_LINES = 90
const OVERLAP_LINES = 10
const SYMBOL_PATTERN =
  /\b(?:class|interface|type|enum|function|const|let|var|def|fn|func|struct|trait|protocol|actor|record|module)\s+([A-Za-z_$][\w$-]*)/gu
const HEADING_PATTERN = /^#{1,6}\s+(.+)$/u

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function cleanSearchTerm(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}_$./-]+/gu, ' ')
    .trim()
    .slice(0, 160)
}

function splitIdentifier(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .split(/[\s_./-]+/gu)
    .map((item) => cleanSearchTerm(item).toLocaleLowerCase())
    .filter((item) => item.length > 1)
}

function searchTerms(relativePath: string, title: string, content: string): string[] {
  const terms = new Set<string>()
  for (const value of [relativePath, basename(relativePath), title]) {
    const cleaned = cleanSearchTerm(value)
    if (cleaned) terms.add(cleaned.toLocaleLowerCase())
    for (const part of splitIdentifier(value)) terms.add(part)
  }
  for (const match of content.matchAll(SYMBOL_PATTERN)) {
    const symbol = match[1]
    if (!symbol) continue
    terms.add(symbol.toLocaleLowerCase())
    for (const part of splitIdentifier(symbol)) terms.add(part)
    if (terms.size >= 80) break
  }
  return [...terms].slice(0, 80)
}

function titleForChunk(relativePath: string, lines: string[]): string {
  for (const line of lines) {
    const heading = line.match(HEADING_PATTERN)?.[1]?.trim()
    if (heading) return heading.slice(0, 200)
    SYMBOL_PATTERN.lastIndex = 0
    const symbol = SYMBOL_PATTERN.exec(line)?.[1]
    if (symbol) return `${basename(relativePath)} · ${symbol}`
  }
  return basename(relativePath)
}

function nextBreak(lines: string[], start: number): number {
  let characters = 0
  let end = start
  while (end < lines.length && end - start < MAX_CHUNK_LINES) {
    const nextSize = lines[end].length + 1
    if (end > start && characters + nextSize > MAX_CHUNK_CHARACTERS) break
    characters += nextSize
    end += 1
  }
  if (end >= lines.length) return lines.length
  for (let candidate = end; candidate > start + 10; candidate--) {
    if (!lines[candidate - 1]?.trim() || HEADING_PATTERN.test(lines[candidate] ?? '')) {
      return candidate
    }
  }
  return Math.max(start + 1, end)
}

function chunkFile(file: ScannedRepositoryFile, snapshotId: string): RepositoryEvidence[] {
  const lines = file.content.split('\n')
  const chunks: RepositoryEvidence[] = []
  let start = 0
  while (start < lines.length) {
    const end = nextBreak(lines, start)
    const content = lines.slice(start, end).join('\n').trim()
    if (content) {
      const title = titleForChunk(file.relativePath, lines.slice(start, end))
      const contentHash = hash(content)
      chunks.push({
        id: `ev-${hash(`${snapshotId}\0${file.relativePath}\0${start + 1}\0${contentHash}`).slice(0, 20)}`,
        snapshotId,
        relativePath: file.relativePath,
        title,
        kind: file.kind,
        language: file.language,
        startLine: start + 1,
        endLine: end,
        content,
        contentHash,
        searchTerms: searchTerms(file.relativePath, title, content)
      })
    }
    if (end >= lines.length) break
    start = Math.max(start + 1, end - OVERLAP_LINES)
  }
  return chunks
}

export async function chunkRepositoryFiles(
  files: ScannedRepositoryFile[],
  snapshotId: string,
  onProgress?: (progress: ScanProgress) => void
): Promise<RepositoryEvidence[]> {
  const evidence: RepositoryEvidence[] = []
  for (const [index, file] of files.entries()) {
    onProgress?.({
      completed: index,
      total: files.length,
      message: `正在按结构切分 ${file.relativePath}`
    })
    evidence.push(...chunkFile(file, snapshotId))
    if (index % 40 === 0) await new Promise<void>((resolveYield) => setImmediate(resolveYield))
  }
  onProgress?.({ completed: files.length, total: files.length, message: '仓库结构化切分完成' })
  return evidence
}
