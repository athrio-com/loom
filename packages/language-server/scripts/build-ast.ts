import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Loom } from "#ast/Loom"

// =============================================================================
// tokenise-loom — dev probe. Reads a `.loom` file, runs the full AST
// pipeline (LineRanges → WeftClassifier → WeftTokeniser → LoomAstBuilder)
// via `Loom.ast(text)`, and prints the resulting `LoomDocument` as pretty
// JSON.
//
//   pnpm tsx scripts/tokenise-loom.ts [path/to/file.loom]
//
// Defaults to `corpus/Fun.loom` relative to the repo root. `Loom.ast`
// never fails — `MixedEOL` is recovered as a minimal document with NOK
// root health, so no error branch is needed here.
// =============================================================================

const defaultPath = resolve(__dirname, "./experimental.loom")
const path = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : defaultPath
const text = readFileSync(path, "utf8")

const program = Effect.gen(function* () {
  const loom = yield* Loom
  const document = yield* loom.ast(text)
  process.stdout.write(JSON.stringify(document, null, 2) + "\n")
}).pipe(Effect.provide(Loom.Default))

NodeRuntime.runMain(program)
