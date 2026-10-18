import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
const it = effectify(it_)
import { Array, Effect, Layer, Option } from 'effect'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { PackageConfig } from '../src/PackageConfig'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'

// A code anchor with a path, `::[Saying hello](greeting.loom)`, composes a section
// from another loom. The product pass cannot see that other file, so it records the
// edge and the compiler judges it against the corpus: the tangle inlines the section
// when it exists and refuses the build when it does not, and the editor projects the
// inlined block without mapping it into the wrong file. Each corpus here is held in
// memory, two or three frontmatter-less looms under a TypeScript primary language —
// the quick start's own shape.

const greeting = `# Saying hello

A greeting takes a name and returns a line of welcome.

=>
const greet = (name: string): string => \`Hello, \${name}!\`
`

const helloAnchoring = (anchor: string) => `# The program [hello.ts]

The program greets the world.

=>
${anchor}
console.log(greet('world'))
`

const layerOf = (files: Record<string, string>) =>
  Layer.provide(
    LoomCompiler.layer,
    Layer.merge(
      Layer.succeed(DocumentSource, {
        read: (path: string) => Effect.succeed(files[path] ?? ''),
        list: Option.some(() => Effect.succeed(Object.keys(files))),
      }),
      Layer.succeed(PackageConfig, {
        resolve: () =>
          Effect.succeed({
            delims: defaultAnchorDelims,
            primaryLanguage: 'typescript',
            variables: {},
            width: 100,
            packageRoot: undefined,
            workspaceRoot: undefined,
            corpusDir: undefined,
          }),
      }),
    ),
  )

const tangled = (files: Record<string, string>, entry: string) =>
  LoomCompiler.pipe(
    Effect.flatMap((c) => c.tangle(entry)),
    Effect.provide(layerOf(files)),
  )

const refusal = (files: Record<string, string>, entry: string) =>
  tangled(files, entry).pipe(
    Effect.flip,
    Effect.map((error) => error.message),
  )

const program = `const greet = (name: string): string => \`Hello, \${name}!\`
console.log(greet('world'))
`

describe('a code anchor composes a section from another loom', () => {
  it.effect('tangles the section its path names', () =>
    Effect.gen(function* () {
      const files = yield* tangled(
        {
          '/corpus/greeting.loom': greeting,
          '/corpus/hello.loom': helloAnchoring('::[Saying hello](greeting.loom)'),
        },
        '/corpus/hello.loom',
      )
      expect(files.map((f) => f.path)).toEqual(['/corpus/hello.ts'])
      expect(files[0]!.content).toBe(program)
    }),
  )

  it.effect('reads the path relative to the anchor’s own loom', () =>
    Effect.gen(function* () {
      const dotted = yield* tangled(
        {
          '/corpus/greeting.loom': greeting,
          '/corpus/hello.loom': helloAnchoring('::[Saying hello](./greeting.loom)'),
        },
        '/corpus/hello.loom',
      )
      expect(dotted[0]!.content).toBe(program)

      const climbing = yield* tangled(
        {
          '/corpus/lib/greeting.loom': greeting,
          '/corpus/app/hello.loom': helloAnchoring(
            '::[Saying hello](../lib/greeting.loom)',
          ),
        },
        '/corpus/app/hello.loom',
      )
      expect(climbing[0]!.content).toBe(program)
    }),
  )

  it.effect('refuses a section the named loom lacks', () =>
    Effect.gen(function* () {
      const message = yield* refusal(
        {
          '/corpus/greeting.loom': greeting,
          '/corpus/hello.loom': helloAnchoring('::[Saying goodbye](greeting.loom)'),
        },
        '/corpus/hello.loom',
      )
      expect(message).toContain(
        '/corpus/hello.loom:6: Unresolved anchor: no section named `Saying goodbye`.',
      )
    }),
  )

  it.effect('refuses a path that names no loom', () =>
    Effect.gen(function* () {
      const message = yield* refusal(
        {
          '/corpus/greeting.loom': greeting,
          '/corpus/hello.loom': helloAnchoring('::[Saying hello](nowhere.loom)'),
        },
        '/corpus/hello.loom',
      )
      expect(message).toContain(
        '/corpus/hello.loom:6: Unresolved anchor: no section named `Saying hello`.',
      )
    }),
  )

  it.effect('refuses a section in another language', () =>
    Effect.gen(function* () {
      const message = yield* refusal(
        {
          '/corpus/settings.loom': `# Saying hello {json}\n\n=>\n{ "greeting": "Hello" }\n`,
          '/corpus/hello.loom': helloAnchoring('::[Saying hello](settings.loom)'),
        },
        '/corpus/hello.loom',
      )
      expect(message).toContain('Cross-language transclusion: `Saying hello` is json')
    }),
  )

  it.effect('refuses a name two sections of the named loom share', () =>
    Effect.gen(function* () {
      const message = yield* refusal(
        {
          '/corpus/greeting.loom': `${greeting}\n# Saying hello\n\n=>\nconst again = 1\n`,
          '/corpus/hello.loom': helloAnchoring('::[Saying hello](greeting.loom)'),
        },
        '/corpus/hello.loom',
      )
      expect(message).toContain('Ambiguous anchor: 2 sections are named `Saying hello`.')
    }),
  )

  it.effect('diagnose marks the broken anchor in the editor', () =>
    Effect.gen(function* () {
      const files = {
        '/corpus/greeting.loom': greeting,
        '/corpus/hello.loom': helloAnchoring('::[Saying goodbye](greeting.loom)'),
      }
      const diagnostics = yield* LoomCompiler.pipe(
        Effect.flatMap((c) => c.diagnose('/corpus/hello.loom')),
        Effect.provide(layerOf(files)),
      )
      const hello = files['/corpus/hello.loom']
      expect(
        diagnostics.map((d) => [
          d.severity,
          hello.slice(d.position.start.offset, d.position.end.offset),
        ]),
      ).toEqual([['error', 'Saying goodbye']])
    }),
  )

  it.effect('the editor inlines the section but maps only the anchoring loom', () =>
    Effect.gen(function* () {
      const files = {
        '/corpus/greeting.loom': greeting,
        '/corpus/hello.loom': helloAnchoring('::[Saying hello](greeting.loom)'),
      }
      const hello = files['/corpus/hello.loom']
      const root = yield* LoomCompiler.pipe(
        Effect.flatMap((c) =>
          c.compile(
            {
              read: (path) => Effect.succeed(files[path as keyof typeof files] ?? ''),
              list: Option.some(() => Effect.succeed(Object.keys(files))),
            },
            '/corpus/hello.loom',
          ),
        ),
        Effect.provide(layerOf(files)),
      )
      const product = Option.getOrThrow(
        Array.findFirst(root.embeddedCodes ?? [], (code) => code.id === 'theprogram'),
      )
      const generated = product.snapshot.getText(0, product.snapshot.getLength())
      expect(generated).toBe(program)
      // every mapping reads the same text in hello.loom as in the product — so no
      // span of greeting.loom's inlined block claims an offset in hello.loom
      expect(product.mappings.length).toBeGreaterThan(0)
      product.mappings.forEach((m) => {
        const source = m.sourceOffsets[0]!
        const gen = m.generatedOffsets[0]!
        expect(hello.slice(source, source + m.lengths[0]!)).toBe(
          generated.slice(gen, gen + (m.generatedLengths?.[0] ?? m.lengths[0]!)),
        )
        expect(gen).toBeGreaterThanOrEqual(generated.indexOf('\n'))
      })
    }),
  )
})
