/**
 * 专注模式(窗口焦点管理)
 *
 * 背景: 在线练习时,如果辅助工具窗口意外抢走主窗口焦点,会打断练习流程。
 * 本模块确保工具窗口始终可见但不会成为活动窗口。
 *
 * 实现策略:
 *  1. 窗口置顶(alwaysOnTop = 'screen-saver'),始终可见但不阻挡系统级交互
 *  2. 不抢焦点(setFocusable(false)),点击工具窗口不会让练习平台失焦
 *  3. 鼠标事件可穿透(可选,setIgnoreMouseEvents),适合纯展示场景
 *  4. Dock 图标隐藏(可选),保持桌面整洁
 *
 * 注意: noFocus=true 会导致本窗口内文本输入框无法输入,
 * 因此设置面板等需要交互的场景必须临时关闭 noFocus。
 */

import { BrowserWindow } from 'electron'

export interface AntiSwitchOptions {
  /** 窗口置顶 */
  alwaysOnTop: boolean
  /** 不抢焦点(关键)—— 注意:启用后本窗口 input 无法输入 */
  noFocus: boolean
  /** 鼠标事件穿透(可选,启用后无法点击 UI,需要靠快捷键操作) */
  clickThrough: boolean
}

export function setAntiSwitchDetect(win: BrowserWindow, opts: AntiSwitchOptions): void {
  // 1. screen-saver 置顶级别,窗口始终可见但不影响系统交互
  if (opts.alwaysOnTop) {
    win.setAlwaysOnTop(true, 'screen-saver')
  } else {
    win.setAlwaysOnTop(false)
  }

  // 2. 不抢焦点 —— 专注模式的关键,点击工具窗口不会让练习平台失焦
  //    注意: 启用后本窗口 input 无法聚焦,需要输入时必须临时关闭
  win.setFocusable(!opts.noFocus)

  // 3. 鼠标穿透
  win.setIgnoreMouseEvents(opts.clickThrough, { forward: true })
}

/**
 * 临时恢复可聚焦状态(用于设置面板等需要输入的场景)
 * 返回之前的 noFocus 状态,以便场景结束后恢复
 */
export function temporarilyEnableFocus(win: BrowserWindow): boolean {
  const wasFocusable = win.isFocusable()
  win.setFocusable(true)
  // macOS 上还需要主动 focus 才能让 input 获取焦点
  if (process.platform === 'darwin') {
    win.focus()
  }
  return !wasFocusable
}

/**
 * 调整窗口透明度
 * 可用于降低视觉干扰,配合 setContentProtection 可在屏幕共享时保护隐私
 */
export function setWindowOpacity(win: BrowserWindow, opacity: number): void {
  const value = Math.max(0.1, Math.min(1, opacity))
  win.setOpacity(value)
}
