import { Effect, Runtime } from 'effect'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { PackageConfig } from '../src/PackageConfig'
import { corpusErrors } from '#ast/LoomCorpusAst'

// Regression guard for the brace-in-prose gotcha. A literal `{{` on a preamble
// line tokenises as a Warp, so prose that describes the warp delimiters spells
// them as the numeric character references `&#123;` and `&#125;` (see the note in
// loom-tokens.loom). This builds each loom-lang corpus file's corpus the way the
// tangler does and runs the same `corpusErrors` gate, asserting none carries
// error health — so a future edit that drops the entities back to a literal `{{`
// fails right here, with the offending file named.

const corpusDir = resolve(__dirname, '../corpus')
const looms = readdirSync(corpusDir).filter((name) => name.endsWith('.loom'))

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
})

describe('corpus health — every loom-lang corpus file builds without error', () => {
  it.each(looms)('%s carries no error diagnostics', (file) => {
    const corpus = run(
      LoomCompiler.pipe(Effect.flatMap((c) => c.corpus(resolve(corpusDir, file)))),
    )
    const messages = corpusErrors(corpus).flatMap((entry) =>
      entry.diagnostics.map((d) => d.message),
    )
    expect(messages).toEqual([])
  })
})
