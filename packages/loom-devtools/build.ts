import { Effect, FileSystem } from 'effect'
import { BunRuntime, BunServices } from '@effect/platform-bun'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const src = join(root, 'src')
const dist = join(root, 'dist')

const scopeToShadow = (css: string): string => css.replaceAll(':root', ':host')

const forStringLiteral = (css: string): string =>
  css
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('"', '\\"')
    .replaceAll('\r', '')
    .replaceAll('\n', '\\n')

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(dist, { recursive: true })

  const stylesheet = join(dist, 'overlay.css')
  yield* Effect.tryPromise(() =>
    Bun.spawn(['bunx', '@tailwindcss/cli', '-i', join(src, 'overlay.css'), '-o', stylesheet, '--minify'], {
      stdout: 'inherit',
      stderr: 'inherit',
    }).exited,
  )
  const css = scopeToShadow(yield* fs.readFileString(stylesheet))

  const built = yield* Effect.tryPromise(() =>
    Bun.build({ entrypoints: [join(src, 'overlay.ts')], target: 'browser', minify: true }),
  )
  const bundle = yield* Effect.promise(() => built.outputs[0].text())

  yield* fs.writeFileString(
    join(dist, 'overlay.js'),
    bundle.replaceAll('__LOOM_NOTES_CSS__', forStringLiteral(css)),
  )

  const uiBuilt = yield* Effect.tryPromise(() =>
    Bun.build({ entrypoints: [join(src, 'ui.ts')], target: 'browser', minify: true }),
  )
  const uiBundle = yield* Effect.promise(() => uiBuilt.outputs[0].text())
  yield* fs.writeFileString(join(dist, 'ui.js'), uiBundle)

  yield* Effect.log('built dist/overlay.js and dist/ui.js')
}).pipe(Effect.provide(BunServices.layer))

BunRuntime.runMain(program)
