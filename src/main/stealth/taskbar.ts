/**
 * 任务栏/Dock 显示偏好
 *  - Dock 图标隐藏: setSkipTaskbar(true)
 *  - Alt+Tab 切换器隐藏(macOS 不适用)
 */

import { BrowserWindow } from 'electron'

export function setHideTaskbar(win: BrowserWindow, enable: boolean): void {
  // 从任务栏隐藏
  win.setSkipTaskbar(enable)

  if (process.platform === 'win32') {
    // Windows:进一步从 Alt+Tab 切换器中隐藏
    // 通过设置窗口的 owner 为不可见窗口,或者使用 WS_EX_TOOLWINDOW
    // Electron 没有直接 API,可通过 setAppUserModelId 间接影响
    // 这里保留接口,真正实现需 native addon
  }
}
