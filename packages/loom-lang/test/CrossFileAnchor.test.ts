import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
import { Array, Effect, Layer, Option } from 'effect'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { WorkspaceSettings } from '../src/WorkspaceSettings'
import { LoomDiskCache } from '../src/LoomDiskCache'
import { FileSystemSource } from '../src/WorkspaceSource'
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
      FileSystemSource,
      LoomDiskCache.none,
      Layer.succeed(DocumentSource, {
        read: (path: string) => Effect.succeed(files[path] ?? ''),
        list: Option.some(() => Effect.succeed(Object.keys(files))),
        hold: () => Effect.void,
        forget: () => Effect.void,
      }),
      Layer.succeed(WorkspaceSettings, {
        manifest: () => Effect.succeed(Option.none()),
        resolve: () =>
          Effect.succeed({
            delims: defaultAnchorDelims,
            primaryLanguage: 'typescript',
            variables: {},
            width: 100,
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

const chapter = (identity: ReadonlyArray<string>, ...body: ReadonlyArray<string>): string =>
  lines('---', ...identity, '---', '', ...body)

const greetCode = 'const greet = (name: string): string => `Hello, ${name}!`'

const book = (line: string): Record<string, string> => ({
  '/corpus/greetings.loom': chapter(
    ['Part I: Saying things', 'Chapter 1: Greetings'],
    '# Greetings',
    '',
    'A greeting takes a name and returns a line of welcome.',
    '',
    '=>',
    greetCode,
  ),
  '/corpus/words.loom': chapter(
    ['Part I, Chapter 2: Words'],
    '# Words',
    '',
    'This chapter gathers what the program says.',
    '',
    '## Saying hello',
    '',
    'A greeting takes a name and returns a line of welcome.',
    '',
    '=>',
    greetCode,
  ),
  '/corpus/silence.loom': chapter(['Part I, Chapter 3: Silence'], 'Nothing is said here.'),
  '/corpus/setup-one.loom': chapter(['Part I, Chapter 4: Setup'], '# Setup', '', '=>', greetCode),
  '/corpus/setup-two.loom': chapter(
    ['Part II: Doing things', 'Chapter 1: Setup'],
    '# Setup',
    '',
    '=>',
    greetCode,
  ),
  '/corpus/hello-world.loom': chapter(
    ['Part I, Chapter 5: Hello, world'],
    '# Hello, world',
    '',
    '=>',
    greetCode,
  ),
  '/corpus/hello.loom': helloAnchoring(line),
})

describe('a name resolves through the book', () => {
  it.effect('composes the opening section of the chapter a bare name finds', () =>
    Effect.gen(function* () {
      const files = yield* tangled(book(anchor('Greetings')), '/corpus/hello.loom')
      expect(files[0]!.content).toBe(program)
    }),
  )

  it.effect('a path names a section of another chapter, directly or through its part', () =>
    Effect.gen(function* () {
      const direct = yield* tangled(book(anchor('Words, Saying hello')), '/corpus/hello.loom')
      expect(direct[0]!.content).toBe(program)
      const throughPart = yield* tangled(
        book(anchor('Saying things, Words, Saying hello')),
        '/corpus/hello.loom',
      )
      expect(throughPart[0]!.content).toBe(program)
    }),
  )

  it.effect('refuses a bare name that only a section of another chapter carries', () =>
    Effect.gen(function* () {
      const message = yield* refusal(book(anchor('Saying hello')), '/corpus/hello.loom')
      expect(message).toContain(
        '/corpus/hello.loom:6: Unresolved anchor: no section named `Saying hello`.',
      )
    }),
  )

  it.effect('warns when the chapter opens with a section that holds no code', () =>
    Effect.gen(function* () {
      const files = book(anchor('Words'))
      const diagnostics = yield* LoomCompiler.pipe(
        Effect.flatMap((c) => c.diagnose('/corpus/hello.loom')),
        Effect.provide(layerOf(files)),
      )
      const hello = files['/corpus/hello.loom']!
      expect(
        diagnostics.map((d) => [
          d.severity,
          hello.slice(d.position.start.offset, d.position.end.offset),
        ]),
      ).toEqual([['warning', 'Words']])
      expect(yield* refusal(files, '/corpus/hello.loom')).toContain(
        '/corpus/hello.loom:6: To be settled: `Words` holds no code yet, so this anchor composes nothing.',
      )
    }),
  )

  it.effect('refuses a chapter that holds no section', () =>
    Effect.gen(function* () {
      const message = yield* refusal(book(anchor('Silence')), '/corpus/hello.loom')
      expect(message).toContain(
        '/corpus/hello.loom:6: Unresolved anchor: no section named `Silence`.',
      )
    }),
  )

  it.effect('a title two chapters share is ambiguous until a part names one', () =>
    Effect.gen(function* () {
      const message = yield* refusal(book(anchor('Setup')), '/corpus/hello.loom')
      expect(message).toContain(
        'Ambiguous anchor: 2 sections are named `Setup`. Write the path to the one you mean:',
      )
      expect(message).toContain('`Saying things, Setup`')
      expect(message).toContain('`Doing things, Setup`')
      const files = yield* tangled(book(anchor('Doing things, Setup')), '/corpus/hello.loom')
      expect(files[0]!.content).toBe(program)
    }),
  )

  it.effect('offers the path through each part as a fix', () =>
    Effect.gen(function* () {
      const diagnostics = yield* LoomCompiler.pipe(
        Effect.flatMap((c) => c.diagnose('/corpus/hello.loom')),
        Effect.provide(layerOf(book(anchor('Setup')))),
      )
      expect(diagnostics.flatMap((d) => (d.fixes ?? []).map((fix) => fix.text)).sort()).toEqual([
        'Doing things, Setup',
        'Saying things, Setup',
      ])
    }),
  )

  it.effect('a title that holds a comma resolves whole', () =>
    Effect.gen(function* () {
      const files = yield* tangled(book(anchor('Hello, world')), '/corpus/hello.loom')
      expect(files[0]!.content).toBe(program)
    }),
  )
})

const samePage = chapter(
  ['Part I: Repro', 'Chapter 1: The page'],
  '# The page',
  '',
  "A chapter whose one section carries the chapter's own title.",
  '',
  '## The page [same.html]',
  '',
  '=>',
  '<p>hello from the section</p>',
)

describe('a name repeated among siblings', () => {
  it.effect('refuses a section titled like the chapter heading above it', () =>
    Effect.gen(function* () {
      const message = yield* refusal({ '/corpus/same.loom': samePage }, '/corpus/same.loom')
      expect(message).toContain(
        '/corpus/same.loom:10: Duplicate name: `The page` is already a section of this loom (line 6). Rename one.',
      )
    }),
  )

  it.effect('composes a sink from its own code, never from a namesake', () =>
    Effect.gen(function* () {
      const files = yield* LoomCompiler.pipe(
        Effect.flatMap((c) => c.composition('/corpus/same.loom')),
        Effect.provide(layerOf({ '/corpus/same.loom': samePage })),
      )
      const page = files.find((file) => file.path.endsWith('same.html'))
      expect(page?.content).toContain('<p>hello from the section</p>')
    }),
  )

  it.effect('faults two titles that fold to one name', () =>
    Effect.gen(function* () {
      const loom = lines(
        '# Saying hello',
        '',
        '=>',
        'const hello = 1',
        '',
        '# Saying Hello!',
        '',
        '=>',
        'const again = 2',
      )
      const diagnostics = yield* LoomCompiler.pipe(
        Effect.flatMap((c) => c.diagnose('/corpus/twice.loom')),
        Effect.provide(layerOf({ '/corpus/twice.loom': loom })),
      )
      expect(
        diagnostics.map((d) => [
          d.message,
          loom.slice(d.position.start.offset, d.position.end.offset),
        ]),
      ).toEqual([
        [
          'Duplicate name: `Saying Hello!` is already a section of this loom (line 1). Rename one.',
          'Saying Hello!',
        ],
      ])
    }),
  )

  it.effect('faults two chapters of one part that share a title', () =>
    Effect.gen(function* () {
      const files = {
        '/corpus/setup-one.loom': chapter(
          ['Part I, Chapter 4: Setup'],
          '# Setup',
          '',
          '=>',
          greetCode,
        ),
        '/corpus/setup-three.loom': chapter(
          ['Part I, Chapter 6: Setup'],
          '# Setup',
          '',
          '=>',
          greetCode,
        ),
      }
      const diagnostics = yield* LoomCompiler.pipe(
        Effect.flatMap((c) => c.diagnose('/corpus/setup-one.loom')),
        Effect.provide(layerOf(files)),
      )
      expect(diagnostics.map((d) => d.message)).toEqual([
        'Duplicate name: `Setup` is already a chapter of this part (setup-three.loom). Rename one.',
      ])
    }),
  )
})

describe('a path names parts and chapters by number', () => {
  it.effect('composes through a part and a chapter given by number', () =>
    Effect.gen(function* () {
      const numbered = yield* tangled(
        book(anchor('Part I, Chapter 2, Saying hello')),
        '/corpus/hello.loom',
      )
      expect(numbered[0]!.content).toBe(program)
      const mixed = yield* tangled(book(anchor('Saying things, Chapter 1')), '/corpus/hello.loom')
      expect(mixed[0]!.content).toBe(program)
    }),
  )
})

describe('a fix declares a missing section', () => {
  const diagnose = (text: string) =>
    LoomCompiler.pipe(
      Effect.flatMap((c) => c.diagnose('/corpus/hello.loom')),
      Effect.provide(layerOf({ '/corpus/hello.loom': text })),
    )
  const applied = (text: string, fix: { readonly text: string; readonly at?: unknown }) => {
    const at = fix.at as { readonly start: { readonly offset: number } }
    return `${text.slice(0, at.start.offset)}${fix.text}${text.slice(at.start.offset)}`
  }

  it.effect('declares the section below the one that names it', () =>
    Effect.gen(function* () {
      const alone = helloAnchoring(anchor('Saying goodbye'))
      const followed = `${alone}\n## Later\n\nMore to come.\n`
      const unsettled = (diagnostics: ReadonlyArray<{ readonly message: string }>) =>
        diagnostics.map((d) => d.message)
      const declared =
        'To be settled: `Saying goodbye` holds no code yet, so this anchor composes nothing.'
      const [atEnd, labelled] = (yield* diagnose(alone))[0]!.fixes ?? []
      expect([atEnd!.title, atEnd!.text]).toEqual([
        'Declare the section `Saying goodbye`',
        '\n# Saying goodbye\n',
      ])
      expect(unsettled(yield* diagnose(applied(alone, atEnd!)))).toEqual([declared])
      expect([labelled!.title, labelled!.text]).toEqual([
        'Mark `Saying goodbye` to be settled',
        '{To be settled}',
      ])
      expect(unsettled(yield* diagnose(applied(alone, labelled!)))).toEqual([
        'To be settled: no section is named `Saying goodbye` yet, so this anchor composes nothing.',
      ])
      const [beforeNext] = (yield* diagnose(followed))[0]!.fixes ?? []
      expect(beforeNext!.text).toBe('# Saying goodbye\n\n')
      expect(applied(followed, beforeNext!)).toContain('# Saying goodbye\n\n## Later')
      expect(unsettled(yield* diagnose(applied(followed, beforeNext!)))).toEqual([declared])
    }),
  )
})

const settleDiagnose = (files: Record<string, string>, entry: string) =>
  LoomCompiler.pipe(
    Effect.flatMap((c) => c.diagnose(entry)),
    Effect.provide(layerOf(files)),
    Effect.map((diagnostics) => diagnostics.map((d) => [d.severity, d.message])),
  )

const declaredLater = `${helloAnchoring(anchor('Greeting'))}\n# Greeting\n\nA greeting, still to be written.\n`

describe('a section to be settled', () => {
  it.effect('marks an anchor that composes a section with no code, and refuses the tangle', () =>
    Effect.gen(function* () {
      const note = 'To be settled: `Greeting` holds no code yet, so this anchor composes nothing.'
      expect(
        yield* settleDiagnose({ '/corpus/hello.loom': declaredLater }, '/corpus/hello.loom'),
      ).toEqual([['info', note]])
      expect(
        yield* refusal({ '/corpus/hello.loom': declaredLater }, '/corpus/hello.loom'),
      ).toContain(`/corpus/hello.loom:6: ${note}`)
    }),
  )

  it.effect('takes a labelled name nothing carries as meant, and refuses the tangle', () =>
    Effect.gen(function* () {
      const labelled = {
        '/corpus/hello.loom': helloAnchoring(`${anchor('Greeting')}{To be settled}`),
      }
      const note =
        'To be settled: no section is named `Greeting` yet, so this anchor composes nothing.'
      expect(yield* settleDiagnose(labelled, '/corpus/hello.loom')).toEqual([['info', note]])
      expect(yield* refusal(labelled, '/corpus/hello.loom')).toContain(
        `/corpus/hello.loom:6: ${note}`,
      )
    }),
  )

  it.effect('takes the names an anchor says its section provides as a promise', () =>
    Effect.gen(function* () {
      const promised = {
        '/corpus/hello.loom': helloAnchoring(`${anchor('Greeting')}{provides=greet}`),
      }
      const note =
        'To be settled: no section is named `Greeting` yet, so this anchor composes nothing.'
      expect(yield* settleDiagnose(promised, '/corpus/hello.loom')).toEqual([['info', note]])
      expect(yield* refusal(promised, '/corpus/hello.loom')).toContain(
        `/corpus/hello.loom:6: ${note}`,
      )
    }),
  )

  it.effect('notes a label its section has outgrown, and its fix removes it', () =>
    Effect.gen(function* () {
      const settled = `${helloAnchoring(`${anchor('Saying hello')}{To be settled}`)}\n${greeting}`
      const [note] = yield* LoomCompiler.pipe(
        Effect.flatMap((c) => c.diagnose('/corpus/hello.loom')),
        Effect.provide(layerOf({ '/corpus/hello.loom': settled })),
      )
      expect([note!.severity, note!.message]).toEqual([
        'info',
        'Settled: `Saying hello` holds code now, so its `{To be settled}` label has nothing left to say.',
      ])
      const [fix] = note!.fixes ?? []
      const at = fix!.at!
      const removed = `${settled.slice(0, at.start.offset)}${fix!.text}${settled.slice(at.end.offset)}`
      expect(removed).toContain(`${anchor('Saying hello')}\n`)
      expect(
        yield* settleDiagnose({ '/corpus/hello.loom': removed }, '/corpus/hello.loom'),
      ).toEqual([])
    }),
  )

  it.effect('reads the kind in full beside other parameters', () =>
    Effect.gen(function* () {
      const full = `${anchor('Saying hello')}{kind="To be settled" provides=greet}`
      const labelled = { '/corpus/hello.loom': helloAnchoring(full) }
      expect(yield* settleDiagnose(labelled, '/corpus/hello.loom')).toEqual([
        [
          'info',
          'To be settled: no section is named `Saying hello` yet, so this anchor composes nothing.',
        ],
      ])
      const settled = `${helloAnchoring(full)}\n${greeting}`
      const [note] = yield* LoomCompiler.pipe(
        Effect.flatMap((c) => c.diagnose('/corpus/hello.loom')),
        Effect.provide(layerOf({ '/corpus/hello.loom': settled })),
      )
      const [fix] = note!.fixes ?? []
      const at = fix!.at!
      const removed = `${settled.slice(0, at.start.offset)}${fix!.text}${settled.slice(at.end.offset)}`
      expect(removed).toContain(`${anchor('Saying hello')}{provides=greet}\n`)
    }),
  )
})

const complete = (text: string, offset: number) =>
  LoomCompiler.pipe(
    Effect.flatMap((c) => c.completions('/corpus/hello.loom', offset)),
    Effect.provide(layerOf({ '/corpus/hello.loom': text })),
  )

const at = (from: number, to: number) => ({
  start: { line: 5, character: from },
  end: { line: 5, character: to },
})

describe("completing an anchor's label", () => {
  it.effect('offers the label between the braces, and closes braces left open', () =>
    Effect.gen(function* () {
      const closed = helloAnchoring(`${anchor('Greeting')}{To b}`)
      expect(yield* complete(closed, closed.indexOf('To b') + 4)).toEqual([
        { label: 'To be settled', range: at(13, 17), text: 'To be settled' },
      ])
      const open = helloAnchoring(`${anchor('Greeting')}{`)
      expect(yield* complete(open, open.indexOf('{') + 1)).toEqual([
        { label: 'To be settled', range: at(13, 13), text: 'To be settled}' },
      ])
      expect(yield* complete(closed, closed.indexOf('Greeting') + 2)).toEqual([])
    }),
  )
})

describe('brackets after an anchor', () => {
  it.effect('stay code, so an index survives the tangle', () =>
    Effect.gen(function* () {
      const indexed = {
        '/corpus/hello.loom': `${helloAnchoring(`${anchor('Saying hello')}[0]`)}\n${greeting}`,
      }
      expect(yield* settleDiagnose(indexed, '/corpus/hello.loom')).toEqual([])
      const [file] = yield* tangled(indexed, '/corpus/hello.loom')
      expect(file!.content).toContain('`Hello, ${name}!`[0]\n')
    }),
  )
})

const contractsOf = (text: string) =>
  LoomCompiler.pipe(
    Effect.flatMap((c) => c.contracts('/corpus/hello.loom')),
    Effect.provide(layerOf({ '/corpus/hello.loom': text })),
  )

describe('what an anchor says its section provides', () => {
  it.effect('names what the section must declare, and nothing to be settled', () =>
    Effect.gen(function* () {
      const stated = `${helloAnchoring(`${anchor('Saying hello')}{provides=[greet, farewell]}`)}\n${greeting}`
      const [contract] = yield* contractsOf(stated)
      expect(contract!.target.path).toBe('/corpus/hello.loom')
      expect(contract!.target.range.start).toEqual({ line: 13, character: 0 })
      expect(contract!.language).toBe('typescript')
      expect(contract!.expected.map((expected) => expected.name)).toEqual(['greet', 'farewell'])
      expect(contract!.expected[1]!.diagnostic.message).toBe(
        'Missing symbol: `Saying hello` declares no `farewell`, which this anchor says it provides.',
      )
      const waiting = helloAnchoring(
        `${anchor('Saying hello')}{kind="To be settled" provides=greet}`,
      )
      expect(yield* contractsOf(waiting)).toEqual([])
    }),
  )
})

const promisedOf = (text: string) =>
  LoomCompiler.pipe(
    Effect.flatMap((c) => c.promised('/corpus/hello.loom', 'theprogram')),
    Effect.provide(layerOf({ '/corpus/hello.loom': text })),
  )

describe('what a program is promised', () => {
  it.effect('names what an unsettled section is promised, and nothing once it is written', () =>
    Effect.gen(function* () {
      expect(yield* promisedOf(helloAnchoring(`${anchor('Greeting')}{provides=greet}`))).toEqual([
        { name: 'greet', section: 'Greeting' },
      ])
      const settled = `${helloAnchoring(`${anchor('Saying hello')}{provides=greet}`)}\n${greeting}`
      expect(yield* promisedOf(settled)).toEqual([])
    }),
  )
})
