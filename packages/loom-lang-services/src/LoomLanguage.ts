import { create } from 'volar-service-typescript'
import { Effect } from 'effect'
import { defineLanguageService, TypescriptSdk } from './LanguageService'

export const LoomLanguage = defineLanguageService({
  id: 'loom',
  displayName: 'Loom',
  extensions: [],
  plugins: () =>
    Effect.gen(function* () {
      const ts = yield* TypescriptSdk
      return create(ts)
    }),
})
