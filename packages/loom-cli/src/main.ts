import { Console, Effect } from 'effect'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { resolve as resolvePath } from 'node:path'
import { DocumentSource } from '@athrio/loom-lang/LoomCompiler'
import { LoomTangler } from '@athrio/loom-lang/LoomTangler'
import { PackageConfig } from '@athrio/loom-lang/PackageConfig'

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
    Effect.catchTag('TangleError', (e) =>
      Console.error(e.message).pipe(
        Effect.zipRight(Effect.sync(() => void (process.exitCode = 1))),
      ),
    ),
    Effect.provide(LoomTangler.Default),
    Effect.provide(DocumentSource.Default),
    Effect.provide(PackageConfig.Default),
    Effect.provide(NodeContext.layer),
  )

const main = Effect.gen(function* () {
  const args = process.argv.slice(2)
  const target = args[0] === 'tangle' ? args[1] : args[0]
  if (target) {
    yield* tangle(target)
  } else {
    yield* Console.error(
      'usage: loom [tangle] <file.loom | dir>\n       loom lsp --stdio',
    )
  }
})

if (process.argv[2] === 'lsp') {
  const { createRequire } = await import('node:module')
  ;(globalThis as { require?: unknown }).require = createRequire(import.meta.url)
  const { startLanguageServer } = await import('@athrio/loom-lang/LoomServer')
  startLanguageServer()
} else {
  NodeRuntime.runMain(main)
}
