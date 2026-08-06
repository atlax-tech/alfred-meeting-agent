/**
 * 屏幕共享隐私保护 —— 让本窗口在屏幕共享/录屏时不被捕获
 *
 * 用途: 练习时如需分享屏幕给导师/朋友review,可开启此选项保护工具窗口内容隐私。
 *
 * 实现原理:
 *  - Windows: 调用 SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)
 *    从 Windows 10 2004 起支持,窗口对屏幕共享/截屏/录屏不可见。
 *  - macOS:  调用 NSWindow.sharingType = NSWindowSharingNone
 *    窗口不会被系统级屏幕录制捕获。Electron 31+ 提供 setContentProtection(true)。
 *  - Linux:  不支持。
 *
 * 使用 Electron 31+ 内置 API `win.setContentProtection(enable)`。
 */

import { BrowserWindow } from 'electron'

/**
 * 设置窗口在屏幕共享/录屏中的隐私保护
 * 优先使用 Electron 内置 setContentProtection,失败时降级
 */
export function setHideFromCapture(win: BrowserWindow, enable: boolean): boolean {
  try {
    // Electron 31+ 提供的原生 API,内部对应:
    //   Windows: SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)
    //   macOS:   NSWindowSharingNone
    //   Linux:   不支持
    ;(win as unknown as { setContentProtection: (enable: boolean) => void }).setContentProtection(enable)
    return true
  } catch (err) {
    console.warn('[stealth] setContentProtection 不可用,降级为透明度方案:', err)
    // 降级:不真正隐藏,只能依赖透明度 + 任务栏隐藏组合
    return false
  }
}

/**
 * 进程级隐藏(更深度):在任务管理器进程名中不暴露应用名
 * —— 仅做接口预留,真正实现需要重打包 electron 二进制,这里不实现
 */
export function setProcessNameHidden(): boolean {
  // TODO: 真实生产环境需要修改 Electron 二进制的 Info.plist / 资源文件
  // 学习研究版不做
  return false
}
