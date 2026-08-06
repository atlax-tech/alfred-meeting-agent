/**
 * 系统托盘管理
 */

import { app, Menu, nativeImage, Tray } from 'electron'
import { getMainWindow } from './window'

const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAO0lEQVR4nGNITvvIQAnGJfEfBybKAFyasRpCqmYMQ8jRjGIIuZrhhowaQEUDKI5GqiQkqiRlqmQmkjAAJC1Vgw5bffsAAAAASUVORK5CYII='

let tray: Tray | null = null

export function showMainWindow(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return

  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

export function createTray(): Tray {
  if (tray) return tray

  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL)
  tray = new Tray(icon)
  tray.setToolTip(app.getName())
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示窗口',
        click: showMainWindow
      },
      {
        label: '退出',
        click: () => app.quit()
      }
    ])
  )
  tray.on('click', showMainWindow)

  return tray
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
