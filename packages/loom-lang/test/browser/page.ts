import { Effect, Option } from 'effect'
import type { LoomModule } from '@athrio/loom-ast/LoomCorpusAst'
import { LoomCorpusAstBuilder } from '../../src/browser'

export const moduleOfText = (path: string, text: string): Promise<LoomModule> =>
  Effect.runPromise(
    LoomCorpusAstBuilder.pipe(
      Effect.flatMap((builder) =>
        builder.build({ read: () => Effect.succeed(text), list: Option.none() }, path),
      ),
      Effect.provide(LoomCorpusAstBuilder.layer),
    ),
  )
