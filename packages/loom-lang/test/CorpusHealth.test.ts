import { Effect, Runtime } from 'effect'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { PackageConfig } from '../src/PackageConfig'

// Regression guard for the brace-in-prose gotcha, now covering the whole book. A
// literal `{{` on a preamble line tokenises as a Warp, so prose that describes the
// warp delimiters spells them as the numeric character references `&#123;` and
// `&#125;` (see the note in the leaf-tokens chapter). This diagnoses every chapter
// loom and asserts none carries error health, so a future edit that drops the
// entities back to a literal `{{` fails right here, with the offending file named.
// The book is one corpus at the repo root, its chapters filed under narrative
// folders (corpus/NN-title/). Three parts of that tree are left out: the guide is
// authored on its own track, a work-in-progress loom may name code it has not built
// yet, and the spine (book.loom) is the table of contents, not a chapter. Each
// file's diagnostics scope to itself — a standalone module places nothing, so a
// sibling never reports on it. Discovery builds the whole tree into one corpus, so
// `beforeAll` warms it once and each case below reads a hot memo rather than paying
// the walk.

const corpusDir = resolve(__dirname, '../../../corpus')
const looms = readdirSync(corpusDir, { recursive: true })
  .map(String)
  .filter((name) => name.endsWith('.loom'))
  .filter(
    (name) => !name.startsWith('guide') && !name.startsWith('work-in-progress'),
  )
  .filter((name) => name !== 'book.loom')

let run: <A>(effect: Effect.Effect<A, never, LoomCompiler>) => A

beforeAll(async () => {
  const runtime = await Effect.runPromise(
    Effect.runtime<LoomCompiler>().pipe(
      Effect.provide(LoomCompiler.Default),
      Effect.provide(DocumentSource.Default),
      Effect.provide(PackageConfig.Default),
    ),
  )
  run = (effect) => Runtime.runSync(runtime)(effect)
  run(
    LoomCompiler.pipe(
      Effect.flatMap((c) => c.diagnose(resolve(corpusDir, looms[0]!))),
    ),
  )
})

describe('corpus health — every loom-lang corpus file builds without error', () => {
  it.each(looms)('%s carries no error diagnostics', (file) => {
    const messages = run(
      LoomCompiler.pipe(Effect.flatMap((c) => c.diagnose(resolve(corpusDir, file)))),
    )
      .filter((d) => d.severity === 'error')
      .map((d) => d.message)
    expect(messages).toEqual([])
  })
})
