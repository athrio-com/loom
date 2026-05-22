import { NodeRuntime } from "@effect/platform-node"
import { Chunk, Effect, Stream } from "effect"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { LoomSourceRanges } from "../src/ast/LineRanges"
import { WeftClassifier } from "../src/ast/WeftClassifier"

// =============================================================================
// classify-loom — dev probe. Reads a .loom file and prints the
// Classifier-Stage output as JSON, one weft per line.
//
//   pnpm tsx scripts/classify-loom.ts [path/to/file.loom]
//
// Defaults to corpus/Loom.loom relative to the repo root.
// =============================================================================

const defaultPath = resolve(__dirname, "../../../corpus/Loom.loom")
const path = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : defaultPath
const text = readFileSync(path, "utf8")

const program = Effect.gen(function* () {
  const sources = yield* LoomSourceRanges
  const classifier = yield* WeftClassifier

  const ranges = yield* sources.stream(text)
  const wefts = classifier.classifyWefts(text)(ranges)
  const collected = yield* Stream.runCollect(wefts)

  for (const w of Chunk.toReadonlyArray(collected)) {
    process.stdout.write(JSON.stringify(w) + "\n")
  }
}).pipe(
  Effect.provide(LoomSourceRanges.Default),
  Effect.provide(WeftClassifier.Default),
  Effect.catchTag("MixedEOL", (e) =>
    Effect.sync(() => {
      process.stderr.write(`MixedEOL: line ${e.foundLine}\n`)
    }),
  ),
)

NodeRuntime.runMain(program)
