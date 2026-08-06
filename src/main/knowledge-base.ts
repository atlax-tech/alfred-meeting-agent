/**
 * 为个人认知—表达蒸馏准备知识库样本。
 *
 * 只读取工作、学习、创作三个白名单区域；个人、生活、日记、原始素材和归档
 * 永远不会进入语料。返回内容不包含文件名、路径、frontmatter、代码块和常见 PII。
 */

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync
} from 'fs'
import { extname, isAbsolute, join, relative, resolve } from 'path'
import type {
  KnowledgeBaseCorpus,
  KnowledgeBaseSampleChunk
} from '@shared/types'

const ALLOWED_ROOTS = ['20-工作与项目', '30-学习与成长', '40-灵感与创作']
const EXCLUDED_ROOTS = [
  '00-META',
  '10-RAW',
  '50-生活与自我',
  '60-日记与情绪',
  '90-ARCHIVE'
]
const ALLOWED_EXTENSIONS = new Set(['.md', '.txt'])
const MAX_CORPUS_CHARACTERS = 300_000
const MAX_FILE_SAMPLE_CHARACTERS = 6_000
const MAX_CHUNK_CHARACTERS = 32_000
const PRIVATE_LINE_PATTERN =
  /(?:身份证|手机号|手机号码|家庭住址|住址|银行卡|密码|验证码|私钥|恢复码|薪资|工资|房租|存款|负债|家人|父母|伴侣|男朋友|女朋友|病历|疾病诊断|服药|日记|情绪记录|生日|出生日期|户籍|求职进展|个人现金流)/u

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function collectTextFiles(directory: string, root: string, output: string[]): void {
  if (!existsSync(directory)) return
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const path = join(directory, entry.name)
    if (!isWithinRoot(root, resolve(path))) continue
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      collectTextFiles(path, root, output)
      continue
    }
    if (entry.isFile() && ALLOWED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      output.push(path)
    }
  }
}

function stripPrivateAndNonProseContent(input: string): string {
  return input
    .replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/u, '')
    .replace(/```[\s\S]*?```/gu, '')
    .replace(/`[^`\n]+`/gu, ' [技术标识] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
    .replace(/\[\[([^|\]]+\|)?([^\]]+)\]\]/gu, '$2')
    .replace(/\[[^\]]+\]\(https?:\/\/[^)]+\)/gu, '[外部资料]')
    .replace(/https?:\/\/\S+/gu, '[链接]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu, '[邮箱]')
    .replace(/(?:\+?86[-\s]?)?1[3-9]\d{9}/gu, '[手机号]')
    .split('\n')
    .filter((line) => !PRIVATE_LINE_PATTERN.test(line))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

function sampleText(text: string): string {
  if (text.length <= MAX_FILE_SAMPLE_CHARACTERS) return text
  const part = Math.floor(MAX_FILE_SAMPLE_CHARACTERS / 3)
  const middleStart = Math.max(0, Math.floor(text.length / 2) - Math.floor(part / 2))
  return [
    text.slice(0, part),
    text.slice(middleStart, middleStart + part),
    text.slice(-part)
  ].join('\n\n')
}

function interleave<T>(groups: T[][]): T[] {
  const result: T[] = []
  const queues = groups.map((group) => group.slice())
  while (queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      const item = queue.shift()
      if (item !== undefined) result.push(item)
    }
  }
  return result
}

function toChunks(samples: string[]): KnowledgeBaseSampleChunk[] {
  const chunks: KnowledgeBaseSampleChunk[] = []
  let buffer = ''
  for (const sample of samples) {
    if (buffer && buffer.length + sample.length + 6 > MAX_CHUNK_CHARACTERS) {
      chunks.push({
        id: `kb-${chunks.length + 1}`,
        text: buffer,
        characterCount: buffer.length
      })
      buffer = ''
    }
    buffer += `${buffer ? '\n\n---\n\n' : ''}${sample}`
  }
  if (buffer) {
    chunks.push({
      id: `kb-${chunks.length + 1}`,
      text: buffer,
      characterCount: buffer.length
    })
  }
  return chunks
}

export function readKnowledgeBaseCorpus(inputPath: string): KnowledgeBaseCorpus {
  const requestedPath = inputPath.trim()
  if (!requestedPath) throw new Error('请先选择知识库目录')
  if (!existsSync(requestedPath) || !lstatSync(requestedPath).isDirectory()) {
    throw new Error('知识库目录不存在或不是文件夹')
  }

  const root = realpathSync(requestedPath)
  const groupedFiles = ALLOWED_ROOTS.map((directoryName) => {
    const files: string[] = []
    collectTextFiles(join(root, directoryName), root, files)
    return files.sort((a, b) => a.localeCompare(b, 'zh-CN'))
  })
  const files = interleave(groupedFiles)
  if (files.length === 0) {
    throw new Error(
      `没有在白名单区域找到 Markdown/TXT：${ALLOWED_ROOTS.join('、')}`
    )
  }

  const samples: string[] = []
  let charactersSampled = 0
  let filesSampled = 0
  for (const file of files) {
    if (charactersSampled >= MAX_CORPUS_CHARACTERS) break
    const cleaned = stripPrivateAndNonProseContent(readFileSync(file, 'utf-8'))
    if (cleaned.length < 120) continue
    const sample = sampleText(cleaned).slice(
      0,
      MAX_CORPUS_CHARACTERS - charactersSampled
    )
    if (sample.length < 120) continue
    samples.push(sample)
    filesSampled += 1
    charactersSampled += sample.length
  }

  if (samples.length === 0) {
    throw new Error('隐私过滤后没有足够的可蒸馏文字')
  }

  return {
    rootPath: root,
    chunks: toChunks(samples),
    filesScanned: files.length,
    filesSampled,
    charactersSampled,
    excludedRoots: EXCLUDED_ROOTS
  }
}
