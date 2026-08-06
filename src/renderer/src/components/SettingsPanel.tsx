/**
 * 设置面板
 *  - LLM API 接入入口(用户自定义模型)
 *  - 语音识别(STT)配置
 *  - 练习参数(岗位/语言/模式/简历/知识库)
 *  - 窗口显示偏好(实时生效)
 */

import { useEffect, useState } from 'react'
import { useInterviewStore } from '../store/interview'
import type { AppConfig, AnswerMode, Region, StealthState } from '@shared/types'
import { PersonalizationSettings } from './PersonalizationSettings'

const MODE_OPTIONS: { value: AnswerMode; label: string; desc: string }[] = [
  { value: 'normal', label: '普通', desc: '默认设置,结构清晰' },
  { value: 'concise', label: '精简', desc: '只保留必要信息,适合快速口述' },
  { value: 'algorithm', label: '算法题', desc: '思路 + 代码 + 复杂度' },
  { value: 'system-design', label: '系统设计', desc: '架构 + 模块 + 扩展性' },
  { value: 'detailed', label: '详细', desc: '全面覆盖各维度' }
]

export function SettingsPanel() {
  const open = useInterviewStore((s) => s.settingsOpen)
  const config = useInterviewStore((s) => s.config)
  const saveConfig = useInterviewStore((s) => s.saveConfig)
  const updateStealth = useInterviewStore((s) => s.updateStealth)
  const setSettingsOpen = useInterviewStore((s) => s.setSettingsOpen)

  // 本地草稿,关闭时丢弃,保存时提交
  const [draft, setDraft] = useState<AppConfig>(config)
  const [savedTip, setSavedTip] = useState(false)

  useEffect(() => {
    if (open) setDraft(config)
  }, [open, config])

  if (!open) return null

  const patch = (p: Partial<AppConfig>) => setDraft((d) => ({ ...d, ...p }))

  const patchLLM = (p: Partial<AppConfig['llm']>) =>
    setDraft((d) => ({ ...d, llm: { ...d.llm, ...p } }))

  const patchSTT = (p: Partial<AppConfig['stt']>) =>
    setDraft((d) => ({ ...d, stt: { ...d.stt, ...p } }))

  const patchInterview = (p: Partial<AppConfig['interview']>) =>
    setDraft((d) => ({ ...d, interview: { ...d.interview, ...p } }))

  const patchDisplay = (p: Partial<AppConfig['display']>) =>
    setDraft((d) => ({ ...d, display: { ...d.display, ...p } }))

  /** 显示偏好变更立即生效(不等保存) */
  const patchStealthImmediate = async (p: Partial<StealthState>) => {
    const next = { ...draft.stealth, ...p }
    setDraft((d) => ({ ...d, stealth: next }))
    await updateStealth(p)
  }

  const handleSave = async () => {
    await saveConfig(draft)
    setSavedTip(true)
    setTimeout(() => setSavedTip(false), 1500)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/15 backdrop-blur-sm">
      <div className="bg-bg-panel w-[92%] max-w-2xl max-h-[88vh] rounded-lg border border-bg-card flex flex-col">
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-bg-card">
          <h2 className="text-sm font-semibold">设置</h2>
          <button
            onClick={() => setSettingsOpen(false)}
            className="text-slate-400 hover:text-white text-lg leading-none"
          >
            ×
          </button>
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* LLM 配置 —— 用户接入自己模型的入口 */}
          <Section
            title="LLM 模型接入(OpenAI 兼容)"
            desc="默认配置为 DeepSeek v4-flash。也可接入 OpenAI / 智谱 / 通义 / Ollama / vLLM 等"
          >
            <Field label="Base URL">
              <input
                type="text"
                value={draft.llm.baseURL}
                onChange={(e) => patchLLM({ baseURL: e.target.value })}
                placeholder="https://api.deepseek.com"
                className={inputCls}
              />
            </Field>
            <Field label="API Key">
              <input
                type="password"
                value={draft.llm.apiKey}
                onChange={(e) => patchLLM({ apiKey: e.target.value })}
                placeholder="sk-..."
                className={inputCls}
              />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="模型名">
                <input
                  type="text"
                  value={draft.llm.model}
                  onChange={(e) => patchLLM({ model: e.target.value })}
                  placeholder="deepseek-v4-flash"
                  className={inputCls}
                />
              </Field>
              <Field label="温度(非思考模式生效)">
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="2"
                  value={draft.llm.temperature}
                  onChange={(e) => patchLLM({ temperature: Number(e.target.value) })}
                  className={inputCls}
                />
              </Field>
              <Field label="Max Tokens">
                <input
                  type="number"
                  min="256"
                  value={draft.llm.maxTokens}
                  onChange={(e) => patchLLM({ maxTokens: Number(e.target.value) })}
                  className={inputCls}
                />
              </Field>
            </div>

            <Toggle
              label="DeepSeek 1M 长上下文"
              desc="开启后尽量携带完整历史问答、现场对话、简历和知识库。仅在当前模型确实支持大上下文时开启，输入成本和响应时间会增加。"
              checked={draft.llm.millionContextEnabled}
              onChange={(v) => patchLLM({ millionContextEnabled: v })}
            />

            {/* 思考模式(DeepSeek v4 系列) */}
            <div className="bg-bg-card rounded p-3 space-y-2.5">
              <div className="text-xs text-accent-glow font-medium">
                思考模式(DeepSeek v4 系列专属,其他模型会忽略)
              </div>
              <Toggle
                label="开启思考模式"
                desc="开启后模型先输出思维链再给答案,准确度更高但更慢。实时练习场景建议关闭,算法题/系统设计可临时开启"
                checked={draft.llm.thinking === 'enabled'}
                onChange={(v) => patchLLM({ thinking: v ? 'enabled' : 'disabled' })}
              />
              {draft.llm.thinking === 'enabled' && (
                <Field label="思考强度">
                  <div className="grid grid-cols-2 gap-2">
                    {(['high', 'max'] as const).map((effort) => (
                      <button
                        key={effort}
                        onClick={() => patchLLM({ reasoningEffort: effort })}
                        className={`px-2 py-1.5 rounded text-xs transition ${
                          draft.llm.reasoningEffort === effort
                            ? 'bg-accent text-white'
                            : 'bg-bg-card text-slate-300 hover:bg-bg-hover'
                        }`}
                      >
                        {effort === 'high' ? 'high(推荐,平衡)' : 'max(最准但最慢)'}
                      </button>
                    ))}
                  </div>
                </Field>
              )}
              {draft.llm.thinking === 'enabled' && (
                <div className="text-xs text-warn">
                  注意:思考模式下 temperature 不生效;思维链会在答案上方折叠展示
                </div>
              )}
            </div>

            <div className="text-xs text-slate-500 mt-1">
              DeepSeek v4-flash 推荐:Base URL 填 <code className="text-accent">https://api.deepseek.com</code>,
              模型 <code className="text-accent">deepseek-v4-flash</code>。
              其他模型:OpenAI <code className="text-accent">gpt-4o-mini</code>、
              本地 Ollama <code className="text-accent">http://localhost:11434/v1</code>。
            </div>
            <div className="rounded border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs leading-5 text-amber-100/80">
              为优先保证正确率，Mentor 和问答答案生成后会自动追加一次独立复核，并显示置信度。
              这会增加一次模型调用和少量等待时间；证据不足时会明确提示，而不是猜测。
            </div>
          </Section>

          {/* 语音识别配置 */}
          <Section
            title="语音识别 (STT)"
            desc="推荐 Whisper API(走 fetch + 代理,国内稳定)。Web Speech API 底层走 Google 服务器,国内不稳定"
          >
            <Field label="Provider">
              <select
                value={draft.stt.provider}
                onChange={(e) => patchSTT({ provider: e.target.value as AppConfig['stt']['provider'] })}
                className={inputCls}
              >
                <option value="whisper-api">Whisper API(推荐,国内稳定)</option>
                <option value="web">浏览器 Web Speech API(国内需代理且可能不稳)</option>
                <option value="custom">自定义(同 Whisper 接口格式)</option>
              </select>
            </Field>
            <Field label="识别语言">
              <select
                value={draft.stt.autoDetectLanguage ? 'auto' : draft.stt.language}
                onChange={(e) => {
                  const language = e.target.value
                  patchSTT({
                    language,
                    autoDetectLanguage: language === 'auto'
                  })
                }}
                className={inputCls}
              >
                <option value="auto">自动检测（推荐，支持中英输入）</option>
                <option value="zh-CN">中文 (zh-CN)</option>
                <option value="en-US">英文 (en-US)</option>
              </select>
              <div className="mt-1 text-xs text-slate-500">
                自动检测由 Whisper API 支持；输入语言不会改变顶部选择的回答语言。
              </div>
            </Field>

            <Field label="回答触发速度">
              <select
                value={draft.stt.endOfSpeechDelayMs}
                onChange={(e) => patchSTT({ endOfSpeechDelayMs: Number(e.target.value) })}
                className={inputCls}
              >
                <option value={1800}>快速（停顿 1.8 秒）</option>
                <option value={2500}>标准（停顿 2.5 秒，推荐）</option>
                <option value={3500}>稳妥（停顿 3.5 秒）</option>
              </select>
              <div className="mt-1 text-xs text-slate-500">
                如果对方讲话停顿较多，选择“稳妥”可避免问题还没问完就开始回答。
              </div>
            </Field>

            <div className="bg-bg-card rounded p-3 space-y-2.5">
              <div className="text-xs text-accent-glow font-medium">音源选择</div>
              <Field label="麦克风">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draft.stt.micEnabled}
                    onChange={(e) => patchSTT({ micEnabled: e.target.checked })}
                    className="accent-accent"
                  />
                  <span className="text-xs text-slate-300">采集自己的声音(练习/自言自语时开启)</span>
                </label>
              </Field>
              <Field label="系统声音">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draft.stt.systemEnabled}
                    onChange={(e) => patchSTT({ systemEnabled: e.target.checked })}
                    className="accent-warn"
                  />
                  <span className="text-xs text-slate-300">采集对方声音(腾讯会议/飞书/钉钉等输出)</span>
                </label>
              </Field>
              <VolumeControl
                label="麦克风音量"
                value={draft.stt.micVolume}
                disabled={!draft.stt.micEnabled}
                onChange={(value) => patchSTT({ micVolume: value })}
              />
              <VolumeControl
                label="系统声音音量"
                value={draft.stt.systemVolume}
                disabled={!draft.stt.systemEnabled}
                accent="warn"
                onChange={(value) => patchSTT({ systemVolume: value })}
              />
              <div className="text-xs text-slate-500">
                macOS 用户:首次采集系统声音需要授权"屏幕录制"权限;若仍失败,建议安装
                <a className="text-accent underline" href="https://github.com/ExistentialAudio/BlackHole" target="_blank" rel="noreferrer">BlackHole</a>
                虚拟音频设备,将会议软件输出路由到 BlackHole 后选择它为系统音源。
              </div>
            </div>

            {draft.stt.provider !== 'web' && (
              <div className="bg-bg-card rounded p-3 space-y-2.5">
                <div className="text-xs text-accent-glow font-medium">Whisper API 接入</div>
                <Field label="Base URL">
                  <input
                    type="text"
                    value={draft.stt.baseURL ?? ''}
                    onChange={(e) => patchSTT({ baseURL: e.target.value })}
                    placeholder="https://api.groq.com/openai/v1"
                    className={inputCls}
                  />
                </Field>
                <Field label="API Key">
                  <input
                    type="password"
                    value={draft.stt.apiKey ?? ''}
                    onChange={(e) => patchSTT({ apiKey: e.target.value })}
                    placeholder="gsk_..."
                    className={inputCls}
                  />
                </Field>
                <Field label="模型名">
                  <input
                    type="text"
                    value={draft.stt.model ?? ''}
                    onChange={(e) => patchSTT({ model: e.target.value })}
                    placeholder="whisper-large-v3"
                    className={inputCls}
                  />
                </Field>
                <div className="text-xs text-slate-500">
                  推荐 Groq 免费 whisper-large-v3:在 <a className="text-accent underline" href="https://console.groq.com/keys" target="_blank" rel="noreferrer">console.groq.com/keys</a> 申请 Key,
                  填 <code className="text-accent">https://api.groq.com/openai/v1</code> + <code className="text-accent">whisper-large-v3</code>。
                  也支持 OpenAI <code className="text-accent">whisper-1</code>、本地 whisper.cpp <code className="text-accent">http://localhost:8080/v1</code>。
                </div>
              </div>
            )}
          </Section>

          {/* 练习参数 */}
          <Section title="练习参数">
            <div className="grid grid-cols-2 gap-3">
              <Field label="目标岗位">
                <input
                  type="text"
                  value={draft.interview.position}
                  onChange={(e) => patchInterview({ position: e.target.value })}
                  className={inputCls}
                />
              </Field>
              <Field label="答案语言">
                <select
                  value={draft.interview.region}
                  onChange={(e) => patchInterview({ region: e.target.value as Region })}
                  className={inputCls}
                >
                  <option value="zh">中文（仅中文）</option>
                  <option value="en">English (English only)</option>
                  <option value="mixed">混合（跟随输入语言）</option>
                </select>
              </Field>
            </div>
            <Toggle
              label="混合模式双语翻译"
              desc="仅混合模式生效：检测到非中文问题时，在原语言回答下方额外生成可展开/折叠的中文翻译"
              checked={draft.interview.bilingualTranslationEnabled}
              onChange={(v) => patchInterview({ bilingualTranslationEnabled: v })}
            />
            <Field label="回答模式">
              <div className="grid grid-cols-5 gap-2">
                {MODE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => patchInterview({ mode: opt.value })}
                    title={opt.desc}
                    className={`px-2 py-2 rounded text-xs transition ${
                      draft.interview.mode === opt.value
                        ? 'bg-accent text-white'
                        : 'bg-bg-card text-slate-300 hover:bg-bg-hover'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="简历(可选,粘贴文本或上传 PDF)">
              <textarea
                value={draft.interview.resume ?? ''}
                onChange={(e) => patchInterview({ resume: e.target.value })}
                rows={3}
                placeholder="粘贴简历文本或点击下方按钮上传 PDF,AI 会结合个人经历作答"
                className={`${inputCls} resize-y`}
              />
              <input
                type="file"
                accept=".pdf,.txt"
                onChange={async (e) => {
                  const file = e.target.files?.[0]
                  if (!file) return
                  try {
                    const arrayBuffer = await file.arrayBuffer()
                    const text = await window.inview.parseResume(arrayBuffer, file.name)
                    patchInterview({ resume: text })
                  } catch (err) {
                    alert(`简历解析失败: ${(err as Error).message}`)
                  }
                  e.target.value = ''
                }}
                id="resume-upload"
                className="hidden"
              />
              <button
                onClick={() => document.getElementById('resume-upload')?.click()}
                className="mt-2 px-3 py-1.5 rounded text-xs bg-bg-card text-slate-300 hover:bg-bg-hover transition"
              >
                上传 PDF / TXT 文件
              </button>
            </Field>
            <Field label="自定义问答库(可选)">
              <textarea
                value={draft.interview.knowledgeBase ?? ''}
                onChange={(e) => patchInterview({ knowledgeBase: e.target.value })}
                rows={3}
                placeholder="粘贴专属问答/AI 会优先引用相关内容"
                className={`${inputCls} resize-y`}
              />
            </Field>
          </Section>

          <div className="rounded-lg border border-bg-card p-4">
            <PersonalizationSettings />
          </div>

          {/* 主问答区显示 */}
          <Section title="字体大小" desc="分别调整主界面的问题和回答字号，保存后立即生效">
            <div className="rounded bg-bg-card p-3 space-y-4">
              <FontSizeControl
                label="识别到的问题"
                value={draft.display.questionFontSize}
                min={12}
                max={24}
                onChange={(value) => patchDisplay({ questionFontSize: value })}
              />
              <FontSizeControl
                label="AI 回答"
                value={draft.display.answerFontSize}
                min={14}
                max={30}
                onChange={(value) => patchDisplay({ answerFontSize: value })}
              />
              <div className="rounded-md border border-bg-hover bg-bg px-3 py-2.5">
                <div
                  className="font-medium text-slate-300"
                  style={{ fontSize: `${draft.display.questionFontSize}px`, lineHeight: 1.65 }}
                >
                  问题预览：请介绍一下你自己
                </div>
                <div
                  className="mt-2 text-slate-100"
                  style={{ fontSize: `${draft.display.answerFontSize}px`, lineHeight: 1.75 }}
                >
                  回答预览：我会结合岗位要求，重点介绍相关经验与成果。
                </div>
              </div>
            </div>
          </Section>

          {/* 显示偏好 —— 实时生效 */}
          <Section title="显示偏好" desc="以下开关实时生效,无需保存">
            <Toggle
              label="屏幕共享隐私保护"
              desc="开启后本窗口不会出现在屏幕共享/录屏中(Electron setContentProtection)"
              checked={draft.stealth.hideFromCapture}
              onChange={(v) => patchStealthImmediate({ hideFromCapture: v })}
            />
            <Toggle
              label="隐藏 Dock 图标"
              desc="不在系统 Dock 栏/任务栏显示窗口图标"
              checked={draft.stealth.hideTaskbar}
              onChange={(v) => patchStealthImmediate({ hideTaskbar: v })}
            />
            <Toggle
              label="专注模式(不抢焦点)"
              desc="窗口置顶但不会成为活动窗口,练习时避免意外打断主窗口"
              checked={draft.stealth.antiSwitchDetect}
              onChange={(v) => patchStealthImmediate({ antiSwitchDetect: v })}
            />
            <Toggle
              label="窗口置顶"
              desc="始终浮于其他窗口之上"
              checked={draft.stealth.alwaysOnTop}
              onChange={(v) => patchStealthImmediate({ alwaysOnTop: v })}
            />
            <Field label={`窗口透明度 (${Math.round(draft.stealth.opacity * 100)}%)`}>
              <input
                type="range"
                min="0.1"
                max="1"
                step="0.05"
                value={draft.stealth.opacity}
                onChange={(e) => patchStealthImmediate({ opacity: Number(e.target.value) })}
                className="w-full"
              />
            </Field>
          </Section>
        </div>

        {/* 底部操作 */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-bg-card">
          <button
            onClick={() => void window.inview.quitApp()}
            className="px-4 py-1.5 rounded bg-red-600 hover:bg-red-500 text-white text-sm"
          >
            关闭 App
          </button>
          <div className="flex items-center gap-2">
            {savedTip && <span className="text-xs text-ok">已保存</span>}
            <button
              onClick={() => setSettingsOpen(false)}
              className="px-4 py-1.5 rounded bg-bg-card hover:bg-bg-hover text-slate-200 text-sm"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-1.5 rounded bg-accent hover:bg-accent/90 text-white text-sm font-medium"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ============== 通用小组件 ==============

const inputCls =
  'w-full bg-bg-card rounded px-2.5 py-1.5 text-sm text-slate-100 border border-transparent focus:border-accent focus:outline-none'

function Section({
  title,
  desc,
  children
}: {
  title: string
  desc?: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-2.5">
      <div>
        <h3 className="text-sm font-medium text-slate-100">{title}</h3>
        {desc && <p className="text-xs text-slate-500 mt-0.5">{desc}</p>}
      </div>
      {children}
    </section>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-slate-400">{label}</span>
      {children}
    </label>
  )
}

function Toggle({
  label,
  desc,
  checked,
  onChange
}: {
  label: string
  desc?: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer py-1">
      <button
        type="button"
        onClick={() => onChange(!checked)}
        aria-pressed={checked}
        aria-label={label}
        className={`mt-0.5 w-9 h-5 rounded-full transition shrink-0 ${
          checked ? 'bg-accent' : 'bg-bg-card'
        }`}
      >
        <span
          className={`block w-4 h-4 rounded-full bg-white transition transform ${
            checked ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </button>
      <span className="flex-1">
        <span className="block text-sm text-slate-200">{label}</span>
        {desc && <span className="block text-xs text-slate-500 mt-0.5">{desc}</span>}
      </span>
    </label>
  )
}

function FontSizeControl({
  label,
  value,
  min,
  max,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center justify-between text-xs text-slate-300">
        <span>{label}</span>
        <span className="min-w-12 text-right tabular-nums text-accent-glow">{value}px</span>
      </span>
      <span className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onChange(Math.max(min, value - 1))}
          disabled={value <= min}
          aria-label={`减小${label}字号`}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-bg-card text-base text-slate-300 hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          −
        </button>
        <input
          type="range"
          min={min}
          max={max}
          step="1"
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="w-full accent-accent"
        />
        <button
          type="button"
          onClick={() => onChange(Math.min(max, value + 1))}
          disabled={value >= max}
          aria-label={`增大${label}字号`}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-bg-card text-base text-slate-300 hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          +
        </button>
      </span>
    </label>
  )
}

function VolumeControl({
  label,
  value,
  onChange,
  disabled = false,
  accent = 'accent'
}: {
  label: string
  value: number
  onChange: (value: number) => void
  disabled?: boolean
  accent?: 'accent' | 'warn'
}) {
  return (
    <label className={`block ${disabled ? 'opacity-40' : ''}`}>
      <span className="mb-1.5 flex items-center justify-between text-xs text-slate-400">
        <span>{label}</span>
        <span className="tabular-nums text-slate-500">{Math.round(value * 100)}%</span>
      </span>
      <input
        type="range"
        min="0"
        max="1"
        step="0.05"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className={`w-full disabled:cursor-not-allowed ${
          accent === 'accent' ? 'accent-accent' : 'accent-warn'
        }`}
      />
    </label>
  )
}
