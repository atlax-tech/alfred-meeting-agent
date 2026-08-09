import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import {
  existsSync,
  realpathSync,
  promises as fs
} from 'fs'
import { basename, extname, isAbsolute, join, relative, resolve } from 'path'
import type { RepositoryEvidenceKind } from '@shared/types'

const MAX_FILES = 20_000
const MAX_FILE_BYTES = 1024 * 1024
const MAX_TOTAL_CHARACTERS = 24_000_000
const ALLOWED_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.dart', '.ex', '.exs', '.go', '.graphql',
  '.h', '.hpp', '.html', '.java', '.js', '.json', '.jsx', '.kt', '.kts', '.md',
  '.markdown', '.mjs', '.mm', '.php', '.prisma', '.properties', '.proto', '.py',
  '.rb', '.rs', '.scss', '.sh', '.sql', '.swift', '.toml', '.ts', '.tsx', '.vue',
  '.xml', '.yaml', '.yml', '.zig'
])
const ALLOWED_EXTENSIONLESS = new Set([
  'dockerfile', 'gemfile', 'makefile', 'procfile', 'readme', 'license'
])
const BLOCKED_DIRECTORIES = new Set([
  '.git', '.idea', '.next', '.nuxt', '.output', '.turbo', '.vscode', 'build',
  'coverage', 'dist', 'node_modules', 'out', 'release', 'target', 'vendor'
])
const BLOCKED_FILE_PATTERNS = [
  /^\.env(?:\.|$)/iu,
  /(?:^|[-_.])credentials?(?:[-_.]|$)/iu,
  /(?:^|[-_.])secrets?(?:[-_.]|$)/iu,
  /(?:^|[-_.])private[-_.]?key(?:[-_.]|$)/iu,
  /(?:^|[-_.])id_rsa(?:\.|$)/iu,
  /\.(?:cer|crt|der|jks|keystore|p12|pfx|pem|key)$/iu,
  /(?:package-lock|pnpm-lock|yarn\.lock|composer\.lock|cargo\.lock)$/iu
]
const SECRET_CONTENT_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u,
  /\bsk-[A-Za-z0-9_-]{24,}\b/u,
  /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*['"][^'"\n]{12,}['"]/iu
]

export interface ScannedRepositoryFile {
  relativePath: string
  absolutePath: string
  content: string
  contentHash: string
  modifiedAt: number
  size: number
  language: string
  kind: RepositoryEvidenceKind
}

export interface RepositoryScanResult {
  rootPath: string
  repositoryId: string
  repositoryName: string
  branch: string
  commit: string
  dirty: boolean
  dirtySignature: string
  files: ScannedRepositoryFile[]
  filesScanned: number
  excludedFiles: number
  warnings: string[]
}

export interface ScanProgress {
  completed: number
  total: number
  message: string
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function git(root: string, args: string[]): string {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return ''
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function fallbackFiles(directory: string, root: string, output: string[]): Promise<void> {
  if (output.length >= MAX_FILES || !existsSync(directory)) return
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (output.length >= MAX_FILES) return
    if (entry.name.startsWith('.') || BLOCKED_DIRECTORIES.has(entry.name.toLocaleLowerCase())) continue
    const absolutePath = join(directory, entry.name)
    if (!isWithinRoot(root, resolve(absolutePath)) || entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      await fallbackFiles(absolutePath, root, output)
    } else if (entry.isFile()) {
      output.push(relative(root, absolutePath))
    }
  }
}

async function listCandidateFiles(root: string): Promise<string[]> {
  const gitFiles = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  if (gitFiles) {
    return gitFiles
      .split('\0')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, MAX_FILES)
  }
  const files: string[] = []
  await fallbackFiles(root, root, files)
  return files.sort((a, b) => a.localeCompare(b, 'en'))
}

function blockedPath(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]/u)
  if (segments.some((segment) => BLOCKED_DIRECTORIES.has(segment.toLocaleLowerCase()))) return true
  const name = segments[segments.length - 1] ?? ''
  return BLOCKED_FILE_PATTERNS.some((pattern) => pattern.test(name))
}

function supportedPath(relativePath: string): boolean {
  const name = basename(relativePath).toLocaleLowerCase()
  const extension = extname(name)
  return ALLOWED_EXTENSIONS.has(extension) || ALLOWED_EXTENSIONLESS.has(name)
}

function containsSecret(content: string): boolean {
  return SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(content))
}

function languageForPath(relativePath: string): string {
  const name = basename(relativePath).toLocaleLowerCase()
  if (name === 'dockerfile') return 'dockerfile'
  if (name === 'makefile') return 'makefile'
  const extension = extname(name).slice(1)
  const aliases: Record<string, string> = {
    c: 'c', cc: 'cpp', cpp: 'cpp', cs: 'csharp', h: 'c', hpp: 'cpp',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript',
    md: 'markdown', markdown: 'markdown', mm: 'objective-cpp',
    py: 'python', rb: 'ruby', rs: 'rust', sh: 'shell',
    ts: 'typescript', tsx: 'typescript', yml: 'yaml'
  }
  return aliases[extension] ?? (extension || 'text')
}

function kindForPath(relativePath: string): RepositoryEvidenceKind {
  const normalized = relativePath.toLocaleLowerCase()
  const name = basename(normalized)
  if (/^(?:package|composer|deno|pyproject)\.json$/u.test(name) ||
      /^(?:cargo|go|package|pyproject|requirements|build\.gradle|pom\.)/u.test(name)) {
    return 'manifest'
  }
  if (/(?:^|\/)(?:test|tests|__tests__|spec)(?:\/|$)|\.(?:test|spec)\.[^.]+$/u.test(normalized)) {
    return 'test'
  }
  if (/(?:^|\/)(?:adr|decisions?|architecture)(?:\/|$)/u.test(normalized)) {
    return 'decision'
  }
  if (/readme|\.md$|\.markdown$/u.test(name)) return 'documentation'
  if (/(?:config|\.ya?ml$|\.toml$|\.properties$|dockerfile|makefile)/u.test(name)) {
    return 'configuration'
  }
  if (ALLOWED_EXTENSIONS.has(extname(name))) return 'source'
  return 'other'
}

function normalizeText(buffer: Buffer): string {
  if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) return ''
  return buffer
    .toString('utf-8')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, '')
    .trim()
}

export async function scanRepository(
  inputPath: string,
  onProgress?: (progress: ScanProgress) => void
): Promise<RepositoryScanResult> {
  const requested = inputPath.trim()
  if (!requested || !existsSync(requested) || !(await fs.lstat(requested)).isDirectory()) {
    throw new Error('请选择存在的工作仓库目录')
  }
  const rootPath = await fs.realpath(requested)
  const candidates = await listCandidateFiles(rootPath)
  const warnings: string[] = []
  const files: ScannedRepositoryFile[] = []
  let excludedFiles = 0
  let totalCharacters = 0

  for (const [index, relativePath] of candidates.entries()) {
    onProgress?.({
      completed: index,
      total: candidates.length,
      message: `正在安全扫描 ${relativePath}`
    })
    if (blockedPath(relativePath) || !supportedPath(relativePath)) {
      excludedFiles += 1
      continue
    }
    const absolutePath = resolve(rootPath, relativePath)
    if (!isWithinRoot(rootPath, absolutePath)) {
      excludedFiles += 1
      continue
    }
    let stats
    try {
      const realFilePath = await fs.realpath(absolutePath)
      if (!isWithinRoot(rootPath, realFilePath)) {
        excludedFiles += 1
        continue
      }
      stats = await fs.lstat(absolutePath)
    } catch {
      excludedFiles += 1
      continue
    }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_FILE_BYTES) {
      excludedFiles += 1
      continue
    }
    const buffer = await fs.readFile(absolutePath)
    const content = normalizeText(buffer)
    if (!content || containsSecret(content)) {
      excludedFiles += 1
      if (content && containsSecret(content)) {
        warnings.push(`已排除疑似包含凭据的文件：${relativePath}`)
      }
      continue
    }
    if (totalCharacters + content.length > MAX_TOTAL_CHARACTERS) {
      warnings.push('仓库文本超过本地索引上限，已停止继续读取后续文件')
      excludedFiles += candidates.length - index
      break
    }
    totalCharacters += content.length
    files.push({
      relativePath: relativePath.replaceAll('\\', '/'),
      absolutePath,
      content,
      contentHash: hash(buffer),
      modifiedAt: stats.mtimeMs,
      size: stats.size,
      language: languageForPath(relativePath),
      kind: kindForPath(relativePath)
    })
    if (index % 40 === 0) await new Promise<void>((resolveYield) => setImmediate(resolveYield))
  }

  if (files.length === 0) throw new Error('安全过滤后没有找到可索引的仓库文本')
  if (candidates.length >= MAX_FILES) warnings.push(`仓库文件数达到 ${MAX_FILES} 个扫描上限`)

  const commit = git(rootPath, ['rev-parse', 'HEAD'])
  const branch = git(rootPath, ['branch', '--show-current']) || 'detached-or-local'
  const status = git(rootPath, ['status', '--porcelain=v1', '--untracked-files=all'])
  const repositoryId = `repo-${hash(rootPath).slice(0, 16)}`
  onProgress?.({ completed: candidates.length, total: candidates.length, message: '仓库安全扫描完成' })

  return {
    rootPath,
    repositoryId,
    repositoryName: basename(rootPath),
    branch,
    commit: commit || 'working-tree',
    dirty: Boolean(status),
    dirtySignature: hash(status || 'clean'),
    files,
    filesScanned: candidates.length,
    excludedFiles,
    warnings: [...new Set(warnings)].slice(0, 100)
  }
}

export function currentRepositorySignature(rootPath: string): {
  commit: string
  dirty: boolean
  dirtySignature: string
} {
  const root = realpathSync(rootPath)
  const commit = git(root, ['rev-parse', 'HEAD']) || 'working-tree'
  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all'])
  return {
    commit,
    dirty: Boolean(status),
    dirtySignature: hash(status || 'clean')
  }
}

export function repositoryFileFingerprint(file: ScannedRepositoryFile): string {
  return `${file.relativePath}\0${file.contentHash}\0${Math.round(file.modifiedAt)}\0${file.size}`
}
