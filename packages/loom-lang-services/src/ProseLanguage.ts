import { Effect } from 'effect'
import { defineLanguageService } from './LanguageService'

export const ProseLanguage = defineLanguageService({
  id: 'prose',
  displayName: 'Prose',
  extensions: [],
  plugins: () =>
    Effect.tryPromise(() => import('volar-service-markdown')).pipe(
      Effect.map((markdown) => [
        markdown.create({ documentSelector: ['prose'] }),
      ]),
      Effect.orElseSucceed(() => []),
    ),
})
