import { NodeRuntime } from '@effect/platform-node'
import { Effect } from 'effect'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Loom } from '#ast/Loom'
import { FrameAstBuilder } from '#ast/FrameAstBuilder'
import { fromFrame } from '#ast/LoomVirtualCodeBuilder'

// =============================================================================
// build-ast — dev probe. Reads a `.loom` file and runs the de dicto pipeline —
// parse (`Loom.ast`) → `FrameAstBuilder` (LoomDocument → FrameModule) →
// fromFrame (`LoomVirtualCodeBuilder`, FrameModule → the frame virtual code) —
// then prints the generated TypeScript frame.
//
//   pnpm tsx scripts/build-ast.ts [path/to/file.loom]
//
// Defaults to `experimental.loom`. Note: the frame pass is at its simple stage —
// every section renders as a static service, so effectful bodies, anchors,
// tangle sinks, and {Loom} blocks are not yet resolved.
// =============================================================================

const defaultPath = resolve(__dirname, './experimental.loom')
const path = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : defaultPath
const text = readFileSync(path, 'utf8')

const program = Effect.gen(function* () {
  const loom = yield* Loom
  const builder = yield* FrameAstBuilder

  const document = yield* loom.ast(text)
  const frame = yield* builder.build(document)
  const { code: genCode } = fromFrame(frame)

  process.stdout.write(genCode + '\n')
}).pipe(
  Effect.provide(Loom.Default),
  Effect.provide(FrameAstBuilder.Default),
)

NodeRuntime.runMain(program)
