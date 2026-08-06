/**
 * 渲染进程全局类型补充
 */

import type { InviewAPI } from '@shared/preload-api'

declare global {
  interface Window {
    inview: InviewAPI
  }
}

export {}
