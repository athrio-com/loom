import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
import { Array, Effect, Layer, Option } from 'effect'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import { PackageConfig } from '../src/PackageConfig'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'

const it = effectify(it_)

const lines = (...rows: ReadonlyArray<string>): string => `${rows.join('\n')}\n`

const anchor = (name: string): string => `::${'['}${name}]`

const greeting = lines(
  '# Saying hello',
  '',
  'A greeting takes a name and returns a line of welcome.',
  '',
  '=>',
  'const greet = (name: string): string => `Hello, ${name}!`',
)

const helloAnchoring = (line: string) =>
  lines(
    '# The program [hello.ts]',
    '',
    'The program greets the world.',
    '',
    '=>',
    line,
    "console.log(greet('world'))",
  )

const program = `const greet = (name: string): string => \`Hello, \${name}!\`
console.log(greet('world'))
`

const layerOf = (files: Record<string, string>) =>
  Layer.provide(
    LoomCompiler.layer,
    Layer.mergeAll(
      LoomConfig.layer,
      Layer.succeed(DocumentSource, {
        read: (path: string) => Effect.succeed(files[path] ?? ''),
        list: Option.some(() => Effect.succeed(Object.keys(files))),
        hold: () => Effect.void,
        forget: () => Effect.void,
      }),
      Layer.succeed(PackageConfig, {
        resolve: () =>
          Effect.succeed({
            delims: defaultAnchorDelims,
            primaryLanguage: 'typescript',
            variables: {},
            width: 100,
            packageRoot: undefined,
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

describe('a code anchor composes a section from another loom', () => {
  it.effect('tangles the section its path names', () =>
    Effect.gen(function* () {
      const files = yield* tangled(
        {
          '/corpus/greeting.loom': greeting,
          '/corpus/hello.loom': helloAnchoring(`${anchor('Saying hello')}(greeting.loom)`),
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
          '/corpus/hello.loom': helloAnchoring(`${anchor('Saying hello')}(./greeting.loom)`),
        },
        '/corpus/hello.loom',
      )
      expect(dotted[0]!.content).toBe(program)

      const climbing = yield* tangled(
        {
          '/corpus/lib/greeting.loom': greeting,
          '/corpus/app/hello.loom': helloAnchoring(
            `${anchor('Saying hello')}(../lib/greeting.loom)`,
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
          '/corpus/hello.loom': helloAnchoring(`${anchor('Saying goodbye')}(greeting.loom)`),
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
          '/corpus/hello.loom': helloAnchoring(`${anchor('Saying hello')}(nowhere.loom)`),
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
          '/corpus/hello.loom': helloAnchoring(`${anchor('Saying hello')}(settings.loom)`),
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
          '/corpus/hello.loom': helloAnchoring(`${anchor('Saying hello')}(greeting.loom)`),
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
        '/corpus/hello.loom': helloAnchoring(`${anchor('Saying goodbye')}(greeting.loom)`),
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
        '/corpus/hello.loom': helloAnchoring(`${anchor('Saying hello')}(greeting.loom)`),
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
