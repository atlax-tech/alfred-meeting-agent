/**
 * Electron 主进程入口
 */

import { app, BrowserWindow, session } from 'electron'
import { join } from 'path'
// electron-audio-loopback: 在 macOS 上捕获系统音频的正确方案
// 它通过 setDisplayMediaRequestHandler + CoreAudio Tap API 实现
// forceCoreAudioTap: true 绕过某些 macOS 版本的 bug
import { initMain as initAudioLoopback } from 'electron-audio-loopback'
import { createMainWindow, setMainWindowQuitting } from './window'
import { registerIpcHandlers } from './ipc-handlers'
import { loadConfig } from './config'
import { registerMentorShortcut, unregisterMentorShortcut } from './mentor'
import { createTray, destroyTray, showMainWindow } from './tray'
import { runRepositoryKnowledgeSelfTest } from './repository-knowledge/self-test'

// Preserve the existing profile directory across the product rename so the
// user's config, personalization, localStorage, and session data remain intact.
app.setPath('userData', join(app.getPath('appData'), 'inview-do'))

// 初始化音频 loopback(必须在 app ready 之前调用)
initAudioLoopback({
  forceCoreAudioTap: true,
  // 未签名/重新打包的 macOS 构建可能无法生成屏幕缩略图，即使系统录音
  // 权限已经开启。loopback 只需要 sourceId，不需要缩略图。
  sourcesOptions: {
    types: ['screen'],
    thumbnailSize: { width: 0, height: 0 }
  }
})

// Chromium 命令行级代理:Web Speech API 走 Chromium 内部网络通道,
// 不走 Electron session.setProxy,必须在 app.whenReady 之前设置才生效
// 默认 Clash Verge HTTP 端口 7899,可通过 APP_PROXY 环境变量覆盖
const proxyURL = process.env.APP_PROXY || 'http://127.0.0.1:7899'
app.commandLine.appendSwitch('proxy-server', proxyURL)
app.commandLine.appendSwitch('proxy-bypass-list', '<local>')

// 单实例锁
const repositorySelfTest = process.env.ALFRED_REPOSITORY_SELF_TEST === '1'
const gotLock = repositorySelfTest || app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const wins = BrowserWindow.getAllWindows()
    if (wins.length > 0) {
      const win = wins[0]
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    if (repositorySelfTest) {
      try {
        const result = await runRepositoryKnowledgeSelfTest()
        console.log(`ALFRED_REPOSITORY_SELF_TEST_PASS ${JSON.stringify(result)}`)
        app.exit(0)
      } catch (error) {
        console.error('ALFRED_REPOSITORY_SELF_TEST_FAIL', error)
        app.exit(1)
      }
      return
    }

    // 设置应用用户模型 ID(Windows 任务栏分组)
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.atlax.inview-practice')
    }

    // 走本地 HTTP 代理:Web Speech API 底层访问 Google 服务器,国内需代理
    // 默认 Clash/Clash Verge HTTP 端口 7899,可通过环境变量 APP_PROXY 覆盖,如 http://127.0.0.1:7899
    const proxyURL = process.env.APP_PROXY || 'http://127.0.0.1:7899'
    await session.defaultSession.setProxy({ proxyRules: proxyURL })

    registerIpcHandlers()

    const config = loadConfig()
    createMainWindow({ stealth: config.stealth })
    createTray()
    registerMentorShortcut()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length > 0) {
        showMainWindow()
      } else {
        const cfg = loadConfig()
        createMainWindow({ stealth: cfg.stealth })
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('before-quit', () => {
    setMainWindowQuitting(true)
  })

  app.on('will-quit', () => {
    destroyTray()
    unregisterMentorShortcut()
  })
}
