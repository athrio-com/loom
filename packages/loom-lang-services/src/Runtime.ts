export const runtimeKey = '__loomRuntime'

export const runtimeVersion = '1'

export const runtimeSpecifiers: ReadonlyArray<string> = [
  'effect',
  '@athrio/loom-lang-services/LanguageService',
  'typescript',
]

import * as EffectNS from 'effect'
import * as LanguageServiceNS from './LanguageService'

interface HostRuntime {
  readonly version: string
  readonly modules: Record<string, unknown>
}

export const installHostRuntime = (
  tsdk: typeof import('typescript'),
): void => {
  ;(globalThis as Record<string, unknown>)[runtimeKey] = {
    version: runtimeVersion,
    modules: {
      effect: EffectNS,
      '@athrio/loom-lang-services/LanguageService': LanguageServiceNS,
      typescript: tsdk,
    },
  } satisfies HostRuntime
}
