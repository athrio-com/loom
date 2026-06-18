import { NodeRuntime } from '@effect/platform-node'
import { Effect } from 'effect'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { LoomCorpusAstBuilder, type Source } from '#ast/LoomCorpusAstBuilder'
import { fromFrame } from '#ast/LoomVirtualCodeBuilder'

// =============================================================================
// build-ast — dev probe. Reads a `.loom` file and runs the de dicto pipeline —
// LoomCorpusAstBuilder (read → parse → FrameAstBuilder) → fromFrame
// (LoomVirtualCodeBuilder, FrameModule → the frame virtual code) — then prints
// the generated TypeScript frame.
//
//   pnpm tsx scripts/build-ast.ts [path/to/file.loom]
//
// Defaults to `experimental.loom`.
// =============================================================================

const defaultPath = resolve(__dirname, './experimental.loom')
const path = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : defaultPath
const text = readFileSync(path, 'utf8')

const source: Source = { read: () => Effect.succeed(text) }

const program = Effect.gen(function* () {
  const builder = yield* LoomCorpusAstBuilder
  const { frame } = yield* builder.build(source, '')
  const { code: genCode } = fromFrame(frame)

  process.stdout.write(genCode + '\n')
}).pipe(Effect.provide(LoomCorpusAstBuilder.Default))

NodeRuntime.runMain(program)
