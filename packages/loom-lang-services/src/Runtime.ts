export const runtimeKey = '__loomRuntime'

export const runtimeVersion = '2'

export const runtimeSpecifiers: ReadonlyArray<string> = [
  'effect',
  '@athrio/loom-lang-services/LanguageService',
]

import * as EffectNS from 'effect'
import * as LanguageServiceNS from './LanguageService'

interface HostRuntime {
  readonly version: string
  readonly modules: Record<string, unknown>
}

export const installHostRuntime = (): void => {
  ;(globalThis as Record<string, unknown>)[runtimeKey] = {
    version: runtimeVersion,
    modules: {
      effect: EffectNS,
      '@athrio/loom-lang-services/LanguageService': LanguageServiceNS,
    },
  } satisfies HostRuntime
}
