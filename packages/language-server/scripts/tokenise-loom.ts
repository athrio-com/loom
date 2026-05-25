import { NodeRuntime } from "@effect/platform-node"
import { Chunk, Effect, Stream, pipe } from "effect"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { LoomSourceRanges } from "../src/ast/LineRanges"
import { WeftClassifier } from "../src/ast/WeftClassifier"
import { WeftTokeniser } from "../src/ast/WeftTokeniser"

// =============================================================================
// tokenise-loom — dev probe. Reads a .loom file and prints the
// post-Tokeniser weft stream as pretty JSON.
//
//   pnpm tsx scripts/tokenise-loom.ts [path/to/file.loom]
//
// Defaults to corpus/Fun.loom relative to the repo root.
// =============================================================================

const defaultPath = resolve(__dirname, "../../../corpus/Fun.loom")
const path = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : defaultPath
const text = readFileSync(path, "utf8")

const program = Effect.gen(function* () {
  const sources = yield* LoomSourceRanges
  const classifier = yield* WeftClassifier
  const tokeniser = yield* WeftTokeniser

  const ranges = yield* sources.stream(text)
  const wefts = pipe(
    ranges,
    classifier.classifyWefts(text),
    tokeniser.tokeniseWefts(text),
  )
  const collected = yield* Stream.runCollect(wefts)

  process.stdout.write(JSON.stringify(Chunk.toReadonlyArray(collected), null, 2) + "\n")
}).pipe(
  Effect.provide(LoomSourceRanges.Default),
  Effect.provide(WeftClassifier.Default),
  Effect.provide(WeftTokeniser.Default),
  Effect.catchTag("MixedEOL", (e) =>
    Effect.sync(() => {
      process.stderr.write(`MixedEOL: line ${e.foundLine}\n`)
    }),
  ),
)

NodeRuntime.runMain(program)
