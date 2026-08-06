import { useMemo, useState } from 'react'
import { useInterviewStore } from '../store/interview'

function formatTime(timestamp: number): string {
  if (!timestamp) return '尚未生成'
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

export function PersonalizationSettings() {
  const profile = useInterviewStore((state) => state.personalization)
  const versions = useInterviewStore((state) => state.personalizationVersions)
  const status = useInterviewStore((state) => state.personalizationStatus)
  const progress = useInterviewStore((state) => state.personalizationProgress)
  const error = useInterviewStore((state) => state.personalizationError)
  const updateSettings = useInterviewStore(
    (state) => state.updatePersonalizationSettings
  )
  const distill = useInterviewStore((state) => state.distillPersonalization)
  const rollback = useInterviewStore((state) => state.rollbackPersonalization)
  const [selectedVersion, setSelectedVersion] = useState('')
  const busy = status === 'reading' || status === 'distilling' || status === 'saving'
  const olderVersions = versions.filter(
    (version) => version.profileVersion < profile.profileVersion
  )
  const ruleTitles = useMemo(
    () => [
      ...profile.cognitiveRules.map((rule) => `思考 · ${rule.title}`),
      ...profile.expressionRules.map((rule) => `表达 · ${rule.title}`),
      ...profile.spokenRules.map((rule) => `说话 · ${rule.title}`)
    ],
    [profile]
  )

  const selectKnowledgeBase = async () => {
    const path = await window.inview.selectKnowledgeBaseFolder()
    if (path) await updateSettings({ knowledgeBasePath: path })
  }

  return (
    <section className="space-y-3">
      <div>
        <div className="text-sm font-medium text-slate-200">个人认知—表达系统</div>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          一套跨语言、按情境触发的 Personal Cognitive Voice。知识库只学习抽象的思考与写作规律；
          说话规律通过问答反馈持续蒸馏，不生成固定回答模板。
        </p>
      </div>

      <div className="rounded border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] leading-5 text-amber-100/80">
        隐私边界：只扫描“工作与项目 / 学习与成长 / 灵感与创作”；永久排除原始素材、生活与自我、
        日记与情绪和归档。画像不得保存个人事实；对外经历只使用上方简历。
      </div>

      <label className="flex items-start justify-between gap-3 rounded bg-bg-card p-3">
        <span>
          <span className="block text-xs text-slate-200">启用个人画像</span>
          <span className="mt-1 block text-[10px] leading-4 text-slate-500">
            关闭后保留本地画像和证据，但回答时不调用。
          </span>
        </span>
        <input
          type="checkbox"
          checked={profile.enabled}
          onChange={(event) =>
            void updateSettings({ enabled: event.target.checked })
          }
          className="mt-0.5 accent-accent"
        />
      </label>

      <div className="rounded bg-bg-card p-3">
        <div className="mb-1 text-xs text-slate-300">知识库目录</div>
        <div className="flex gap-2">
          <input
            type="text"
            value={profile.knowledgeBasePath}
            readOnly
            placeholder="选择 Obsidian 知识库目录"
            className="min-w-0 flex-1 rounded border border-transparent bg-bg px-2.5 py-1.5 text-xs text-slate-300 outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={() => void selectKnowledgeBase()}
            className="shrink-0 rounded bg-bg-hover px-3 py-1.5 text-xs text-slate-300 hover:text-white"
          >
            选择目录
          </button>
        </div>
      </div>

      <div className="rounded bg-bg-card p-3">
        <label className="flex items-start justify-between gap-3">
          <span>
            <span className="block text-xs text-slate-200">反馈自动增量蒸馏</span>
            <span className="mt-1 block text-[10px] leading-4 text-slate-500">
              新反馈立即进入下一次回答；累积到阈值后后台合并为新画像版本。
            </span>
          </span>
          <input
            type="checkbox"
            checked={profile.autoDistillFeedback}
            onChange={(event) =>
              void updateSettings({ autoDistillFeedback: event.target.checked })
            }
            className="mt-0.5 accent-accent"
          />
        </label>
        <label className="mt-3 flex items-center gap-2 text-[10px] text-slate-500">
          每累积
          <input
            type="number"
            min={1}
            max={20}
            value={profile.feedbackDistillThreshold}
            onChange={(event) =>
              void updateSettings({
                feedbackDistillThreshold: Math.max(
                  1,
                  Math.min(20, Number(event.target.value) || 3)
                )
              })
            }
            className="w-14 rounded border border-bg-hover bg-bg px-2 py-1 text-center text-xs text-slate-300 outline-none"
          />
          条新反馈更新一次
        </label>
      </div>

      <div className="grid grid-cols-4 gap-2 text-center text-[10px]">
        <div className="rounded bg-bg-card p-2">
          <div className="text-sm text-slate-200">v{profile.profileVersion}</div>
          <div className="text-slate-600">画像版本</div>
        </div>
        <div className="rounded bg-bg-card p-2">
          <div className="text-sm text-slate-200">
            {profile.cognitiveRules.length + profile.expressionRules.length}
          </div>
          <div className="text-slate-600">思考/表达规律</div>
        </div>
        <div className="rounded bg-bg-card p-2">
          <div className="text-sm text-slate-200">{profile.spokenRules.length}</div>
          <div className="text-slate-600">说话规律</div>
        </div>
        <div className="rounded bg-bg-card p-2">
          <div className="text-sm text-accent-glow">
            {profile.sourceStats.pendingFeedbackRecords}
          </div>
          <div className="text-slate-600">待蒸馏反馈</div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || !profile.knowledgeBasePath}
          onClick={() => void distill(true, false)}
          className="rounded bg-accent px-3 py-1.5 text-xs text-white hover:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {profile.status === 'empty' ? '生成初始画像' : '重新读取知识库并更新'}
        </button>
        <button
          type="button"
          disabled={busy || profile.sourceStats.pendingFeedbackRecords === 0}
          onClick={() => void distill(false, false)}
          className="rounded bg-bg-hover px-3 py-1.5 text-xs text-slate-300 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          立即吸收新反馈
        </button>
      </div>

      {progress ? (
        <div className="text-[11px] leading-5 text-accent-glow">{progress}</div>
      ) : null}
      {error ? (
        <div className="rounded border border-danger/20 bg-danger/5 px-3 py-2 text-[11px] leading-5 text-danger">
          {error}
        </div>
      ) : null}

      {ruleTitles.length > 0 ? (
        <div className="rounded border border-bg-hover bg-bg/40 p-3">
          <div className="mb-2 flex justify-between text-[10px] text-slate-500">
            <span>当前画像摘要</span>
            <span>{formatTime(profile.updatedAt)}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {ruleTitles.slice(0, 12).map((title) => (
              <span
                key={title}
                className="rounded bg-bg-card px-2 py-1 text-[10px] text-slate-400"
              >
                {title}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {olderVersions.length > 0 ? (
        <div className="flex items-center gap-2">
          <select
            value={selectedVersion}
            onChange={(event) => setSelectedVersion(event.target.value)}
            className="min-w-0 flex-1 rounded border border-bg-hover bg-bg px-2.5 py-1.5 text-xs text-slate-400 outline-none"
          >
            <option value="">选择历史版本</option>
            {olderVersions.map((version) => (
              <option key={version.profileVersion} value={version.profileVersion}>
                v{version.profileVersion} · {formatTime(version.updatedAt)}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!selectedVersion || busy}
            onClick={() => {
              if (!selectedVersion) return
              void rollback(Number(selectedVersion))
              setSelectedVersion('')
            }}
            className="rounded bg-bg-hover px-3 py-1.5 text-xs text-slate-300 hover:text-white disabled:opacity-40"
          >
            回滚
          </button>
        </div>
      ) : null}
    </section>
  )
}
