import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
const it = effectify(it_)
import { Effect, Layer } from 'effect'
import { FileSystem } from 'effect'
import { BunServices } from '@effect/platform-bun'
import { DocumentSource } from '../src/LoomCompiler'
import { LoomTangler } from '../src/LoomTangler'
import { PackageConfig } from '../src/PackageConfig'

// LoomTangler emits a .loom's bracket sinks to disk, each sink's anchors resolved
// across the corpus. This probe writes a tiny doc to a temp dir, tangles it, and
// reads the emitted file back — the end-to-end filesystem path the CLI runs.

const fixture = `---
Language: TypeScript
Package: out/
---

# Greeting

=>

const hi = "hello"

# Bundle {Tangle} [bundle.ts]

=>

::[Greeting]
`

// loomWith — a minimal doc: a section inlined by a `{Tangle}` file through a name
// anchor. `out` is a `dir/file` path: the directory becomes the frontmatter package
// and the file the `{Tangle}` section's `[file]` tag.
const loomWith = (value: string, out: string): string => {
  const slash = out.lastIndexOf('/')
  const dir = slash === -1 ? '' : out.slice(0, slash + 1)
  const file = slash === -1 ? out : out.slice(slash + 1)
  return `---
Language: TypeScript
Package: ${dir}
---

# Bit

=>

const x = "${value}"

# Sink {Tangle} [${file}]

=>

::[Bit]
`
}

// LoomTangler over the real Node filesystem (the tangler is the fs consumer);
// provideMerge keeps FileSystem visible to the probe for the temp dir.
const layers = LoomTangler.layer.pipe(
  Layer.provide(DocumentSource.layer),
  Layer.provide(PackageConfig.layer),
  Layer.provideMerge(BunServices.layer),
)

describe('LoomTangler — tangle bracket sinks to disk', () => {
  it.effect('writes a sink, resolving its anchor across the doc', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const entry = `${dir}/greet.loom`
      yield* fs.writeFileString(entry, fixture)

      const tangler = yield* LoomTangler
      const written = yield* tangler.tangle(entry)

      expect(written).toHaveLength(1) // one file sink — Bundle
      // Bundle's `::[Greeting]` resolves to Greeting and inlines its code.
      const out = yield* fs.readFileString(`${dir}/out/bundle.ts`)
      expect(out).toContain('const hi = "hello"')
    }).pipe(Effect.provide(layers)),
  )

  it.effect('tangles every .loom under a directory, recursively', () =>
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

  it.effect('refuses an unresolved anchor — fails loud, writes nothing', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const entry = `${dir}/broken.loom`
      yield* fs.writeFileString(
        entry,
        `---\nLanguage: TypeScript\nPackage: out/\n---\n\n# Sink {Tangle} [x.ts]\n\n=>\n\nconst x = ::[Ghost]\n`,
      )

      const tangler = yield* LoomTangler
      const result = yield* Effect.result(tangler.tangle(entry))

      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure') {
        expect(result.failure._tag).toBe('TangleError')
        expect(result.failure.message).toMatch(/Ghost/)
      }
      // the sink is never written — a broken anchor stops the tangle
      expect(yield* fs.exists(`${dir}/out/x.ts`)).toBe(false)
    }).pipe(Effect.provide(layers)),
  )

  it.effect('honours the workspace anchor delimiter', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      yield* fs.makeDirectory(`${dir}/.loom`, { recursive: true })
      yield* fs.writeFileString(
        `${dir}/.loom/config.yaml`,
        'anchor:\n  open: "<<"\n  close: ">>"\n',
      )
      yield* fs.writeFileString(
        `${dir}/g.loom`,
        `---\nLanguage: TypeScript\nPackage: out/\n---\n\n# Greeting\n\n=>\n\nconst hi = "hi"\n\n# Bundle {Tangle} [g.ts]\n\n=>\n\nexport const g = <<Greeting>>\n`,
      )

      const tangler = yield* LoomTangler
      yield* tangler.tangle(`${dir}/g.loom`)

      // `<<Greeting>>` — the configured delimiter — resolves to Greeting and inlines it.
      const out = yield* fs.readFileString(`${dir}/out/g.ts`)
      expect(out).toContain('const hi = "hi"')
    }).pipe(Effect.provide(layers)),
  )

  it.effect('places a sink under the package root derived from the corpus directory', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const ws = yield* fs.makeTempDirectoryScoped()
      yield* fs.makeDirectory(`${ws}/.loom`, { recursive: true })
      yield* fs.writeFileString(
        `${ws}/.loom/config.yaml`,
        `languages:\n  typescript: {}\nprimary: typescript\n`,
      )
      const corpus = `${ws}/packages/core/corpus`
      yield* fs.makeDirectory(corpus, { recursive: true })
      yield* fs.writeFileString(
        `${corpus}/widget.loom`,
        loomWith('w', 'src/Widget.ts'),
      )

      const tangler = yield* LoomTangler
      const written = yield* tangler.tangle(`${corpus}/widget.loom`)

      // the sink `[src, Widget.ts]` resolves under the directory above the
      // corpus folder, packages/core, not the .loom's own directory
      expect(written).toHaveLength(1)
      expect(written[0]?.path).toBe(`${ws}/packages/core/src/Widget.ts`)
      expect(
        yield* fs.readFileString(`${ws}/packages/core/src/Widget.ts`),
      ).toContain('"w"')
      expect(yield* fs.exists(`${corpus}/src/Widget.ts`)).toBe(false)
    }).pipe(Effect.provide(layers)),
  )
})
