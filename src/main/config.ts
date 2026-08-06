/**
 * 应用配置持久化
 * 简单 JSON 文件读写,放在 userData 目录下
 */

import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { DEFAULT_CONFIG, type AppConfig } from '@shared/types'

const CONFIG_FILENAME = 'config.json'

function getConfigPath(): string {
  return join(app.getPath('userData'), CONFIG_FILENAME)
}

export function loadConfig(): AppConfig {
  const path = getConfigPath()
  try {
    if (!existsSync(path)) {
      return structuredClone(DEFAULT_CONFIG)
    }
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<AppConfig>
    // 深度合并默认值,保证字段完整性
    return mergeConfig(DEFAULT_CONFIG, parsed)
  } catch (err) {
    console.error('[config] 加载失败,使用默认配置:', err)
    return structuredClone(DEFAULT_CONFIG)
  }
}

export function saveConfig(config: AppConfig): void {
  const path = getConfigPath()
  try {
    const dir = join(path, '..')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(path, JSON.stringify(config, null, 2), 'utf-8')
  } catch (err) {
    console.error('[config] 保存失败:', err)
  }
}

function mergeConfig(base: AppConfig, override: Partial<AppConfig>): AppConfig {
  return {
    llm: { ...base.llm, ...(override.llm ?? {}) },
    stt: { ...base.stt, ...(override.stt ?? {}) },
    interview: { ...base.interview, ...(override.interview ?? {}) },
    mentor: { ...base.mentor, ...(override.mentor ?? {}) },
    display: { ...base.display, ...(override.display ?? {}) },
    stealth: { ...base.stealth, ...(override.stealth ?? {}) }
  }
}
