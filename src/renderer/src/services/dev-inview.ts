import type { InviewAPI } from '@shared/preload-api'
import {
  createEmptyPersonalizationProfile,
  DEFAULT_CONFIG
} from '@shared/types'

const subscribeNoop = () => () => {}

/**
 * Vite's browser-only preview has no Electron preload. This development shim
 * keeps visual QA possible without entering the packaged application path.
 * The production bundle removes the guarded call site entirely.
 */
export function installDevInviewBridge(): void {
  if (window.inview) return

  const implemented = {
    platform: 'darwin',
    getConfig: async () => DEFAULT_CONFIG,
    getPersonalization: async () => createEmptyPersonalizationProfile(),
    getPersonalizationEvidence: async () => [],
    getPersonalizationVersions: async () => [],
    getSystemAudioSources: async () => [],
    getSystemAudioPermission: async () => 'granted'
  }

  window.inview = new Proxy(implemented, {
    get(target, property) {
      if (property in target) {
        return target[property as keyof typeof target]
      }
      if (typeof property === 'string' && property.startsWith('on')) {
        return subscribeNoop
      }
      return async () => true
    }
  }) as unknown as InviewAPI
}
