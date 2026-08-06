import { useInterviewStore } from '../store/interview'
import { meetingQANoteSourceId } from '../services/meeting-notes'

export function MeetingQAPanel() {
  const qaInvitation = useInterviewStore((state) => state.qaInvitation)
  const preparedQuestions = useInterviewStore(
    (state) => state.sessionPreset.preparedQuestions
  )
  const active = useInterviewStore((state) => state.activeMeetingQA)
  const meetingQAs = useInterviewStore((state) => state.meetingQAs)
  const visibleMeetingQAId = useInterviewStore(
    (state) => state.visibleMeetingQAId
  )
  const selectedIds = useInterviewStore(
    (state) => state.meetingNoteSelectionIds
  )
  const dismissPreparedQuestions = useInterviewStore(
    (state) => state.dismissPreparedQuestions
  )
  const startCapture = useInterviewStore(
    (state) => state.startPreparedQuestionCapture
  )
  const finishCapture = useInterviewStore(
    (state) => state.finishPreparedQuestionCapture
  )
  const confirmQuestionAsked = useInterviewStore(
    (state) => state.confirmPreparedQuestionAsked
  )
  const cancelCapture = useInterviewStore(
    (state) => state.cancelPreparedQuestionCapture
  )
  const dismissResult = useInterviewStore(
    (state) => state.dismissMeetingQAResult
  )
  const toggleSelection = useInterviewStore(
    (state) => state.toggleMeetingNoteSelection
  )

  if (qaInvitation) {
    return (
      <section className="space-y-2 border-b border-bg-hover p-3" aria-label="预置提问">
        <div className="rounded-lg border border-accent/30 bg-accent/10 p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[11px] font-medium text-accent-glow">
                检测到 QA 环节
              </div>
              <p className="mt-1 text-[10px] leading-4 text-slate-400">
                “{qaInvitation}”
              </p>
            </div>
            <button
              type="button"
              onClick={dismissPreparedQuestions}
              className="rounded px-2 py-1 text-[10px] text-slate-500 hover:bg-bg-hover hover:text-white"
            >
              暂不提问
            </button>
          </div>
        </div>

        <div className="space-y-1.5">
          {preparedQuestions.map((question, index) => (
            <button
              type="button"
              key={question.id}
              onClick={() => startCapture(question.id)}
              className="flex w-full items-start gap-2 rounded-lg border border-bg-hover bg-bg-card px-3 py-2.5 text-left text-xs text-slate-200 transition hover:border-accent/50 hover:bg-bg-hover"
            >
              <span className="mt-0.5 shrink-0 text-[10px] text-accent-glow">
                {index + 1}
              </span>
              <span className="leading-5">{question.question}</span>
            </button>
          ))}
        </div>
        <p className="px-1 text-[9px] leading-4 text-slate-600">
          点选后 App 会等待你的麦克风提问，并把后续系统音频持续记录为发言者回答；由你手动结束。
        </p>
      </section>
    )
  }

  if (active) {
    return (
      <section className="space-y-2 border-b border-bg-hover p-3" aria-label="记录 QA 回答">
        <article className="rounded-lg border border-warn/30 bg-bg-card p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[10px] font-medium text-warn">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warn" />
              正在记录发言者回答
            </div>
            <span className="text-[9px] text-slate-600">
              {active.heardOwnQuestion ? '已听到我的提问' : '等待我的提问'}
            </span>
          </div>
          <div className="mt-2 text-xs font-medium leading-5 text-slate-100">
            {active.question}
          </div>
          <div className="mt-3 min-h-14 rounded-md bg-bg px-3 py-2 text-xs leading-5 text-slate-300">
            {active.answer || '等待系统音频中的发言者回答…'}
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={cancelCapture}
              className="rounded px-3 py-1.5 text-[11px] text-slate-500 hover:bg-danger/10 hover:text-danger"
            >
              取消记录
            </button>
            {!active.heardOwnQuestion ? (
              <button
                type="button"
                onClick={confirmQuestionAsked}
                className="rounded bg-warn/15 px-3 py-1.5 text-[11px] text-warn hover:bg-warn/25"
              >
                我已提问，开始记录
              </button>
            ) : null}
            <button
              type="button"
              onClick={finishCapture}
              disabled={!active.answer.trim()}
              className="rounded bg-accent px-3 py-1.5 text-[11px] font-medium text-white hover:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-35"
            >
              完成回答
            </button>
          </div>
        </article>
      </section>
    )
  }

  const visible = meetingQAs.find((item) => item.id === visibleMeetingQAId)
  if (!visible) return null
  const sourceId = meetingQANoteSourceId(visible.id)
  const selected = selectedIds.includes(sourceId)

  return (
    <section className="border-b border-bg-hover p-3" aria-label="会议 QA 记录">
      <article className="rounded-lg border border-ok/25 bg-bg-card p-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[10px] font-medium text-ok">QA 回答已记录</span>
          <button
            type="button"
            onClick={dismissResult}
            className="rounded px-2 py-1 text-[10px] text-slate-500 hover:bg-bg-hover hover:text-white"
          >
            收起
          </button>
        </div>
        <div className="mt-2 text-xs font-medium leading-5 text-slate-100">
          Q：{visible.question}
        </div>
        <div className="mt-2 whitespace-pre-wrap text-xs leading-5 text-slate-300">
          A：{visible.answer}
        </div>
        <button
          type="button"
          onClick={() => toggleSelection(sourceId)}
          className={`mt-3 rounded px-3 py-1.5 text-[11px] transition ${
            selected
              ? 'bg-ok/15 text-ok hover:bg-ok/20'
              : 'bg-accent/15 text-accent-glow hover:bg-accent/25'
          }`}
        >
          {selected ? '✓ 已加入会议笔记' : '＋ 加入会议笔记'}
        </button>
      </article>
    </section>
  )
}
