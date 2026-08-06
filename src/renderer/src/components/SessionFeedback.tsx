import { useEffect, useRef, useState } from 'react'
import type { ConversationSession } from '@shared/types'
import { useInterviewStore } from '../store/interview'

export function SessionFeedback({ session }: { session: ConversationSession }) {
  const updateSessionFeedback = useInterviewStore((state) => state.updateSessionFeedback)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.overallFeedback ?? '')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    setDraft(session.overallFeedback ?? '')
    setEditing(false)
  }, [session.id, session.overallFeedback])

  useEffect(() => {
    if (!editing) return
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [editing])

  const save = () => {
    updateSessionFeedback(session.id, draft)
    setEditing(false)
  }

  if (editing) {
    return (
      <section className="rounded-lg border border-accent/30 bg-accent/5 p-3" aria-label="整轮对话反馈">
        <div className="mb-1 text-xs font-medium text-accent-glow">整轮对话反馈</div>
        <p className="mb-2 text-[10px] leading-4 text-slate-500">
          粘贴对方对整场表现的评价。保存后立即影响后续回答，并进入本地持续蒸馏证据账本。
        </p>
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value.slice(0, 6000))}
          placeholder="例如：回答整体偏长；项目例子需要更具体；英文表达要更简单；遇到不熟悉的问题不要过度包装……"
          rows={5}
          aria-label="整轮对话反馈内容"
          className="w-full resize-none rounded-md border border-bg-hover bg-bg px-3 py-2 text-xs leading-5 text-slate-200 outline-none placeholder:text-slate-600 focus:border-accent"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[10px] text-slate-600">最多 6000 字，后续会增量合并为画像新版本</span>
          <div className="flex shrink-0 gap-1.5">
            <button
              type="button"
              onClick={() => {
                setDraft(session.overallFeedback ?? '')
                setEditing(false)
              }}
              className="rounded px-2 py-1 text-[11px] text-slate-400 hover:bg-bg-hover hover:text-white"
            >
              取消
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!draft.trim() && !session.overallFeedback}
              className="rounded bg-accent px-2.5 py-1 text-[11px] text-white hover:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {session.overallFeedback ? (draft.trim() ? '保存修改' : '删除反馈') : '保存并应用'}
            </button>
          </div>
        </div>
      </section>
    )
  }

  if (session.overallFeedback) {
    return (
      <section className="rounded-lg border border-ok/20 bg-ok/5 p-3" aria-label="整轮对话反馈">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-ok">✓ 整轮反馈已进入持续蒸馏</span>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-[10px] text-slate-500 hover:text-white"
          >
            修改
          </button>
        </div>
        <div className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-5 text-slate-400">
          {session.overallFeedback}
        </div>
      </section>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="w-full rounded-lg border border-dashed border-accent/30 bg-accent/5 px-3 py-3 text-left transition hover:border-accent/60 hover:bg-accent/10"
    >
      <div className="text-xs font-medium text-accent-glow">＋ 添加整轮对话反馈</div>
      <div className="mt-1 text-[10px] text-slate-500">适合粘贴练习结束后收到的总体评价，后续对话会自动应用</div>
    </button>
  )
}
