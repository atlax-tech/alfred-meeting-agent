import { app, type BrowserWindow } from 'electron'
import { join } from 'path'

interface LiquidGlassAddon {
  applyLiquidGlass: (nativeWindowHandle: Buffer) => boolean
}

function getAddonPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'native', 'liquid-glass.node')
    : join(app.getAppPath(), 'build', 'native', 'liquid-glass.node')
}

/**
 * Uses AppKit's native NSGlassEffectView on macOS 26 and later.
 * Returns false when the platform or native bridge cannot provide Liquid Glass.
 */
export function applyNativeLiquidGlass(window: BrowserWindow): boolean {
  if (process.platform !== 'darwin') return false

  try {
    const addon = require(getAddonPath()) as LiquidGlassAddon
    return addon.applyLiquidGlass(window.getNativeWindowHandle())
  } catch (error) {
    console.warn('[liquid-glass] Native material unavailable:', error)
    return false
  }
}
