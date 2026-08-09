import { app } from 'electron'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { dirname, join, relative, resolve } from 'path'
import type {
  RepositoryEvidence,
  RepositorySnapshot
} from '@shared/types'
import type { SerializedLexicalIndex } from './lexical-index'

const STORAGE_VERSION = 1
const ROOT_DIRECTORY = 'repository-knowledge'
const SNAPSHOT_FILE = 'snapshot.json'
const EVIDENCE_FILE = 'evidence.json'
const INDEX_FILE = 'lexical-index.json'
const FILE_MANIFEST_FILE = 'files.json'
const SAFE_ID_PATTERN = /^[a-z0-9-]{8,80}$/u

export interface StoredFileManifestItem {
  relativePath: string
  contentHash: string
  modifiedAt: number
  size: number
}

export interface StoredRepositorySnapshot {
  snapshot: RepositorySnapshot
  evidence: RepositoryEvidence[]
  index: SerializedLexicalIndex
  files: StoredFileManifestItem[]
}

function storageRoot(override?: string): string {
  return override ?? join(app.getPath('userData'), ROOT_DIRECTORY, `v${STORAGE_VERSION}`)
}

function safeId(value: string, label: string): string {
  if (!SAFE_ID_PATTERN.test(value)) throw new Error(`无效的${label}`)
  return value
}

function snapshotDirectory(snapshotId: string, override?: string): string {
  return join(storageRoot(override), 'snapshots', safeId(snapshotId, '仓库快照 ID'))
}

function ensureWithinRoot(root: string, candidate: string): void {
  const rel = relative(root, candidate)
  if (rel.startsWith('..') || resolve(root, rel) !== resolve(candidate)) {
    throw new Error('仓库索引存储路径越界')
  }
}

function writeJson(path: string, value: unknown): void {
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value), 'utf-8')
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T
}

export function hasStoredSnapshot(snapshotId: string, override?: string): boolean {
  return existsSync(join(snapshotDirectory(snapshotId, override), SNAPSHOT_FILE))
}

export function saveStoredSnapshot(
  value: StoredRepositorySnapshot,
  override?: string
): void {
  const root = storageRoot(override)
  const snapshotsRoot = join(root, 'snapshots')
  if (!existsSync(snapshotsRoot)) mkdirSync(snapshotsRoot, { recursive: true })
  const finalDirectory = snapshotDirectory(value.snapshot.id, override)
  ensureWithinRoot(snapshotsRoot, finalDirectory)
  if (existsSync(finalDirectory)) return

  const temporaryDirectory = join(
    snapshotsRoot,
    `.pending-${value.snapshot.id}-${process.pid}-${Date.now()}`
  )
  ensureWithinRoot(snapshotsRoot, temporaryDirectory)
  mkdirSync(temporaryDirectory, { recursive: false })
  try {
    writeJson(join(temporaryDirectory, SNAPSHOT_FILE), value.snapshot)
    writeJson(join(temporaryDirectory, EVIDENCE_FILE), value.evidence)
    writeJson(join(temporaryDirectory, INDEX_FILE), value.index)
    writeJson(join(temporaryDirectory, FILE_MANIFEST_FILE), value.files)
    renameSync(temporaryDirectory, finalDirectory)
  } catch (error) {
    if (existsSync(temporaryDirectory)) {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
    throw error
  }
}

export function loadStoredSnapshot(
  snapshotId: string,
  override?: string
): StoredRepositorySnapshot {
  const directory = snapshotDirectory(snapshotId, override)
  return {
    snapshot: readJson<RepositorySnapshot>(join(directory, SNAPSHOT_FILE)),
    evidence: readJson<RepositoryEvidence[]>(join(directory, EVIDENCE_FILE)),
    index: readJson<SerializedLexicalIndex>(join(directory, INDEX_FILE)),
    files: readJson<StoredFileManifestItem[]>(join(directory, FILE_MANIFEST_FILE))
  }
}

export function listStoredSnapshots(override?: string): RepositorySnapshot[] {
  const root = join(storageRoot(override), 'snapshots')
  if (!existsSync(root)) return []
  const snapshots: RepositorySnapshot[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SAFE_ID_PATTERN.test(entry.name)) continue
    try {
      snapshots.push(readJson<RepositorySnapshot>(join(root, entry.name, SNAPSHOT_FILE)))
    } catch (error) {
      console.warn(`[repository-knowledge] 忽略损坏的快照 ${entry.name}:`, error)
    }
  }
  return snapshots.sort((a, b) => b.createdAt - a.createdAt)
}

export function latestSnapshotsByRepository(override?: string): RepositorySnapshot[] {
  const latest = new Map<string, RepositorySnapshot>()
  for (const snapshot of listStoredSnapshots(override)) {
    if (!latest.has(snapshot.repositoryId)) latest.set(snapshot.repositoryId, snapshot)
  }
  return [...latest.values()].sort((a, b) => b.createdAt - a.createdAt)
}
