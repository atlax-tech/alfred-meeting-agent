import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  SessionPreset,
  SessionPresetDocument,
  SessionPreparedQuestion,
  SessionPresetQA
} from '@shared/types'
import { createEmptySessionPreset } from '@shared/types'
import {
  MAX_SESSION_PRESET_DOCUMENT_CHARS,
  MAX_SESSION_PRESET_DOCUMENTS,
  MAX_SESSION_PREPARED_QUESTIONS,
  MAX_SESSION_PRESET_QA_PAIRS,
  MAX_SESSION_PRESET_TOTAL_DOCUMENT_CHARS,
  normalizeSessionPreset
} from '../services/session-preset'
import { useInterviewStore } from '../store/interview'

interface SessionPresetPanelProps {
  open: boolean
  onClose: () => void
}

const inputClassName =
  'w-full rounded-md border border-bg-hover bg-bg px-3 py-2 text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-accent'

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function formatCharacters(value: number): string {
  return value >= 10_000 ? `${(value / 10_000).toFixed(1)} 万字` : `${value} 字`
}

function createEmptyQA(): SessionPresetQA {
  return { id: createId('preset-qa'), question: '', expectedAnswer: '' }
}

function createEmptyPreparedQuestion(): SessionPreparedQuestion {
  return { id: createId('prepared-question'), question: '' }
}

export function SessionPresetPanel({ open, onClose }: SessionPresetPanelProps) {
  const preset = useInterviewStore((state) => state.sessionPreset)
  const saveSessionPreset = useInterviewStore((state) => state.saveSessionPreset)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState<SessionPreset>(() =>
    createEmptySessionPreset()
  )
  const [parsing, setParsing] = useState(false)
  const [fileError, setFileError] = useState('')
  const [validationError, setValidationError] = useState('')

  useEffect(() => {
    if (!open) return
    setDraft(structuredClone(preset))
    setFileError('')
    setValidationError('')
  }, [open, preset])

  useEffect(() => {
    if (!open) return
    void window.inview.inputFocusAcquire().catch(() => {})
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !parsing) onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      void window.inview.inputFocusRelease().catch(() => {})
    }
  }, [onClose, open, parsing])

  const documentCharacters = useMemo(
    () => draft.documents.reduce((total, item) => total + item.characterCount, 0),
    [draft.documents]
  )

  if (!open) return null

  const patchQA = (id: string, partial: Partial<SessionPresetQA>) => {
    setDraft((current) => ({
      ...current,
      qaPairs: current.qaPairs.map((item) =>
        item.id === id ? { ...item, ...partial } : item
      )
    }))
  }

  const removeQA = (id: string) => {
    setDraft((current) => ({
      ...current,
      qaPairs: current.qaPairs.filter((item) => item.id !== id)
    }))
  }

  const patchPreparedQuestion = (
    id: string,
    partial: Partial<SessionPreparedQuestion>
  ) => {
    setDraft((current) => ({
      ...current,
      preparedQuestions: current.preparedQuestions.map((item) =>
        item.id === id ? { ...item, ...partial } : item
      )
    }))
  }

  const removePreparedQuestion = (id: string) => {
    setDraft((current) => ({
      ...current,
      preparedQuestions: current.preparedQuestions.filter(
        (item) => item.id !== id
      )
    }))
  }

  const removeDocument = (id: string) => {
    setDraft((current) => ({
      ...current,
      documents: current.documents.filter((item) => item.id !== id)
    }))
  }

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length || parsing) return
    const availableSlots = Math.max(
      0,
      MAX_SESSION_PRESET_DOCUMENTS - draft.documents.length
    )
    if (availableSlots === 0) {
      setFileError(`每轮最多添加 ${MAX_SESSION_PRESET_DOCUMENTS} 份资料`)
      return
    }

    setParsing(true)
    setFileError('')
    const selected = Array.from(files).slice(0, availableSlots)
    const results = await Promise.allSettled(
      selected.map(async (file): Promise<SessionPresetDocument> => {
        const data = await file.arrayBuffer()
        const extracted = (await window.inview.parseReferenceDocument(
          data,
          file.name
        )).trim()
        if (!extracted) throw new Error(`${file.name} 没有提取到可读文字`)
        const text = extracted.slice(0, MAX_SESSION_PRESET_DOCUMENT_CHARS)
        return {
          id: createId('preset-document'),
          name: file.name,
          text,
          characterCount: text.length,
          truncated: extracted.length > text.length,
          addedAt: Date.now()
        }
      })
    )

    const added: SessionPresetDocument[] = []
    const errors: string[] = []
    for (const result of results) {
      if (result.status === 'fulfilled') {
        added.push(result.value)
      } else {
        errors.push((result.reason as Error).message)
      }
    }
    setDraft((current) => {
      const normalized = normalizeSessionPreset({
        ...current,
        documents: [...current.documents, ...added]
      })
      return { ...normalized, qaPairs: current.qaPairs }
    })
    if (files.length > selected.length) {
      errors.push(`本轮最多保留 ${MAX_SESSION_PRESET_DOCUMENTS} 份资料`)
    }
    setFileError(errors.join('；'))
    setParsing(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleSave = () => {
    const hasIncompleteQA = draft.qaPairs.some(
      (item) => !item.question.trim() || !item.expectedAnswer.trim()
    )
    if (hasIncompleteQA) {
      setValidationError('请补全每组预设问题和期望回答，或删除未完成的条目。')
      return
    }
    if (draft.preparedQuestions.some((item) => !item.question.trim())) {
      setValidationError('请填写预置提问，或删除空白条目。')
      return
    }
    setValidationError('')
    saveSessionPreset(normalizeSessionPreset(draft))
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-40 flex flex-col bg-bg-panel text-slate-100"
      role="dialog"
      aria-modal="true"
      aria-label="当前会话预设"
    >
      <header className="bubble-drag flex h-12 shrink-0 items-center justify-between border-b border-bg-card px-4">
        <div>
          <div className="text-sm font-semibold">会话预设</div>
          <div className="mt-0.5 text-[10px] text-accent-glow">
            仅当前问答窗口生效 · 新对话自动清空
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={parsing}
          className="bubble-no-drag flex h-7 w-7 items-center justify-center rounded-md text-lg text-slate-400 hover:bg-bg-hover hover:text-white disabled:opacity-40"
          aria-label="关闭会话预设"
        >
          ×
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <section className="space-y-3" aria-labelledby="session-scope-title">
          <div>
            <h2 id="session-scope-title" className="text-xs font-medium text-slate-200">
              主题与背景
            </h2>
            <p className="mt-1 text-[10px] leading-4 text-slate-500">
              用来限定回答范围。例如“支付重构周会”或“新版本发布风险评审”。
            </p>
          </div>
          <label className="block space-y-1">
            <span className="text-[11px] text-slate-400">本轮主题</span>
            <input
              type="text"
              value={draft.topic}
              maxLength={200}
              onChange={(event) =>
                setDraft((current) => ({ ...current, topic: event.target.value }))
              }
              placeholder="例如：订单系统二期评审会"
              className={inputClassName}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] text-slate-400">背景与本轮目标</span>
            <textarea
              value={draft.background}
              maxLength={8_000}
              rows={5}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  background: event.target.value
                }))
              }
              placeholder="说明参会角色、当前进度、已确定的口径、限制条件，以及你希望本轮重点讨论什么。"
              className={`${inputClassName} resize-y leading-5`}
            />
          </label>
        </section>

        <section className="space-y-3 border-t border-bg-card pt-4" aria-labelledby="prepared-questions-title">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 id="prepared-questions-title" className="text-xs font-medium text-slate-200">
                我准备向发言者提问
              </h2>
              <p className="mt-1 text-[10px] leading-4 text-slate-500">
                当检测到发言者进入 QA 环节时自动调出。点选问题后，可持续记录对方回答。
              </p>
            </div>
            <span className="shrink-0 text-[10px] text-slate-600">
              {draft.preparedQuestions.length}/{MAX_SESSION_PREPARED_QUESTIONS}
            </span>
          </div>

          {draft.preparedQuestions.map((item, index) => (
            <article
              key={item.id}
              className="flex items-start gap-2 rounded-lg border border-bg-hover bg-bg/35 p-3"
            >
              <span className="mt-2 text-[10px] font-medium text-accent-glow">
                {index + 1}
              </span>
              <textarea
                value={item.question}
                maxLength={1_000}
                rows={2}
                onChange={(event) =>
                  patchPreparedQuestion(item.id, { question: event.target.value })
                }
                placeholder="例如：这个方案上线后，您会用哪些指标判断它是否成功？"
                aria-label={`我准备的提问 ${index + 1}`}
                className={`${inputClassName} resize-y leading-5`}
              />
              <button
                type="button"
                onClick={() => removePreparedQuestion(item.id)}
                className="mt-1 rounded px-2 py-1 text-[10px] text-slate-600 hover:bg-danger/10 hover:text-danger"
              >
                删除
              </button>
            </article>
          ))}

          <button
            type="button"
            disabled={
              draft.preparedQuestions.length >= MAX_SESSION_PREPARED_QUESTIONS
            }
            onClick={() =>
              setDraft((current) => ({
                ...current,
                preparedQuestions: [
                  ...current.preparedQuestions,
                  createEmptyPreparedQuestion()
                ]
              }))
            }
            className="w-full rounded-md border border-bg-hover bg-bg-card px-3 py-2 text-xs text-slate-400 hover:bg-bg-hover hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            ＋ 添加我的提问
          </button>
        </section>

        <section className="space-y-3 border-t border-bg-card pt-4" aria-labelledby="session-documents-title">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 id="session-documents-title" className="text-xs font-medium text-slate-200">
                参考资料
              </h2>
              <p className="mt-1 text-[10px] leading-4 text-slate-500">
                回答时只取与当前问题相关的段落，不会整份重复输出。
              </p>
            </div>
            <span className="shrink-0 text-[10px] text-slate-600">
              {draft.documents.length}/{MAX_SESSION_PRESET_DOCUMENTS} · {formatCharacters(documentCharacters)}
            </span>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.docx,.txt,.md,.markdown,.csv,.json,.log"
            onChange={(event) => void handleFiles(event.target.files)}
            className="hidden"
          />
          <button
            type="button"
            disabled={parsing || draft.documents.length >= MAX_SESSION_PRESET_DOCUMENTS}
            onClick={() => fileInputRef.current?.click()}
            className="w-full rounded-md border border-dashed border-bg-hover bg-bg/40 px-3 py-3 text-xs text-slate-400 transition hover:border-accent/50 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {parsing ? '正在本地提取文字…' : '添加 PDF / DOCX / 文本资料'}
          </button>
          <div className="text-[9px] leading-4 text-slate-600">
            单文件最多 20 MB，保留最多 {formatCharacters(MAX_SESSION_PRESET_DOCUMENT_CHARS)}，本轮资料总计最多 {formatCharacters(MAX_SESSION_PRESET_TOTAL_DOCUMENT_CHARS)}。原文件路径不会保存；相关文字会随回答发送给你配置的 LLM。
          </div>
          {fileError ? (
            <div className="rounded border border-danger/20 bg-danger/5 px-3 py-2 text-[10px] leading-4 text-danger">
              {fileError}
            </div>
          ) : null}

          {draft.documents.length > 0 ? (
            <div className="space-y-2">
              {draft.documents.map((document) => (
                <div
                  key={document.id}
                  className="flex items-center gap-3 rounded-md border border-bg-hover bg-bg-card px-3 py-2"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-bg text-xs text-slate-500">
                    文
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] text-slate-300">
                      {document.name}
                    </span>
                    <span className="mt-0.5 block text-[9px] text-slate-600">
                      {formatCharacters(document.characterCount)}
                      {document.truncated ? ' · 已按上限截取' : ''}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => removeDocument(document.id)}
                    className="rounded px-2 py-1 text-[10px] text-slate-500 hover:bg-danger/10 hover:text-danger"
                  >
                    移除
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </section>

        <section className="space-y-3 border-t border-bg-card pt-4" aria-labelledby="session-qa-title">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 id="session-qa-title" className="text-xs font-medium text-slate-200">
                可能问题与期望回答
              </h2>
              <p className="mt-1 text-[10px] leading-4 text-slate-500">
                现场问法可以不同。AI 会按语义匹配，并结合上下文和个人画像生成提词。
              </p>
            </div>
            <span className="shrink-0 text-[10px] text-slate-600">
              {draft.qaPairs.length}/{MAX_SESSION_PRESET_QA_PAIRS}
            </span>
          </div>

          {draft.qaPairs.map((item, index) => (
            <article
              key={item.id}
              className="space-y-2 rounded-lg border border-bg-hover bg-bg/35 p-3"
              style={{ contentVisibility: 'auto', containIntrinsicSize: '180px' }}
            >
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-medium text-accent-glow">
                  预设问答 {index + 1}
                </span>
                <button
                  type="button"
                  onClick={() => removeQA(item.id)}
                  className="rounded px-2 py-1 text-[10px] text-slate-600 hover:bg-danger/10 hover:text-danger"
                >
                  删除
                </button>
              </div>
              <input
                type="text"
                value={item.question}
                maxLength={1_000}
                onChange={(event) => patchQA(item.id, { question: event.target.value })}
                placeholder="可能会问：为什么这次发布延期了？"
                aria-label={`预设问题 ${index + 1}`}
                className={inputClassName}
              />
              <textarea
                value={item.expectedAnswer}
                maxLength={8_000}
                rows={4}
                onChange={(event) =>
                  patchQA(item.id, { expectedAnswer: event.target.value })
                }
                placeholder="写下你希望保留的事实、立场和重点。AI 会根据现场问法自然改写。"
                aria-label={`期望回答 ${index + 1}`}
                className={`${inputClassName} resize-y leading-5`}
              />
            </article>
          ))}

          <button
            type="button"
            disabled={draft.qaPairs.length >= MAX_SESSION_PRESET_QA_PAIRS}
            onClick={() =>
              setDraft((current) => ({
                ...current,
                qaPairs: [...current.qaPairs, createEmptyQA()]
              }))
            }
            className="w-full rounded-md border border-bg-hover bg-bg-card px-3 py-2 text-xs text-slate-400 hover:bg-bg-hover hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            ＋ 添加预设问答
          </button>
        </section>

        {validationError ? (
          <div className="rounded border border-danger/20 bg-danger/5 px-3 py-2 text-[10px] leading-4 text-danger">
            {validationError}
          </div>
        ) : null}
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t border-bg-card bg-bg-panel px-4 py-3">
        <button
          type="button"
          onClick={() => setDraft(createEmptySessionPreset())}
          className="rounded px-3 py-1.5 text-xs text-slate-500 hover:bg-danger/10 hover:text-danger"
        >
          清空预设
        </button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          disabled={parsing}
          className="rounded bg-bg-card px-3 py-1.5 text-xs text-slate-300 hover:bg-bg-hover disabled:opacity-40"
        >
          取消
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={parsing}
          className="rounded bg-accent px-4 py-1.5 text-xs font-medium text-white hover:bg-accent/80 disabled:opacity-40"
        >
          保存到本轮
        </button>
      </footer>
    </div>
  )
}
