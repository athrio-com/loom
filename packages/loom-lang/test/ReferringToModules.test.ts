import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
import { Array, Effect, Layer, Option } from 'effect'
import { dirname, relative } from 'node:path'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'
import { DocumentSource, LoomCompiler } from '../src/LoomCompiler'
import { LoomDiskCache } from '../src/LoomDiskCache'
import { LanguagePackages, type LanguagePackagesApi } from '../src/LanguagePackages'
import { WorkspaceSettings } from '../src/WorkspaceSettings'
import { FileSystemSource } from '../src/WorkspaceSource'

const it = effectify(it_)

const lines = (...all: ReadonlyArray<string>): string => `${all.join('\n')}\n`

const anchor = (name: string): string => `::${'['}${name}]`

const reference = (name: string, file = ''): string =>
  `${anchor(name)}${file === '' ? '' : `(${file})`}{Reference}`

const plainPaths: LanguagePackagesApi = {
  hold: () => Effect.void,
  moduleSpecifier: (request) =>
    Effect.succeed(Option.some(`'./${relative(dirname(request.from), request.to)}'`)),
}

const sourceOf = (files: Record<string, string>) => ({
  read: (path: string) => Effect.succeed(files[path] ?? ''),
  list: Option.some(() => Effect.succeed(Object.keys(files))),
})

const compilerOver = (files: Record<string, string>, packages: LanguagePackagesApi = plainPaths) =>
  Layer.provide(
    LoomCompiler.layer,
    Layer.mergeAll(
      FileSystemSource,
      LoomDiskCache.none,
      Layer.succeed(DocumentSource, {
        ...sourceOf(files),
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
      Layer.succeed(LanguagePackages, packages),
    ),
  )

const room = lines(
  '---',
  'Language: TypeScript',
  'Package: room.ts',
  '---',
  '',
  "# Room's 2d system {Tangle}",
  '',
  '=>',
  '',
  'export const roomBuilder = { createNewRoom: () => ({ ghosts: 0 }) }',
)

const interiorWith = (reference: string): string =>
  lines(
    '---',
    'Language: TypeScript',
    'Package: interior.ts',
    '---',
    '',
    '# Interior {Tangle}',
    '',
    '=>',
    '',
    `import { roomBuilder } from ${reference}`,
    '',
    'export const spookyRoom = roomBuilder.createNewRoom()',
  )

const tangled = (
  files: Record<string, string>,
  entry: string,
  packages: LanguagePackagesApi = plainPaths,
) =>
  LoomCompiler.pipe(
    Effect.flatMap((compiler) => compiler.tangle(entry)),
    Effect.provide(compilerOver(files, packages)),
  )

const diagnosed = (files: Record<string, string>, entry: string) =>
  LoomCompiler.pipe(
    Effect.flatMap((compiler) => compiler.diagnose(entry)),
    Effect.provide(compilerOver(files)),
  )

const messagesOf = (files: Record<string, string>, entry: string) =>
  Effect.map(diagnosed(files, entry), (found) => Array.map(found, (one) => one.message))

describe('an anchor of the Reference kind refers to the module', () => {
  it.effect('writes the path to the file the name finds', () =>
    Effect.gen(function* () {
      const files = yield* tangled(
        {
          '/corpus/room.loom': room,
          '/corpus/interior.loom': interiorWith(reference("Room's 2d system")),
        },
        '/corpus/interior.loom',
      )
      expect(files.map((file) => file.path)).toEqual(['/corpus/interior.ts'])
      expect(files[0]!.content).toContain("import { roomBuilder } from './room.ts'")
      expect(files[0]!.content).not.toContain('createNewRoom: () =>')
    }),
  )

  it.effect('composes the section when the anchor carries no kind', () =>
    Effect.gen(function* () {
      const files = yield* tangled(
        {
          '/corpus/room.loom': room,
          '/corpus/interior.loom': interiorWith(anchor("Room's 2d system")),
        },
        '/corpus/interior.loom',
      )
      expect(files[0]!.content).toContain(
        'import { roomBuilder } from export const roomBuilder',
      )
    }),
  )
})

const rooms = lines(
  '---',
  'Part I: Houses',
  'Chapter 1: Rooms',
  'Language: TypeScript',
  'Package: rooms/',
  '---',
  '',
  '# Building rooms',
  '',
  'A house is built a room at a time.',
  '',
  '## The room [room.ts]',
  '',
  '=>',
  '',
  'export const roomBuilder = { createNewRoom: () => ({}) }',
  '',
  '## The door [door.ts]',
  '',
  '=>',
  '',
  'export const roomBuilder = { createNewRoom: () => ({ open: true }) }',
)

describe('a reference picks one of the files a chapter emits', () => {
  it.effect('asks for a file when the chapter emits several', () =>
    Effect.gen(function* () {
      const found = yield* diagnosed(
        { '/corpus/rooms.loom': rooms, '/corpus/interior.loom': interiorWith(reference('Rooms')) },
        '/corpus/interior.loom',
      )
      expect(found.map((one) => one.message)).toEqual([
        '`Rooms` emits `room.ts` and `door.ts`. Name the one you mean in parentheses after its name, as `(room.ts)`.',
      ])
      expect(found[0]!.fixes?.map((fix) => fix.text)).toEqual(['(room.ts)', '(door.ts)'])
    }),
  )

  it.effect('tangles the file it names in parentheses', () =>
    Effect.gen(function* () {
      const files = yield* tangled(
        {
          '/corpus/rooms.loom': rooms,
          '/corpus/interior.loom': interiorWith(reference('Rooms', 'door.ts')),
        },
        '/corpus/interior.loom',
      )
      expect(files[0]!.content).toContain("import { roomBuilder } from './rooms/door.ts'")
    }),
  )

  it.effect('refuses a file the chapter does not emit', () =>
    Effect.gen(function* () {
      expect(
        yield* messagesOf(
          {
            '/corpus/rooms.loom': rooms,
            '/corpus/interior.loom': interiorWith(reference('Rooms', 'window.ts')),
          },
          '/corpus/interior.loom',
        ),
      ).toEqual(['`Rooms` emits no `window.ts`. It emits `room.ts` and `door.ts`.'])
    }),
  )
})

const helpers = lines(
  '---',
  'Language: TypeScript',
  '---',
  '',
  '# Utilities',
  '',
  '## Helpers',
  '',
  '=>',
  '',
  'export const helper = 1',
)

const bundle = lines(
  '---',
  'Language: TypeScript',
  'Package: bundle.ts',
  '---',
  '',
  '# Bundle {Tangle}',
  '',
  '=>',
  '',
  anchor('Utilities, Helpers'),
)

const importingHelpers = (composed: boolean): string =>
  lines(
    '---',
    'Language: TypeScript',
    'Package: interior.ts',
    '---',
    '',
    '# Interior {Tangle}',
    '',
    '=>',
    '',
    ...(composed ? [anchor('Utilities, Helpers'), ''] : []),
    `import { helper } from ${reference('Utilities, Helpers')}`,
  )

describe('a section with no sink names the file it lands in', () => {
  it.effect('writes the path to the one file that composes it', () =>
    Effect.gen(function* () {
      const files = yield* tangled(
        {
          '/corpus/helpers.loom': helpers,
          '/corpus/bundle.loom': bundle,
          '/corpus/interior.loom': importingHelpers(false),
        },
        '/corpus/interior.loom',
      )
      expect(files[0]!.content).toContain("import { helper } from './bundle.ts'")
    }),
  )

  it.effect('refuses a section that lands in no file, or in the file being written', () =>
    Effect.gen(function* () {
      expect(
        yield* messagesOf(
          { '/corpus/helpers.loom': helpers, '/corpus/interior.loom': importingHelpers(false) },
          '/corpus/interior.loom',
        ),
      ).toEqual([
        '`Utilities, Helpers` has no sink and lands in no file, so no path can name it. Take `Reference` off the anchor and move it out of the import, so it composes the section.',
      ])
      expect(
        yield* messagesOf(
          { '/corpus/helpers.loom': helpers, '/corpus/interior.loom': importingHelpers(true) },
          '/corpus/interior.loom',
        ),
      ).toEqual([
        '`Utilities, Helpers` lands in the file this reference stands in, so no path can name it. Take `Reference` off the anchor and move it out of the import, so it composes the section.',
      ])
    }),
  )
})

describe('a reference waits for a module nobody has written', () => {
  it.effect('reports a name that finds nothing', () =>
    Effect.gen(function* () {
      expect(
        yield* messagesOf(
          { '/corpus/interior.loom': interiorWith(reference('Nowhere')) },
          '/corpus/interior.loom',
        ),
      ).toEqual([
        'No section or chapter is called `Nowhere`. Write one, or label this anchor `{To be settled}`.',
      ])
    }),
  )

  it.effect('notes a promised module, and refuses to tangle it', () =>
    Effect.gen(function* () {
      const files = {
        '/corpus/interior.loom': interiorWith(
          `${anchor('Nowhere')}{kind=Reference provides=roomBuilder}`,
        ),
      }
      const found = yield* diagnosed(files, '/corpus/interior.loom')
      expect(found.map((one) => [one.severity, one.message])).toEqual([
        ['info', 'Nothing is called `Nowhere` yet, so this reference names no module.'],
      ])
      const refusal = yield* Effect.flip(tangled(files, '/corpus/interior.loom'))
      expect(refusal.message).toContain('Nothing is called `Nowhere` yet')
    }),
  )
})

describe('a heading marks the file it writes once', () => {
  it.effect('faults a {Tangle} beside a sink, with a fix that removes it', () =>
    Effect.gen(function* () {
      const text = lines('---', 'Language: TypeScript', '---', '', '# Room {Tangle}[room.ts]', '', '=>', '', 'export const r = 1')
      const [fault] = yield* diagnosed({ '/corpus/room.loom': text }, '/corpus/room.loom')
      expect(fault!.message).toBe(
        'The sink `[room.ts]` already names the file this section writes. Remove `{Tangle}`.',
      )
      const at = fault!.fixes![0]!.at!
      expect(text.slice(at.start.offset, at.end.offset)).toBe('{Tangle}')
    }),
  )

  it.effect('faults a {Tangle} whose Package names a folder', () =>
    Effect.gen(function* () {
      const text = lines('---', 'Language: TypeScript', 'Package: out/', '---', '', '# Room {Tangle}', '', '=>', '', 'export const r = 1')
      expect(yield* messagesOf({ '/corpus/room.loom': text }, '/corpus/room.loom')).toEqual([
        "`{Tangle}` writes the file the chapter's `Package` names, but `out/` is a folder. Name the file in brackets instead, as `[module.ts]`.",
      ])
    }),
  )
})

describe('the editor sees the path the tangle writes', () => {
  const files = {
    '/corpus/room.loom': room,
    '/corpus/interior.loom': interiorWith(
      `${anchor("Room's 2d system")}{kind=Reference provides=roomBuilder}`,
    ),
  }

  it.effect('projects the path and maps it onto the anchor', () =>
    Effect.gen(function* () {
      const compiler = yield* LoomCompiler
      const tree = yield* compiler.compile(sourceOf(files), '/corpus/interior.loom')
      const interior = tree.embeddedCodes?.find((code) => code.id === 'interior')
      const text = interior!.snapshot.getText(0, interior!.snapshot.getLength())
      const at = text.indexOf("'./room.ts'")
      expect(at).toBeGreaterThan(0)
      const mapped = interior!.mappings.find((mapping) => mapping.generatedOffsets[0] === at)
      expect(mapped?.sourceOffsets[0]).toBe(files['/corpus/interior.loom'].indexOf("Room's 2d system"))
    }).pipe(Effect.provide(compilerOver(files))),
  )

  it.effect('holds a contract over the file a reference names', () =>
    Effect.gen(function* () {
      const compiler = yield* LoomCompiler
      const [contract] = yield* compiler.contracts('/corpus/interior.loom')
      expect(contract?.target.path).toBe('/corpus/room.loom')
      expect(contract?.expected.map((one) => one.name)).toEqual(['roomBuilder'])
    }).pipe(Effect.provide(compilerOver(files))),
  )
})

import { afterAll, beforeAll } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import { FileSystemEnvironment } from '../src/WorkspaceSource'
import { serviceStore } from './store'
import { type LanguageService } from '@athrio/loom-lang-services/LanguageService'

const onDisk = LoomCompiler.layer.pipe(
  Layer.provideMerge(LanguagePackages.layer),
  Layer.provideMerge(DocumentSource.layer),
  Layer.provideMerge(FileSystemEnvironment),
  Layer.provideMerge(LoomConfig.layer),
)

const workspaceWith = (looms: Record<string, string>): string => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'loom-refer-')))
  mkdirSync(join(workspace, '.loom'), { recursive: true })
  mkdirSync(join(workspace, 'corpus'), { recursive: true })
  writeFileSync(
    join(workspace, '.loom', 'config.yaml'),
    lines('corpus: corpus', 'primary: typescript', 'languages:', '  typescript: {}'),
  )
  Object.entries(looms).forEach(([name, text]) => writeFileSync(join(workspace, 'corpus', name), text))
  return workspace
}

describe('the TypeScript service writes a reference end to end', () => {
  let teardown: () => void = () => undefined
  beforeAll(() => {
    teardown = serviceStore()
  }, 60_000)
  afterAll(() => teardown())

  it.effect(
    'tangles the import with the path TypeScript expects',
    () =>
      Effect.gen(function* () {
        const workspace = workspaceWith({
          'room.loom': room,
          'interior.loom': interiorWith(reference("Room's 2d system")),
        })
        const compiler = yield* LoomCompiler
        const files = yield* compiler.tangle(join(workspace, 'corpus', 'interior.loom'))
        expect(files[0]!.content).toContain("import { roomBuilder } from './room.js'")
      }).pipe(Effect.provide(onDisk)),
    60_000,
  )
})

describe('the held layer answers from the packages the server holds', () => {
  const answering: LanguageService = {
    id: 'typescript',
    displayName: 'Stand-in',
    extensions: ['.ts'],
    plugins: () => Effect.succeed([]),
    moduleSpecifier: () => Effect.succeed(Option.some("'./a.js'")),
  }

  it.effect('loads nothing, and asks what it holds', () =>
    Effect.gen(function* () {
      const workspace = workspaceWith({})
      const packages = yield* LanguagePackages
      const request = {
        language: 'typescript',
        loom: join(workspace, 'corpus', 'b.loom'),
        from: join(workspace, 'b.ts'),
        to: join(workspace, 'a.ts'),
      }
      expect(yield* packages.moduleSpecifier(request)).toEqual(Option.none())
      yield* packages.hold(workspace, [answering])
      expect(yield* packages.moduleSpecifier(request)).toEqual(Option.some("'./a.js'"))
    }).pipe(Effect.provide(LanguagePackages.held.pipe(Layer.provide(LoomConfig.layer)))),
  )
})
