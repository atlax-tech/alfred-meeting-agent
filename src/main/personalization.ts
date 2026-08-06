/**
 * 个人认知—表达画像持久化。
 *
 * 画像只保存抽象规则，不保存知识库原文或问答原文。每次更新前归档旧版本，
 * 便于在用户认为画像偏离自己时回滚。
 */

import { app } from 'electron'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import {
  createEmptyPersonalizationProfile,
  type PersonalizationFeedbackEvidence,
  type PersonalizationProfile,
  type PersonalizationRule,
  type PersonalizationVersionSummary
} from '@shared/types'

const PROFILE_FILENAME = 'personalization.json'
const EVIDENCE_FILENAME = 'personalization-feedback.json'
const VERSIONS_DIRECTORY = 'personalization-versions'

function getProfilePath(): string {
  return join(app.getPath('userData'), PROFILE_FILENAME)
}

function getVersionsPath(): string {
  return join(app.getPath('userData'), VERSIONS_DIRECTORY)
}

function getEvidencePath(): string {
  return join(app.getPath('userData'), EVIDENCE_FILENAME)
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function normalizeRule(value: unknown, index: number): PersonalizationRule | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<PersonalizationRule>
  const instruction = cleanText(raw.instruction, 1000)
  if (!instruction) return null

  const confidence =
    raw.confidence === 'stable' || raw.confidence === 'supported'
      ? raw.confidence
      : 'candidate'
  const sources = Array.isArray(raw.sources)
    ? raw.sources.filter(
        (source): source is PersonalizationRule['sources'][number] =>
          source === 'knowledge-base' ||
          source === 'qa-feedback' ||
          source === 'session-feedback' ||
          source === 'user-confirmed'
      )
    : []

  return {
    id: cleanText(raw.id, 80) || `rule-${index + 1}`,
    title: cleanText(raw.title, 120) || `个人规则 ${index + 1}`,
    instruction,
    appliesWhen: cleanText(raw.appliesWhen, 500) || '当这条规律与当前问题相关时',
    avoid: cleanText(raw.avoid, 500) || undefined,
    evidenceCount: Math.max(1, Math.min(999, Number(raw.evidenceCount) || 1)),
    confidence,
    sources: [...new Set(sources)]
  }
}

function normalizeRules(value: unknown, maxItems = 12): PersonalizationRule[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item, index) => normalizeRule(item, index))
    .filter((item): item is PersonalizationRule => item !== null)
    .slice(0, maxItems)
}

export function normalizePersonalizationProfile(
  value: unknown,
  fallback = createEmptyPersonalizationProfile()
): PersonalizationProfile {
  if (!value || typeof value !== 'object') return structuredClone(fallback)
  const raw = value as Partial<PersonalizationProfile>
  const stats = raw.sourceStats

  return {
    schemaVersion: 1,
    profileVersion: Math.max(0, Math.floor(Number(raw.profileVersion) || 0)),
    enabled: raw.enabled !== false,
    autoDistillFeedback: raw.autoDistillFeedback !== false,
    feedbackDistillThreshold: Math.max(
      1,
      Math.min(20, Math.floor(Number(raw.feedbackDistillThreshold) || 3))
    ),
    status: raw.status === 'active' ? 'active' : 'empty',
    knowledgeBasePath: cleanText(raw.knowledgeBasePath, 2000),
    updatedAt: Math.max(0, Number(raw.updatedAt) || 0),
    cognitiveRules: normalizeRules(raw.cognitiveRules),
    expressionRules: normalizeRules(raw.expressionRules),
    spokenRules: normalizeRules(raw.spokenRules),
    antiPatterns: normalizeRules(raw.antiPatterns),
    boundaries: Array.isArray(raw.boundaries)
      ? raw.boundaries
          .map((item) => cleanText(item, 500))
          .filter(Boolean)
          .slice(0, 12)
      : fallback.boundaries,
    sourceStats: {
      knowledgeFilesScanned: Math.max(0, Number(stats?.knowledgeFilesScanned) || 0),
      knowledgeFilesSampled: Math.max(0, Number(stats?.knowledgeFilesSampled) || 0),
      knowledgeCharactersSampled: Math.max(
        0,
        Number(stats?.knowledgeCharactersSampled) || 0
      ),
      feedbackRecords: Math.max(0, Number(stats?.feedbackRecords) || 0),
      approvedAnswers: Math.max(0, Number(stats?.approvedAnswers) || 0),
      pendingFeedbackRecords: Math.max(
        0,
        Number(stats?.pendingFeedbackRecords) || 0
      )
    }
  }
}

export function loadPersonalizationProfile(): PersonalizationProfile {
  const empty = createEmptyPersonalizationProfile()
  try {
    const path = getProfilePath()
    if (!existsSync(path)) return empty
    return normalizePersonalizationProfile(JSON.parse(readFileSync(path, 'utf-8')), empty)
  } catch (error) {
    console.error('[personalization] 加载画像失败:', error)
    return empty
  }
}

function writeJson(path: string, value: unknown): void {
  const directory = join(path, '..')
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8')
}

function writeProfile(path: string, profile: PersonalizationProfile): void {
  writeJson(path, profile)
}

function archiveProfile(profile: PersonalizationProfile): void {
  if (profile.profileVersion <= 0) return
  const directory = getVersionsPath()
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
  const path = join(directory, `v${profile.profileVersion}.json`)
  if (!existsSync(path)) writeProfile(path, profile)
}

export function savePersonalizationProfile(value: unknown): PersonalizationProfile {
  const current = loadPersonalizationProfile()
  archiveProfile(current)
  const normalized = normalizePersonalizationProfile(value, current)
  const next: PersonalizationProfile = {
    ...normalized,
    profileVersion: Math.max(current.profileVersion + 1, normalized.profileVersion),
    updatedAt: Date.now()
  }
  writeProfile(getProfilePath(), next)
  return next
}

function toSummary(profile: PersonalizationProfile): PersonalizationVersionSummary {
  return {
    profileVersion: profile.profileVersion,
    updatedAt: profile.updatedAt,
    cognitiveRuleCount: profile.cognitiveRules.length,
    expressionRuleCount: profile.expressionRules.length,
    spokenRuleCount: profile.spokenRules.length
  }
}

export function listPersonalizationVersions(): PersonalizationVersionSummary[] {
  const profiles: PersonalizationProfile[] = []
  const current = loadPersonalizationProfile()
  if (current.profileVersion > 0) profiles.push(current)

  const directory = getVersionsPath()
  if (existsSync(directory)) {
    for (const fileName of readdirSync(directory)) {
      if (!/^v\d+\.json$/u.test(fileName)) continue
      try {
        profiles.push(
          normalizePersonalizationProfile(
            JSON.parse(readFileSync(join(directory, fileName), 'utf-8'))
          )
        )
      } catch (error) {
        console.warn(`[personalization] 忽略损坏的历史版本 ${fileName}:`, error)
      }
    }
  }

  return profiles
    .filter((profile, index, all) =>
      all.findIndex((item) => item.profileVersion === profile.profileVersion) === index
    )
    .sort((a, b) => b.profileVersion - a.profileVersion)
    .map(toSummary)
}

export function rollbackPersonalizationProfile(version: number): PersonalizationProfile {
  const requested = Math.max(1, Math.floor(version))
  const path = join(getVersionsPath(), `v${requested}.json`)
  if (!existsSync(path)) throw new Error(`找不到个人画像 v${requested}`)

  const target = normalizePersonalizationProfile(
    JSON.parse(readFileSync(path, 'utf-8'))
  )
  return savePersonalizationProfile(target)
}

function normalizeEvidence(value: unknown): PersonalizationFeedbackEvidence | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<PersonalizationFeedbackEvidence>
  const kind = raw.kind === 'session' ? 'session' : 'qa'
  const sessionId = cleanText(raw.sessionId, 120)
  const id = cleanText(raw.id, 240)
  if (!id || !sessionId) return null
  const feedback = cleanText(raw.feedback, kind === 'session' ? 6000 : 2000)
  const preferredAnswer = cleanText(raw.feedbackDetail?.preferredAnswer, 6000)
  const approved = raw.feedbackDetail?.approved === true
  const hasDimensions = Boolean(raw.feedbackDetail?.dimensions?.length)
  if (!feedback && !preferredAnswer && !approved && !hasDimensions) return null
  const createdAt = Math.max(0, Number(raw.createdAt) || Date.now())
  const updatedAt = Math.max(createdAt, Number(raw.updatedAt) || Date.now())

  return {
    id,
    kind,
    sessionId,
    qaId: cleanText(raw.qaId, 120) || undefined,
    question: cleanText(raw.question, 4000) || undefined,
    answer: cleanText(raw.answer, 10_000) || undefined,
    feedback,
    feedbackDetail: raw.feedbackDetail
      ? {
          dimensions: Array.isArray(raw.feedbackDetail.dimensions)
            ? raw.feedbackDetail.dimensions.filter(
                (dimension) =>
                  dimension === 'thinking' ||
                  dimension === 'speaking' ||
                  dimension === 'accuracy' ||
                  dimension === 'length' ||
                  dimension === 'tone' ||
                  dimension === 'example' ||
                  dimension === 'other'
              )
            : [],
          scope:
            raw.feedbackDetail.scope === 'similar-situations' ||
            raw.feedbackDetail.scope === 'current-language'
              ? raw.feedbackDetail.scope
              : 'general',
          approved,
          preferredAnswer: preferredAnswer || undefined,
          languageCode: cleanText(raw.feedbackDetail.languageCode, 20) || undefined
        }
      : undefined,
    createdAt,
    updatedAt,
    processedProfileVersion:
      Number.isFinite(raw.processedProfileVersion) &&
      Number(raw.processedProfileVersion) > 0
        ? Math.floor(Number(raw.processedProfileVersion))
        : undefined
  }
}

function writeEvidence(records: PersonalizationFeedbackEvidence[]): void {
  writeJson(getEvidencePath(), records)
}

export function loadPersonalizationEvidence(): PersonalizationFeedbackEvidence[] {
  try {
    const path = getEvidencePath()
    if (!existsSync(path)) return []
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(normalizeEvidence)
      .filter((item): item is PersonalizationFeedbackEvidence => item !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  } catch (error) {
    console.error('[personalization] 加载反馈证据失败:', error)
    return []
  }
}

export function upsertPersonalizationEvidence(
  value: unknown
): PersonalizationFeedbackEvidence[] {
  const raw = value as Partial<PersonalizationFeedbackEvidence> | null
  const id = cleanText(raw?.id, 240)
  if (!id) throw new Error('反馈证据缺少 id')
  const records = loadPersonalizationEvidence()
  const existing = records.find((record) => record.id === id)
  const normalized = normalizeEvidence({
    ...raw,
    createdAt: existing?.createdAt ?? raw?.createdAt,
    processedProfileVersion: undefined
  })
  const next = normalized
    ? [normalized, ...records.filter((record) => record.id !== id)]
    : records.filter((record) => record.id !== id)
  writeEvidence(next)
  return next
}

export function markPersonalizationEvidenceProcessed(
  profileVersion: number
): PersonalizationFeedbackEvidence[] {
  const next = loadPersonalizationEvidence().map((record) => ({
    ...record,
    processedProfileVersion:
      record.processedProfileVersion ?? Math.max(1, Math.floor(profileVersion))
  }))
  writeEvidence(next)
  return next
}
