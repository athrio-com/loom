import { create } from 'volar-service-typescript'
import { Effect } from 'effect'
import { defineLanguageService, TypescriptSdk } from './LanguageService'

export const TypescriptLanguage = defineLanguageService({
  id: 'typescript',
  displayName: 'TypeScript',
  extensions: ['.ts', '.tsx'],
  plugins: () =>
    Effect.gen(function* () {
      const ts = yield* TypescriptSdk
      return create(ts)
    }),
})
