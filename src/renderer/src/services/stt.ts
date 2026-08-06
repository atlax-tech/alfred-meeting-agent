/**
 * 语音识别服务(STT)
 *
 * 支持双音源独立采集:
 *  - mic    :麦克风,采集自己的声音
 *  - system :系统声音,采集腾讯会议/飞书/钉钉等对方的声音(macOS 需屏幕录制权限)
 *
 * 实现策略:
 *  - Web Speech API 不靠谱(国内代理难以生效) -> 默认用 Whisper API
 *  - AudioWorklet 实时采集 16kHz mono PCM,转 WAV 上传
 *  - 两路音频各自独立 STT,不混合,结果都送入 question-detector
 *  - AnalyserNode 实时计算音量条
 */

import type { STTConfig, AudioSourceType } from '@shared/types'

export interface STTCallbacks {
  /** 中间结果 */
  onPartial?: (text: string) => void
  /** 最终结果 */
  onFinal?: (text: string) => void
  /** 错误 */
  onError?: (err: Error) => void
  /** 状态变更 */
  onStatus?: (status: 'listening' | 'stopped' | 'error') => void
  /** 音量变化 0~1 */
  onVolume?: (source: AudioSourceType, volume: number) => void
}

export interface STTEngine {
  start(): Promise<void>
  stop(): void
  isListening(): boolean
}

// ============== Web Speech API 实现(备选) ==============

interface SpeechRecognitionEventLike {
  resultIndex: number
  results: ArrayLike<{
    isFinal: boolean
    0: { transcript: string }
  }>
}

interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  onstart: (() => void) | null
}

function getSpeechRecognitionCtor(): { new (): SpeechRecognitionLike } | null {
  const w = window as unknown as {
    SpeechRecognition?: { new (): SpeechRecognitionLike }
    webkitSpeechRecognition?: { new (): SpeechRecognitionLike }
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

class WebSpeechEngine implements STTEngine {
  private recognition: SpeechRecognitionLike | null = null
  private listening = false
  private config: STTConfig
  private cb: STTCallbacks
  private shouldRestart = false

  constructor(config: STTConfig, cb: STTCallbacks) {
    this.config = config
    this.cb = cb
  }

  async start(): Promise<void> {
    const Ctor = getSpeechRecognitionCtor()
    if (!Ctor) {
      throw new Error('当前浏览器不支持 Web Speech API')
    }
    if (this.listening) return

    const recognition = new Ctor()
    // Web Speech API 不支持可靠的自动语言检测;auto 时使用系统首选语言。
    // 推荐使用 Whisper API,其 auto 模式会真正省略 language 参数并自动检测。
    recognition.lang =
      this.config.autoDetectLanguage || this.config.language === 'auto'
        ? navigator.language
        : this.config.language
    recognition.continuous = true
    recognition.interimResults = true
    recognition.maxAlternatives = 1

    recognition.onstart = () => {
      this.listening = true
      this.cb.onStatus?.('listening')
    }

    recognition.onresult = (event) => {
      let finalText = ''
      let interimText = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) {
          finalText += result[0].transcript
        } else {
          interimText += result[0].transcript
        }
      }
      if (interimText) this.cb.onPartial?.(interimText.trim())
      if (finalText) this.cb.onFinal?.(finalText.trim())
    }

    recognition.onerror = (e) => {
      this.cb.onError?.(new Error(`STT 错误: ${e.error}`))
      if (e.error === 'not-allowed') this.shouldRestart = false
    }

    recognition.onend = () => {
      this.listening = false
      this.cb.onStatus?.('stopped')
      if (this.shouldRestart) {
        try {
          recognition.start()
        } catch {
          // ignore
        }
      }
    }

    this.recognition = recognition
    this.shouldRestart = true
    recognition.start()
  }

  stop(): void {
    this.shouldRestart = false
    this.listening = false
    this.recognition?.stop()
    this.recognition = null
  }

  isListening(): boolean {
    return this.listening
  }
}

// ============== 音频工具 ==============

/**
 * PCM 采集 worklet 代码(字符串形式,运行时注册)
 */
const PCM_WORKLET_CODE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffers = []
    this.port.onmessage = (e) => {
      if (e.data.type === 'flush') {
        const total = this.buffers.reduce((s, b) => s + b.length, 0)
        const merged = new Float32Array(total)
        let offset = 0
        for (const b of this.buffers) {
          merged.set(b, offset)
          offset += b.length
        }
        this.buffers = []
        this.port.postMessage({ type: 'chunk', data: merged }, [merged.buffer])
      }
    }
  }

  process(inputs) {
    const input = inputs[0]
    if (input && input[0]) {
      const copy = new Float32Array(input[0])
      this.buffers.push(copy)
    }
    return true
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor)
`

async function ensureWorkletRegistered(audioContext: AudioContext): Promise<void> {
  // 不能缓存:stop 时 AudioContext 会被 close,新建的 context 必须重新加载 module
  const blob = new Blob([PCM_WORKLET_CODE], { type: 'application/javascript' })
  const url = URL.createObjectURL(blob)
  try {
    await audioContext.audioWorklet.addModule(url)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * 计算 AnalyserNode 的平均音量(0~1)
 */
function getVolume(analyser: AnalyserNode): number {
  const data = new Uint8Array(analyser.frequencyBinCount)
  analyser.getByteFrequencyData(data)
  if (data.length === 0) return 0
  let sum = 0
  for (let i = 0; i < data.length; i++) sum += data[i]
  const avg = sum / data.length / 255
  return Math.min(1, avg * 3) // 放大一点,视觉上更明显
}

/** PCM 均方根音量，用于判断当前是否仍在说话。 */
export function calculateRms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sumSquares = 0
  for (let i = 0; i < samples.length; i++) sumSquares += samples[i] * samples[i]
  return Math.sqrt(sumSquares / samples.length)
}

/** 只有确实听到过语音且静音达到阈值后，才结束当前语音段。 */
export function shouldEndSpeechSegment(
  hasSpeech: boolean,
  lastSpeechAt: number,
  now: number,
  silenceDelayMs: number
): boolean {
  return hasSpeech && lastSpeechAt > 0 && now - lastSpeechAt >= silenceDelayMs
}

/** 将 Float32 PCM 转成 WAV Blob */
function pcmToWav(pcm: Float32Array, sampleRate: number): Blob {
  const numChannels = 1
  const numFrames = pcm.length
  const bytesPerSample = 2
  const blockAlign = numChannels * bytesPerSample
  const dataSize = numFrames * blockAlign
  const bufferSize = 44 + dataSize
  const buffer = new ArrayBuffer(bufferSize)
  const view = new DataView(buffer)

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i))
    }
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let i = 0; i < numFrames; i++) {
    const sample = Math.max(-1, Math.min(1, pcm[i]))
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
    offset += 2
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

// ============== Whisper API 单路采集器 ==============

interface WhisperSingleEngineOptions {
  /** 音源类型 */
  sourceType: AudioSourceType
  /** 系统音频源 ID(仅 system 类型需要,由主进程 desktopCapturer 获取) */
  systemSourceId?: string
  /** 音量 0~1 */
  volume: number
}

class WhisperSingleEngine implements STTEngine {
  private config: STTConfig
  private opts: WhisperSingleEngineOptions
  private cb: STTCallbacks
  private listening = false
  private audioContext: AudioContext | null = null
  private stream: MediaStream | null = null
  private processor: ScriptProcessorNode | null = null
  private analyser: AnalyserNode | null = null
  private gainNode: GainNode | null = null
  private volumeInterval: ReturnType<typeof setInterval> | null = null
  private pending = 0
  private readonly maxConcurrent = 2
  /** 约 0.8% 满幅音量；配合系统/麦克风自带降噪，能过滤大部分底噪。 */
  private readonly speechRmsThreshold = 0.008
  /** 防止极端情况下单个请求过大；正常情况始终按真实停顿切分。 */
  private readonly maxSegmentMs = 90_000
  private hasSpeech = false
  private lastSpeechAt = 0
  private segmentStartedAt = 0
  private bufferedSamples = 0
  /** PCM 缓冲区,由 ScriptProcessorNode 的 onaudioprocess 填充 */
  private pcmBuffers: Float32Array[] = []

  constructor(config: STTConfig, opts: WhisperSingleEngineOptions, cb: STTCallbacks) {
    this.config = config
    this.opts = opts
    this.cb = cb
  }

  async start(): Promise<void> {
    if (this.listening) return

    // 1. 获取音频流
    if (this.opts.sourceType === 'system') {
      // macOS 系统音频采集方案(参考 electron-audio-loopback 官方示例 mic-speaker-streamer):
      // 1. 先调用 enableLoopbackAudio() 让主进程设置 setDisplayMediaRequestHandler
      // 2. 调用 getDisplayMedia({ video: true, audio: true }) 获取系统音频
      // 3. 立即调用 disableLoopbackAudio() 恢复正常行为
      // 4. 移除视频轨,只保留音频轨
      try {
        await window.inview.enableLoopbackAudio()
      } catch (err) {
        throw new Error(`启用系统音频 loopback 失败: ${(err as Error).message}`)
      }

      let displayStream: MediaStream
      try {
        displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true
        })
      } catch (err) {
        const e = err as Error
        console.error('[STT system] getDisplayMedia failed:', e.name, e.message)
        throw new Error(`getDisplayMedia 失败: ${e.name} - ${e.message}`)
      } finally {
        // 无论成功失败都立即禁用 loopback,恢复正常行为
        try {
          await window.inview.disableLoopbackAudio()
        } catch {
          // ignore
        }
      }

      const audioTracks = displayStream.getAudioTracks()
      if (audioTracks.length === 0) {
        displayStream.getTracks().forEach((t) => t.stop())
        throw new Error('所选屏幕源没有音频轨,请选择"整个屏幕"并勾选"共享音频"')
      }
      // 只保留音频轨,丢弃视频轨
      displayStream.getVideoTracks().forEach((t) => {
        t.stop()
        displayStream.removeTrack(t)
      })
      this.stream = displayStream
    } else {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
    }

    // 2. 创建 AudioContext
    const audioContext = new AudioContext({ sampleRate: 16000 })
    this.audioContext = audioContext

    // 3. 构建音频图: source -> gain(音量) -> analyser -> processor -> destination
    const source = audioContext.createMediaStreamSource(this.stream)

    const gainNode = audioContext.createGain()
    gainNode.gain.value = this.opts.volume
    this.gainNode = gainNode

    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.7
    this.analyser = analyser

    // 用 ScriptProcessorNode 采集 PCM(比 AudioWorklet 更可靠,无 MessagePort 通信问题)
    const processor = audioContext.createScriptProcessor(4096, 1, 1)
    this.processor = processor
    this.resetSegment()
    processor.onaudioprocess = (e: AudioProcessingEvent) => {
      const input = e.inputBuffer.getChannelData(0)
      // 复制一份存入缓冲区(inputBuffer 的内存会被复用,必须 copy)
      const copy = new Float32Array(input)
      const now = Date.now()
      const isSpeech = calculateRms(copy) >= this.speechRmsThreshold

      if (!this.hasSpeech) {
        // 尚未开始说话时只保留少量前置音频，避免把长时间静音上传给 Whisper。
        this.pcmBuffers.push(copy)
        this.bufferedSamples += copy.length
        const preRollSamples = Math.round(audioContext.sampleRate * 0.75)
        while (this.bufferedSamples > preRollSamples && this.pcmBuffers.length > 1) {
          this.bufferedSamples -= this.pcmBuffers.shift()!.length
        }
        if (isSpeech) {
          this.hasSpeech = true
          this.segmentStartedAt = now
          this.lastSpeechAt = now
        }
        return
      }

      this.pcmBuffers.push(copy)
      this.bufferedSamples += copy.length
      if (isSpeech) this.lastSpeechAt = now
    }

    source.connect(gainNode)
    gainNode.connect(analyser)
    analyser.connect(processor)
    // ScriptProcessorNode 必须连接到 destination 才能触发 onaudioprocess
    processor.connect(audioContext.destination)

    // 4. 音量监控
    this.volumeInterval = setInterval(() => {
      if (this.analyser) this.cb.onVolume?.(this.opts.sourceType, getVolume(this.analyser))

      const now = Date.now()
      const silenceDelayMs = Math.max(1200, this.config.endOfSpeechDelayMs || 2500)
      if (
        shouldEndSpeechSegment(this.hasSpeech, this.lastSpeechAt, now, silenceDelayMs) ||
        (this.hasSpeech && now - this.segmentStartedAt >= this.maxSegmentMs)
      ) {
        this.flushChunk()
      }
    }, 100)

    this.listening = true
    this.cb.onStatus?.('listening')
    console.log(
      `[STT ${this.opts.sourceType}] engine started, endOfSpeechDelay=${this.config.endOfSpeechDelayMs || 2500}ms`
    )
  }

  setVolume(volume: number): void {
    this.opts.volume = volume
    if (this.audioContext && this.gainNode) {
      this.gainNode.gain.setTargetAtTime(
        volume,
        this.audioContext.currentTime,
        0.015
      )
    }
  }

  private flushChunk(): void {
    if (!this.audioContext) return
    if (this.pending >= this.maxConcurrent) return
    if (!this.hasSpeech) return

    // 取出缓冲区数据
    const buffers = this.pcmBuffers
    this.resetSegment()
    if (buffers.length === 0) {
      console.log(`[STT ${this.opts.sourceType}] flushChunk: no PCM data`)
      return
    }

    // 合并所有 PCM 片段
    const totalLength = buffers.reduce((s, b) => s + b.length, 0)
    const pcm = new Float32Array(totalLength)
    let offset = 0
    for (const b of buffers) {
      pcm.set(b, offset)
      offset += b.length
    }

    console.log(`[STT ${this.opts.sourceType}] flushChunk: pcm.length=${pcm.length}, buffers=${buffers.length}`)
    if (pcm.length === 0) return

    this.pending++
    this.processChunk(pcm)
      .catch((err) => {
        console.error(`[STT ${this.opts.sourceType}] 识别失败:`, err)
        if (this.listening) {
          this.cb.onError?.(new Error(`${this.opts.sourceType} 识别失败: ${(err as Error).message}`))
        }
      })
      .finally(() => {
        this.pending--
      })
  }

  private resetSegment(): void {
    this.pcmBuffers = []
    this.bufferedSamples = 0
    this.hasSpeech = false
    this.lastSpeechAt = 0
    this.segmentStartedAt = 0
  }

  private async processChunk(pcm: Float32Array): Promise<void> {
    const wavBlob = pcmToWav(pcm, 16000)
    console.log(`[STT ${this.opts.sourceType}] processChunk: wavSize=${wavBlob.size}, sending to Whisper...`)
    const text = await this.recognizeBlob(wavBlob)
    console.log(`[STT ${this.opts.sourceType}] Whisper result: "${text}"`)
    if (text && this.listening) {
      this.cb.onFinal?.(`[${this.opts.sourceType}] ${text}`)
    }
  }

  private async recognizeBlob(blob: Blob): Promise<string> {
    const url = `${this.config.baseURL!.replace(/\/$/, '')}/audio/transcriptions`
    const form = new FormData()
    form.append('file', blob, `${this.opts.sourceType}-chunk.wav`)
    form.append('model', this.config.model || 'whisper-large-v3')
    const configuredLanguage = this.config.language || 'auto'
    const lang =
      this.config.autoDetectLanguage || configuredLanguage === 'auto'
        ? null
        : configuredLanguage.split('-')[0]
    // Whisper 在不传 language 时会自动检测语音语言,可处理中英文或语言切换。
    if (lang) form.append('language', lang)
    form.append('response_format', 'json')
    if (lang === 'zh') {
      form.append('prompt', '以下是对话的转写文本。')
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
      body: form
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    const data = (await res.json()) as { text?: string }
    return (data.text || '').trim()
  }

  stop(): void {
    this.listening = false
    if (this.volumeInterval) {
      clearInterval(this.volumeInterval)
      this.volumeInterval = null
    }
    if (this.processor) {
      try {
        this.processor.disconnect()
      } catch {
        // ignore
      }
      this.processor = null
    }
    if (this.gainNode) {
      try {
        this.gainNode.disconnect()
      } catch {
        // ignore
      }
      this.gainNode = null
    }
    this.resetSegment()
    if (this.audioContext) {
      this.audioContext.close()
      this.audioContext = null
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop())
      this.stream = null
    }
    this.cb.onStatus?.('stopped')
  }

  isListening(): boolean {
    return this.listening
  }
}

// ============== 双音源管理器 ==============

export interface AudioEngineState {
  micListening: boolean
  systemListening: boolean
  micVolume: number
  systemVolume: number
  systemPermission: 'granted' | 'denied' | 'not-determined' | 'unknown'
}

export class WhisperDualEngine implements STTEngine {
  private config: STTConfig
  private micEngine: WhisperSingleEngine | null = null
  private systemEngine: WhisperSingleEngine | null = null
  private systemSourceId?: string
  private state: AudioEngineState
  private cb: STTCallbacks

  constructor(config: STTConfig, cb: STTCallbacks) {
    this.config = config
    this.cb = cb
    this.state = {
      micListening: false,
      systemListening: false,
      micVolume: config.micVolume ?? 1,
      systemVolume: config.systemVolume ?? 1,
      systemPermission: 'unknown'
    }
  }

  async start(): Promise<void> {
    // 检查系统音频权限和源
    await this.refreshSystemSource()

    const errors: string[] = []

    if (this.config.micEnabled) {
      this.micEngine = new WhisperSingleEngine(
        this.config,
        { sourceType: 'mic', volume: this.state.micVolume },
        this.cb
      )
      try {
        await this.micEngine.start()
        this.state.micListening = true
      } catch (err) {
        errors.push(`麦克风: ${(err as Error).message}`)
      }
    }

    if (this.config.systemEnabled) {
      this.systemEngine = new WhisperSingleEngine(
        this.config,
        { sourceType: 'system', systemSourceId: this.systemSourceId, volume: this.state.systemVolume },
        this.cb
      )
      try {
        await this.systemEngine.start()
        this.state.systemListening = true
      } catch (err) {
        errors.push(`系统声音: ${(err as Error).message}`)
      }
    }

    if (!this.state.micListening && !this.state.systemListening) {
      throw new Error(errors.join('; ') || '至少需要一个音源开启')
    }

    if (errors.length > 0) {
      console.warn('[STT] 部分音源启动失败:', errors)
    }
  }

  async refreshSystemSource(): Promise<void> {
    if (!this.config.systemEnabled) return
    // loopback 方式不需要预先获取 sourceId
    // 只检查权限状态,给出友好提示
    try {
      const permission = await window.inview.getSystemAudioPermission()
      this.state.systemPermission = permission as AudioEngineState['systemPermission']

      if (permission === 'denied') {
        // 未签名或重新打包的开发构建中，Electron 可能在系统设置已授权时仍返回
        // denied。不要在这里提前中止，让真正的 getDisplayMedia 调用给出权威结果。
        console.warn(
          '[STT] 系统报告录屏权限为 denied，继续尝试系统音频采集以确认实际状态'
        )
      }
    } catch (err) {
      console.error('[STT] 获取系统音频权限失败:', err)
      throw err
    }
  }

  setVolume(source: AudioSourceType, volume: number): void {
    if (source === 'mic') {
      this.state.micVolume = volume
      this.micEngine?.setVolume(volume)
    } else {
      this.state.systemVolume = volume
      this.systemEngine?.setVolume(volume)
    }
  }

  stop(): void {
    this.micEngine?.stop()
    this.systemEngine?.stop()
    this.micEngine = null
    this.systemEngine = null
    this.state.micListening = false
    this.state.systemListening = false
  }

  isListening(): boolean {
    return this.state.micListening || this.state.systemListening
  }

  getState(): AudioEngineState {
    return { ...this.state }
  }
}

// ============== 工厂入口 ==============

export function createSTTEngine(config: STTConfig, cb: STTCallbacks): STTEngine {
  switch (config.provider) {
    case 'web':
      return new WebSpeechEngine(config, cb)
    case 'whisper-api':
    case 'custom':
      return new WhisperDualEngine(config, cb)
    default:
      return new WhisperDualEngine(config, cb)
  }
}
