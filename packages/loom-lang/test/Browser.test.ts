import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
import { Data, Effect, Option, Schema } from 'effect'
import { readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { join, relative, resolve } from 'node:path'
import vm from 'node:vm'
import { moduleOfText } from './browser/page'

const it = effectify(it_)

const root = resolve(import.meta.dir, '../../..')

const page = join(import.meta.dir, 'browser', 'page.ts')

const leaning = join(import.meta.dir, 'browser', 'leans-on-node.ts')

const modelPackage = join(root, 'packages', 'loom-ast')

const ManifestSchema = Schema.Struct({ exports: Schema.Record(Schema.String, Schema.String) })

const modelEntries: ReadonlyArray<string> = Object.values(
  Schema.decodeUnknownSync(Schema.fromJsonString(ManifestSchema))(
    readFileSync(join(modelPackage, 'package.json'), 'utf8'),
  ).exports,
).map((file) => join(modelPackage, file))

type Reached = { readonly module: string; readonly from: string }

type Bundle = { readonly code: string; readonly reached: ReadonlyArray<Reached> }

class BundleFailed extends Data.TaggedError('BundleFailed')<{
  readonly said: ReadonlyArray<string>
}> {}

const builtIn = (name: string): boolean =>
  name.startsWith('node:') || name.startsWith('bun:') || isBuiltin(name)

const reachedIn = (account: Bun.BuildMetafile): ReadonlyArray<Reached> =>
  Object.entries(account.inputs)
    .filter(([file]) => !builtIn(file))
    .flatMap(([file, input]) =>
      input.imports
        .filter((found) => builtIn(found.path))
        .map((found): Reached => ({ module: found.path, from: relative(root, resolve(file)) })),
    )

const saidBy = (cause: unknown): ReadonlyArray<string> =>
  cause instanceof AggregateError ? cause.errors.map(String) : [String(cause)]

const bundled = (
  entries: ReadonlyArray<string>,
  minify: boolean,
): Effect.Effect<Bundle, BundleFailed> =>
  Effect.tryPromise({
    try: () =>
      Bun.build({
        entrypoints: [...entries],
        target: 'browser',
        format: 'esm',
        minify,
        metafile: true,
      }),
    catch: (cause) => new BundleFailed({ said: saidBy(cause) }),
  }).pipe(
    Effect.flatMap((built) =>
      Effect.promise(() => Promise.all(built.outputs.map((output) => output.text()))).pipe(
        Effect.map((code): Bundle => ({
          code: code.join('\n'),
          reached: Option.match(Option.fromNullishOr(built.metafile), {
            onNone: () => [],
            onSome: reachedIn,
          }),
        })),
      ),
    ),
  )

const noImport = (name: string): Promise<never> =>
  Promise.reject(new Error(`the bundle asks to import ${name}, and a bundle holds all it needs`))

const loadedInPage = (code: string): Effect.Effect<object> =>
  Effect.gen(function* () {
    const module = new vm.SourceTextModule(code, {
      context: vm.createContext({ TextEncoder, TextDecoder }),
    })
    yield* Effect.promise(() => module.link(noImport))
    yield* Effect.promise(() => module.evaluate())
    return module.namespace
  })

const lines = (...rows: ReadonlyArray<string>): string => `${rows.join('\n')}\n`

const anchor = (name: string): string => `::${'['}${name}]`

describe('a page that reads a loom', () => {
  const path = '/corpus/greeting.loom'
  const loom = lines(
    '---',
    'Chapter 1: A greeting',
    'Package: greeting.ts',
    'Language: TypeScript',
    '---',
    '',
    '# A greeting',
    '',
    `The greeting composes ${anchor('The name')}.`,
    '',
    '## The name',
    '',
    '=>',
    '',
    "const name = 'world'",
    '',
    '## The greeting {Tangle}',
    '',
    '=>',
    '',
    anchor('The name'),
    '',
    'console.log(`hello ${name}`)',
  )

  it.effect('imports no module built into Node or into Bun', () =>
    Effect.gen(function* () {
      const { reached } = yield* bundled([page, ...modelEntries], false)
      expect(reached).toEqual([])
    }),
  )

  it.effect('is caught when it imports one', () =>
    Effect.gen(function* () {
      const { reached } = yield* bundled([leaning], false)
      const from = 'packages/loom-lang/test/browser/leans-on-node.ts'
      expect(reached).toEqual([
        { module: 'fs', from },
        { module: 'node:path', from },
      ])
    }),
  )

  it.effect('builds, where nothing of Node exists, the module the builder builds', () =>
    Effect.gen(function* () {
      const { code } = yield* bundled([page], false)
      const loaded = (yield* loadedInPage(code)) as { readonly moduleOfText: typeof moduleOfText }
      const inPage = yield* Effect.promise(() => loaded.moduleOfText(path, loom))
      const outside = yield* Effect.promise(() => moduleOfText(path, loom))
      expect(outside.product.files.map((file) => file.path)).toEqual(['greeting.ts'])
      expect(JSON.stringify(inPage)).toBe(JSON.stringify(outside))
    }),
  )

  it.effect('is caught there when it reads a global of Node', () =>
    Effect.gen(function* () {
      const { code } = yield* bundled([leaning], false)
      const loaded = (yield* loadedInPage(code)) as { readonly workingFolder: () => string }
      const failure = yield* Effect.flip(
        Effect.try({ try: () => loaded.workingFolder(), catch: (cause) => String(cause) }),
      )
      expect(failure).toContain('process is not defined')
    }),
  )

  it.effect('weighs less than a page should wait for', () =>
    Effect.gen(function* () {
      const { code } = yield* bundled([page], true)
      const weight = Bun.gzipSync(Buffer.from(code)).length
      console.log(
        `size: a page that reads a loom loads ${(weight / 1000).toFixed(1)} kB, compressed`,
      )
      expect(weight).toBeLessThan(80_000)
    }),
  )
})
