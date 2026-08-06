/**
 * 窗口显示偏好统一入口(隐私保护 & 专注模式)
 */

import { BrowserWindow } from 'electron'
import type { StealthState } from '@shared/types'
import { setHideFromCapture } from './screen-share'
import { setHideTaskbar } from './taskbar'
import { setAntiSwitchDetect, setWindowOpacity } from './anti-switch'

export { setHideFromCapture, setHideTaskbar, setAntiSwitchDetect, setWindowOpacity }

/** 一次性应用全部窗口偏好设置 */
export function applyStealth(win: BrowserWindow, state: StealthState): void {
  setHideTaskbar(win, state.hideTaskbar)
  setWindowOpacity(win, state.opacity)
  setHideFromCapture(win, state.hideFromCapture)
  setAntiSwitchDetect(win, {
    alwaysOnTop: state.alwaysOnTop,
    noFocus: state.antiSwitchDetect,
    clickThrough: false // 默认不透传,保证 UI 可操作
  })
}
