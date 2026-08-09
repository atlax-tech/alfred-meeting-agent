import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { isAbsolute, relative, resolve } from 'path'
import type {
  LLMConfig,
  RepositoryIndexProgress,
  RepositoryIndexRequest,
  RepositorySnapshot
} from '@shared/types'
import { chunkRepositoryFiles } from './chunker'
import { buildLexicalIndex } from './lexical-index'
import {
  buildDeterministicKnowledgePack,
  distillRepositoryKnowledgePack,
  validateKnowledgePack
} from './knowledge-pack'
import {
  currentRepositorySignature,
  repositoryFileFingerprint,
  scanRepository
} from './scanner'
import {
  hasStoredSnapshot,
  latestSnapshotsByRepository,
  listStoredSnapshots,
  loadStoredSnapshot,
  saveStoredSnapshot,
  type StoredFileManifestItem
} from './store'

const INDEX_VERSION = 1

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function abortError(): Error {
  const error = new Error('仓库索引已取消')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function progress(
  state: RepositoryIndexProgress['state'],
  stage: RepositoryIndexProgress['stage'],
  completed: number,
  total: number,
  message: string,
  repositoryId?: string,
  error?: string
): RepositoryIndexProgress {
  return { repositoryId, state, stage, completed, total, message, error }
}

export async function indexRepository(
  request: RepositoryIndexRequest,
  llmConfig: LLMConfig,
  options?: {
    signal?: AbortSignal
    storageRoot?: string
    onProgress?: (value: RepositoryIndexProgress) => void
  }
): Promise<RepositorySnapshot> {
  const emit = options?.onProgress ?? (() => {})
  emit(progress('indexing', 'scanning', 0, 1, '正在读取仓库状态'))
  throwIfAborted(options?.signal)
  const scan = await scanRepository(request.rootPath, (value) => {
    throwIfAborted(options?.signal)
    emit(progress(
      'indexing',
      'scanning',
      value.completed,
      value.total,
      value.message,
      scanRepositoryId(request.rootPath)
    ))
  })
  throwIfAborted(options?.signal)

  const contentFingerprint = hash(
    scan.files.map(repositoryFileFingerprint).sort().join('\n')
  )
  const packMode = request.generateKnowledgePack === false ? 'deterministic' : 'verified'
  const snapshotId = `snap-${hash([
    INDEX_VERSION,
    scan.repositoryId,
    scan.commit,
    scan.branch,
    scan.dirtySignature,
    contentFingerprint,
    packMode
  ].join('\0')).slice(0, 24)}`
  if (hasStoredSnapshot(snapshotId, options?.storageRoot)) {
    const existing = loadStoredSnapshot(snapshotId, options?.storageRoot).snapshot
    emit(progress(existing.state, 'ready', 1, 1, '仓库内容未变化，已复用现有知识快照', scan.repositoryId))
    return existing
  }

  emit(progress('indexing', 'chunking', 0, scan.files.length, '正在按代码和文档结构切分', scan.repositoryId))
  const evidence = await chunkRepositoryFiles(scan.files, snapshotId, (value) => {
    throwIfAborted(options?.signal)
    emit(progress('indexing', 'chunking', value.completed, value.total, value.message, scan.repositoryId))
  })
  throwIfAborted(options?.signal)

  emit(progress('indexing', 'indexing', 0, evidence.length, '正在构建本地 BM25 索引', scan.repositoryId))
  const lexicalIndex = await buildLexicalIndex(evidence)
  throwIfAborted(options?.signal)

  const fallback = buildDeterministicKnowledgePack(
    snapshotId,
    scan.repositoryName,
    evidence,
    scan.warnings
  )
  let knowledgePack = fallback
  if (request.generateKnowledgePack !== false) {
    emit(progress('indexing', 'distilling', 0, 2, '正在会前生成仓库事实卡', scan.repositoryId))
    knowledgePack = await distillRepositoryKnowledgePack(
      llmConfig,
      snapshotId,
      scan.repositoryName,
      evidence,
      fallback,
      options?.signal
    )
  }
  throwIfAborted(options?.signal)

  emit(progress('indexing', 'validating', 1, 2, '正在校验事实卡证据引用', scan.repositoryId))
  const validationWarnings = validateKnowledgePack(knowledgePack, evidence)
  if (validationWarnings.length > 0) {
    knowledgePack = {
      ...fallback,
      warnings: [...new Set([...fallback.warnings, ...validationWarnings])]
    }
  }
  const warnings = [...new Set([...scan.warnings, ...knowledgePack.warnings])]
  const snapshot: RepositorySnapshot = {
    id: snapshotId,
    repositoryId: scan.repositoryId,
    repositoryName: scan.repositoryName,
    rootPath: scan.rootPath,
    branch: scan.branch,
    commit: scan.commit,
    dirty: scan.dirty,
    dirtySignature: scan.dirtySignature,
    state: warnings.length > 0 ? 'ready-with-warnings' : 'ready',
    createdAt: Date.now(),
    indexVersion: INDEX_VERSION,
    filesScanned: scan.filesScanned,
    filesIndexed: scan.files.length,
    chunksIndexed: evidence.length,
    charactersIndexed: evidence.reduce((sum, item) => sum + item.content.length, 0),
    excludedFiles: scan.excludedFiles,
    warnings,
    knowledgePack
  }
  const files: StoredFileManifestItem[] = scan.files.map((item) => ({
    relativePath: item.relativePath,
    contentHash: item.contentHash,
    modifiedAt: item.modifiedAt,
    size: item.size
  }))

  emit(progress('indexing', 'saving', 0, 1, '正在原子发布仓库知识快照', scan.repositoryId))
  saveStoredSnapshot({ snapshot, evidence, index: lexicalIndex, files }, options?.storageRoot)
  emit(progress(snapshot.state, 'ready', 1, 1, '仓库知识快照已准备完成', scan.repositoryId))
  return snapshot
}

function scanRepositoryId(inputPath: string): string {
  return `repo-${hash(inputPath.trim()).slice(0, 16)}`
}

export function listRepositorySnapshots(storageRoot?: string): RepositorySnapshot[] {
  return listStoredSnapshots(storageRoot)
}

export function listLatestRepositories(storageRoot?: string): RepositorySnapshot[] {
  return latestSnapshotsByRepository(storageRoot)
}

export async function checkRepositorySnapshotFreshness(
  snapshotId: string,
  storageRoot?: string
): Promise<RepositorySnapshot> {
  const stored = loadStoredSnapshot(snapshotId, storageRoot)
  let stale = false
  try {
    const signature = currentRepositorySignature(stored.snapshot.rootPath)
    stale = signature.commit !== stored.snapshot.commit ||
      signature.dirty !== stored.snapshot.dirty ||
      signature.dirtySignature !== stored.snapshot.dirtySignature
    // 非 Git 目录没有 commit/status 可以反映新增文件。绑定会话前做一次
    // 完整安全扫描并比较文件清单，会议实时问答路径不会执行这个动作。
    if (!stale && stored.snapshot.commit === 'working-tree') {
      const scan = await scanRepository(stored.snapshot.rootPath)
      const currentFiles = new Map(scan.files.map((item) => [item.relativePath, item]))
      stale = currentFiles.size !== stored.files.length || stored.files.some((item) => {
        const current = currentFiles.get(item.relativePath)
        return !current || current.contentHash !== item.contentHash
      })
    }
    if (!stale) {
      for (const item of stored.files) {
        try {
          const filePath = resolve(stored.snapshot.rootPath, item.relativePath)
          const pathFromRoot = relative(stored.snapshot.rootPath, filePath)
          if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
            stale = true
            break
          }
          const stats = await fs.stat(filePath)
          if (stats.size !== item.size || Math.round(stats.mtimeMs) !== Math.round(item.modifiedAt)) {
            stale = true
            break
          }
        } catch {
          stale = true
          break
        }
      }
    }
  } catch {
    stale = true
  }
  return stale ? { ...stored.snapshot, state: 'stale' } : stored.snapshot
}
