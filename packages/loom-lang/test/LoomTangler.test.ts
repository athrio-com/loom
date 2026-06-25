import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { FileSystem } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { DocumentSource } from '../src/LoomCompiler'
import { LoomTangler } from '../src/LoomTangler'
import { PackageConfig } from '../src/PackageConfig'

// LoomTangler emits a .loom's {path} sinks to disk, each sink's anchors resolved
// across the corpus. This probe writes a tiny doc to a temp dir, tangles it, and
// reads the emitted file back — the end-to-end filesystem path the CLI runs.

const fixture = `{{lang: TypeScript}}

# Greeting [Greet]

=>

const hi = "hello"

# Bundle {out/bundle.ts}

{{g = Greet}}

=>

::[g]
`

// loomWith — a minimal doc: a tagged section inlined by a {path} sink.
const loomWith = (value: string, out: string): string =>
  `{{lang: TypeScript}}

# Bit [Bit]

=>

const x = "${value}"

# Sink {${out}}

{{b = Bit}}

=>

::[b]
`

// LoomTangler over the real Node filesystem (the tangler is the fs consumer);
// provideMerge keeps FileSystem visible to the probe for the temp dir.
const layers = LoomTangler.Default.pipe(
  Layer.provide(DocumentSource.Default),
  Layer.provide(PackageConfig.Default),
  Layer.provideMerge(NodeContext.layer),
)

describe('LoomTangler — tangle {path} sinks to disk', () => {
  it.scoped('writes a sink, resolving its anchor across the doc', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const entry = `${dir}/greet.loom`
      yield* fs.writeFileString(entry, fixture)

      const tangler = yield* LoomTangler
      const written = yield* tangler.tangle(entry)

      expect(written).toHaveLength(1) // one {path} sink — Bundle
      // Bundle's `::[g]` resolves to Greet and inlines its code.
      const out = yield* fs.readFileString(`${dir}/out/bundle.ts`)
      expect(out).toContain('const hi = "hello"')
    }).pipe(Effect.provide(layers)),
  )

  it.scoped('tangles every .loom under a directory, recursively', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      yield* fs.makeDirectory(`${dir}/nested`, { recursive: true })
      yield* fs.writeFileString(`${dir}/one.loom`, loomWith('one', 'out/one.ts'))
      yield* fs.writeFileString(
        `${dir}/nested/two.loom`,
        loomWith('two', 'out/two.ts'),
      )

      const tangler = yield* LoomTangler
      const written = yield* tangler.tangle(dir)

      expect(written).toHaveLength(2) // both .loom found and tangled
      expect(yield* fs.readFileString(`${dir}/out/one.ts`)).toContain('"one"')
      expect(
        yield* fs.readFileString(`${dir}/nested/out/two.ts`),
      ).toContain('"two"')
    }).pipe(Effect.provide(layers)),
  )

  it.scoped('refuses an unresolved anchor — fails loud, writes nothing', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const entry = `${dir}/broken.loom`
      yield* fs.writeFileString(
        entry,
        `{{lang: TypeScript}}\n\n# Sink {out/x.ts}\n\n=>\n\nconst x = ::[Ghost]\n`,
      )

      const tangler = yield* LoomTangler
      const result = yield* Effect.either(tangler.tangle(entry))

      expect(result._tag).toBe('Left')
      if (result._tag === 'Left') {
        expect(result.left._tag).toBe('TangleError')
        expect(result.left.message).toMatch(/Ghost/)
      }
      // the sink is never written — a broken anchor stops the tangle
      expect(yield* fs.exists(`${dir}/out/x.ts`)).toBe(false)
    }).pipe(Effect.provide(layers)),
  )

  it.scoped("honours a package's loom.json anchor delimiter", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(
        `${dir}/loom.json`,
        '{ "anchor": { "open": "<<", "close": ">>" } }',
      )
      yield* fs.writeFileString(
        `${dir}/g.loom`,
        `{{lang: TypeScript}}\n\n# Greeting [Greet]\n\n=>\n\nconst hi = "hi"\n\n# Bundle {out/g.ts}\n\n{{g = Greet}}\n\n=>\n\nexport const g = <<g>>\n`,
      )

      const tangler = yield* LoomTangler
      yield* tangler.tangle(`${dir}/g.loom`)

      // `<<g>>` — the configured delimiter — resolves to Greet and inlines it.
      const out = yield* fs.readFileString(`${dir}/out/g.ts`)
      expect(out).toContain('const hi = "hi"')
    }).pipe(Effect.provide(layers)),
  )
})
