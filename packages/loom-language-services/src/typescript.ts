import { create } from 'volar-service-typescript'
import { Effect } from 'effect'
import { defineLanguageService, TypeScriptSdk } from './LanguageService'

export const typescript = defineLanguageService({
  id: 'typescript',
  displayName: 'TypeScript',
  extensions: ['.ts', '.tsx'],
  plugins: () =>
    Effect.gen(function* () {
      const ts = yield* TypeScriptSdk
      return create(ts)
    }),
})
