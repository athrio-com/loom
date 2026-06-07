import { Console, Effect } from 'effect'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { resolve as resolvePath } from 'node:path'
import { DocumentSource } from '@loom/language-server/LoomCompiler'
import { LoomTangler } from '@loom/language-server/LoomTangler'

const tangle = (file: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const entry = resolvePath(process.cwd(), file)
    const tangler = yield* LoomTangler
    const written = yield* tangler.tangle(entry)
    if (written.length === 0) {
      yield* Console.log('loom: no {path} sinks to tangle')
    } else {
      yield* Effect.forEach(written, (f) =>
        Console.log(`loom: tangled ${f.section} → ${f.path}`),
      )
    }
  }).pipe(
    Effect.provide(LoomTangler.Default),
    Effect.provide(DocumentSource.Default),
    Effect.provide(NodeContext.layer),
  )

const main = Effect.gen(function* () {
  const [command, file] = process.argv.slice(2)
  if (command === 'tangle' && file) {
    yield* tangle(file)
  } else {
    yield* Console.error('usage: loom tangle <file.loom>')
  }
})

NodeRuntime.runMain(main)
