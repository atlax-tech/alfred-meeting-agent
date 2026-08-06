import { spawn } from 'child_process'
import {
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'fs'
import { isAbsolute, join, relative, resolve } from 'path'
import type {
  KnowledgeMaintenanceResult,
  MeetingNoteEntry,
  MeetingNoteExportPayload,
  MeetingNoteSaveResult,
  SessionPreset
} from '@shared/types'

const KNOWLEDGE_BASE_ROOT = '/Users/qilong.lu/WorkDir/外置赛博大脑'
const MEETING_DIRECTORY = '20-工作与项目/会议'
const MAX_ENTRY_COUNT = 500
const MAX_ENTRY_CHARACTERS = 400_000
const MAINTENANCE_TIMEOUT_MS = 5 * 60 * 1000

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

function localDateParts(timestamp: number): {
  date: string
  year: string
  month: string
  day: string
  time: string
} {
  const value = new Date(timestamp)
  const year = String(value.getFullYear())
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  const hours = String(value.getHours()).padStart(2, '0')
  const minutes = String(value.getMinutes()).padStart(2, '0')
  const seconds = String(value.getSeconds()).padStart(2, '0')
  return {
    date: `${year}-${month}-${day}`,
    year,
    month,
    day,
    time: `${hours}${minutes}${seconds}`
  }
}

function sanitizeFileName(value: string): string {
  const cleaned = value
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '-')
    .replace(/\s+/gu, ' ')
    .replace(/[. ]+$/gu, '')
    .trim()
    .slice(0, 64)
  return cleaned || '会议记录'
}

function assertKnowledgeBase(): string {
  if (!existsSync(KNOWLEDGE_BASE_ROOT)) {
    throw new Error(`知识库不存在：${KNOWLEDGE_BASE_ROOT}`)
  }
  if (!statSync(KNOWLEDGE_BASE_ROOT).isDirectory()) {
    throw new Error('知识库路径不是目录')
  }
  const root = realpathSync(KNOWLEDGE_BASE_ROOT)
  if (
    !existsSync(join(root, 'AGENTS.md')) ||
    !existsSync(join(root, '00-META', 'SCHEMA.md'))
  ) {
    throw new Error('知识库缺少 AGENTS.md 或 00-META/SCHEMA.md，已停止落库')
  }
  return root
}

function assertWithinRoot(root: string, candidate: string): void {
  const rel = relative(root, resolve(candidate))
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('目标文件不在知识库内')
  }
}

function normalizeEntries(value: unknown): MeetingNoteEntry[] {
  if (!Array.isArray(value)) return []
  let usedCharacters = 0
  const entries: MeetingNoteEntry[] = []
  for (const rawValue of value.slice(0, MAX_ENTRY_COUNT)) {
    if (!rawValue || typeof rawValue !== 'object') continue
    const raw = rawValue as Partial<MeetingNoteEntry>
    if (
      raw.type !== 'qa-session' &&
      raw.type !== 'chat-qa' &&
      raw.type !== 'transcript'
    ) {
      continue
    }
    const remaining = MAX_ENTRY_CHARACTERS - usedCharacters
    if (remaining <= 0) break
    const question = cleanText(raw.question, Math.min(20_000, remaining))
    const answer = cleanText(
      raw.answer,
      Math.min(200_000, Math.max(0, remaining - question.length))
    )
    const content = cleanText(
      raw.content,
      Math.min(
        200_000,
        Math.max(0, remaining - question.length - answer.length)
      )
    )
    if (!question && !answer && !content) continue
    usedCharacters += question.length + answer.length + content.length
    entries.push({
      id: cleanText(raw.id, 160) || `entry-${entries.length + 1}`,
      type: raw.type,
      timestamp: Math.max(0, Number(raw.timestamp) || Date.now()),
      question: question || undefined,
      answer: answer || undefined,
      content: content || undefined,
      speaker:
        raw.speaker === 'interviewer' ||
        raw.speaker === 'candidate' ||
        raw.speaker === 'self' ||
        raw.speaker === 'unknown'
          ? raw.speaker
          : undefined,
      preparedQuestionId: cleanText(raw.preparedQuestionId, 160) || undefined
    })
  }
  return entries
}

function normalizePreset(value: unknown): SessionPreset | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Partial<SessionPreset>
  const documents = Array.isArray(raw.documents)
    ? raw.documents.slice(0, 8).flatMap((item, index) => {
        if (!item || typeof item !== 'object') return []
        const text = cleanText(item.text, 80_000)
        if (!text) return []
        return [{
          id: cleanText(item.id, 120) || `document-${index + 1}`,
          name: cleanText(item.name, 240) || `资料 ${index + 1}`,
          text,
          characterCount: text.length,
          truncated: item.truncated === true,
          addedAt: Math.max(0, Number(item.addedAt) || Date.now())
        }]
      })
    : []
  const qaPairs = Array.isArray(raw.qaPairs)
    ? raw.qaPairs.slice(0, 20).flatMap((item, index) => {
        if (!item || typeof item !== 'object') return []
        const question = cleanText(item.question, 1_000)
        const expectedAnswer = cleanText(item.expectedAnswer, 8_000)
        if (!question || !expectedAnswer) return []
        return [{
          id: cleanText(item.id, 120) || `preset-qa-${index + 1}`,
          question,
          expectedAnswer
        }]
      })
    : []
  const preparedQuestions = Array.isArray(raw.preparedQuestions)
    ? raw.preparedQuestions.slice(0, 30).flatMap((item, index) => {
        if (!item || typeof item !== 'object') return []
        const question = cleanText(item.question, 1_000)
        if (!question) return []
        return [{
          id: cleanText(item.id, 120) || `prepared-question-${index + 1}`,
          question
        }]
      })
    : []
  const preset: SessionPreset = {
    topic: cleanText(raw.topic, 200),
    background: cleanText(raw.background, 8_000),
    documents,
    qaPairs,
    preparedQuestions,
    updatedAt: Math.max(0, Number(raw.updatedAt) || 0)
  }
  return preset.topic ||
    preset.background ||
    preset.documents.length ||
    preset.qaPairs.length ||
    preset.preparedQuestions.length
    ? preset
    : undefined
}

function fencedText(value: string): string {
  const longest = Math.max(
    3,
    ...Array.from(value.matchAll(/`+/gu), (match) => match[0].length + 1)
  )
  const fence = '`'.repeat(longest)
  return `${fence}text\n${value}\n${fence}`
}

function entryMarkdown(entry: MeetingNoteEntry, index: number): string {
  const time = new Date(entry.timestamp).toLocaleString('zh-CN', {
    hour12: false
  })
  if (entry.type === 'qa-session') {
    return `## 记录 ${index + 1} · QA 环节

> [!info] 记录属性
> QA 环节 · 用户预置提问 · 发言者现场回答 · ${time}

**我的提问：** ${entry.question ?? ''}

**发言者回答：**

${entry.answer ?? ''}`
  }
  if (entry.type === 'chat-qa') {
    return `## 记录 ${index + 1} · 聊天问答

> [!info] 记录属性
> App 聊天窗口问答 · ${time}

**问题：** ${entry.question ?? ''}

**回答：**

${entry.answer ?? ''}`
  }
  const speakerLabel =
    entry.speaker === 'self'
      ? '我'
      : entry.speaker === 'interviewer'
        ? '发言者 / 系统音频'
        : entry.speaker === 'candidate'
          ? '回答者'
          : '未识别说话者'
  return `## 记录 ${index + 1} · 会议转写

> [!info] 记录属性
> 单轮会议转写 · ${speakerLabel} · ${time}

${entry.content ?? ''}`
}

function presetMarkdown(preset: SessionPreset | undefined): string {
  if (!preset) return ''
  const sections: string[] = ['## 会前预置资料（完整）']
  if (preset.topic) sections.push(`### 会议主题\n\n${preset.topic}`)
  if (preset.background) sections.push(`### 背景与目标\n\n${preset.background}`)
  if (preset.preparedQuestions.length > 0) {
    sections.push(
      `### 我准备向发言者提出的问题\n\n${preset.preparedQuestions
        .map((item, index) => `${index + 1}. ${item.question}`)
        .join('\n')}`
    )
  }
  if (preset.qaPairs.length > 0) {
    sections.push(
      `### 可能问题与期望回答\n\n${preset.qaPairs
        .map(
          (item, index) =>
            `#### 预设问答 ${index + 1}\n\n**可能问题：** ${item.question}\n\n**期望回答：**\n\n${item.expectedAnswer}`
        )
        .join('\n\n')}`
    )
  }
  if (preset.documents.length > 0) {
    sections.push(
      `### 参考资料原文\n\n${preset.documents
        .map(
          (document, index) =>
            `#### 资料 ${index + 1} · ${document.name}\n\n${document.truncated ? '> 注：该资料在会前导入时已按 App 上限截取。\n\n' : ''}${fencedText(document.text)}`
        )
        .join('\n\n')}`
    )
  }
  return sections.join('\n\n')
}

function buildMarkdown(payload: MeetingNoteExportPayload): string {
  const exported = localDateParts(payload.exportedAt)
  const recordProperties = Array.from(
    new Set(
      payload.entries.map((entry) =>
        entry.type === 'qa-session'
          ? 'QA环节'
          : entry.type === 'chat-qa'
            ? '聊天问答'
            : '会议转写'
      )
    )
  )
  const frontmatter = `---
title: ${yamlString(payload.title)}
type: note
area: 工作
created: ${exported.date}
updated: ${exported.date}
tags: [会议, Alfred AI]
status: active
sources: [${yamlString(`Alfred AI 会议助手 ${exported.date}`)}]
record_properties: [${recordProperties.join(', ')}]
session_id: ${yamlString(payload.sessionId)}
session_started_at: ${yamlString(new Date(payload.sessionStartedAt).toISOString())}
---`
  const intro = `# ${payload.title}

这是一份由 Alfred AI 会议助手按用户选择生成的会议记录。只收录用户明确加入笔记的内容；如本轮使用了会前预置，完整资料一并保存在文末。`
  const entries = payload.entries
    .map((entry, index) => entryMarkdown(entry, index))
    .join('\n\n')
  return [frontmatter, intro, entries, presetMarkdown(payload.sessionPreset)]
    .filter(Boolean)
    .join('\n\n')
    .concat('\n')
}

function resolveCodexExecutable(): string {
  const candidates = [
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/Codex.app/Contents/Resources/codex'
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? 'codex'
}

export async function maintainMeetingKnowledgeBase(
  notePath: string
): Promise<KnowledgeMaintenanceResult> {
  let root = ''
  let resolvedNotePath = ''
  try {
    root = assertKnowledgeBase()
    assertWithinRoot(root, notePath)
    if (!existsSync(notePath) || !statSync(notePath).isFile()) {
      throw new Error('待维护的会议记录不存在')
    }
    resolvedNotePath = realpathSync(notePath)
    assertWithinRoot(root, resolvedNotePath)
  } catch (error) {
    return { success: false, message: (error as Error).message }
  }

  const noteRelativePath = relative(root, resolvedNotePath)
  const prompt = `执行一次局部知识库维护。新增会议记录位于：${noteRelativePath}

必须先完整阅读 AGENTS.md、00-META/SCHEMA.md、根 index.md，以及 20-工作与项目/索引.md。严格按当前知识库规则执行，只围绕这份新增会议记录完成必要维护：
1. 保留新增会议记录正文与完整预置资料，不删减、不改写。
2. 创建或更新 20-工作与项目/会议/索引.md，为记录添加链接和一句话摘要。
3. 更新 20-工作与项目/索引.md、根 index.md 与根 log.md；首页只添加真正必要的短入口或近期关注，避免膨胀。
4. 补充明显需要的 WikiLink，检查本次新增链接没有断链。
5. 不修改 10-RAW，不处理无关知识事实，不执行 git push。`

  return await new Promise((resolveResult) => {
    const executable = resolveCodexExecutable()
    const child = spawn(
      executable,
      ['exec', '--cd', root, '--sandbox', 'workspace-write', '--ephemeral', prompt],
      {
        cwd: root,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let output = ''
    let timedOut = false
    const append = (chunk: Buffer | string): void => {
      output = `${output}${String(chunk)}`.slice(-20_000)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, MAINTENANCE_TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolveResult({
        success: false,
        message: `会议记录已写入，但无法启动知识库维护命令：${error.message}`
      })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        resolveResult({
          success: false,
          message: '会议记录已写入，但知识库维护命令运行超时，可稍后重试。'
        })
        return
      }
      if (code !== 0) {
        const detail = output.trim().split('\n').slice(-4).join(' · ')
        resolveResult({
          success: false,
          message: `会议记录已写入，但知识库维护失败${detail ? `：${detail}` : ''}`
        })
        return
      }
      resolveResult({
        success: true,
        message: '知识库索引、知识图谱链接与维护日志已更新。'
      })
    })
  })
}

export async function saveMeetingNote(
  value: unknown
): Promise<MeetingNoteSaveResult> {
  if (!value || typeof value !== 'object') throw new Error('会议笔记数据无效')
  const raw = value as Partial<MeetingNoteExportPayload>
  const entries = normalizeEntries(raw.entries)
  if (entries.length === 0) throw new Error('请至少选择一条记录后再落库')
  const exportedAt = Math.max(0, Number(raw.exportedAt) || Date.now())
  const payload: MeetingNoteExportPayload = {
    title: cleanText(raw.title, 120) || '会议记录',
    sessionId: cleanText(raw.sessionId, 160) || 'unknown-session',
    sessionStartedAt: Math.max(0, Number(raw.sessionStartedAt) || exportedAt),
    exportedAt,
    entries,
    sessionPreset: normalizePreset(raw.sessionPreset)
  }

  const root = assertKnowledgeBase()
  const date = localDateParts(exportedAt)
  const directory = join(
    root,
    MEETING_DIRECTORY,
    date.year,
    date.month,
    date.day
  )
  assertWithinRoot(root, directory)
  mkdirSync(directory, { recursive: true })
  const baseName = `${date.date}-${date.time}-${sanitizeFileName(payload.title)}`
  let notePath = join(directory, `${baseName}.md`)
  let suffix = 2
  while (existsSync(notePath)) {
    notePath = join(directory, `${baseName}-${suffix}.md`)
    suffix += 1
  }
  assertWithinRoot(root, notePath)
  writeFileSync(notePath, buildMarkdown(payload), {
    encoding: 'utf-8',
    flag: 'wx'
  })
  const maintenance = await maintainMeetingKnowledgeBase(notePath)
  return { notePath, maintenance }
}
