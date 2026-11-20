import { Array, Context, Effect, Layer, Option, pipe } from 'effect'
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Location, type LoomModule } from '@athrio/loom-ast/LoomCorpusAst'
import {
  type Code,
  type Part,
  type SectionId,
  type WrittenFile,
} from '@athrio/loom-ast/ProductAst'
import { byType, type Position } from '@athrio/loom-ast/LoomNode'
import { serviceVersion } from '@athrio/loom-lang-services/LoomStore'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import { type Source } from '#ast/LoomCorpusAstBuilder'
import { type BuildSettings } from './WorkspaceSettings'
import { type Declared } from '#ast/LoomDocumentBuilder'

const cacheFormat = 3

export const declaredKey = (declared: Declared): string => JSON.stringify(declared)

export interface Built {
  readonly module: LoomModule
  readonly builtAs: string
}

const newestIn = (dir: string): number =>
  pipe(
    Option.liftThrowable(() => readdirSync(dir, { recursive: true, withFileTypes: true }))(),
    Option.map((entries) =>
      entries.reduce(
        (newest, entry) =>
          entry.isFile()
            ? Math.max(newest, statSync(join(entry.parentPath, entry.name)).mtimeMs)
            : newest,
        0,
      ),
    ),
    Option.getOrElse(() => 0),
  )

const sourceDirs = (): ReadonlyArray<string> =>
  Array.getSomes([
    Option.liftThrowable(() => dirname(fileURLToPath(import.meta.url)))(),
    Option.liftThrowable(() =>
      dirname(dirname(fileURLToPath(import.meta.resolve('@athrio/loom-ast/LoomCorpusAst')))),
    )(),
  ])

const fingerprintNow = (): string =>
  `${serviceVersion}:${Math.max(0, ...sourceDirs().map(newestIn))}`

const keyOf = (fingerprint: string, path: Location, text: string, settings: BuildSettings): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        cacheFormat,
        fingerprint,
        path,
        settings.delims,
        settings.primaryLanguage ?? null,
        settings.variables,
        text,
      ]),
    )
    .digest('hex')

interface KeptModule extends Built {
  readonly key: string
}

const cacheDirOf = (workspace: string): string => join(workspace, '.loom', 'cache')

const keptFileOf = (workspace: string, path: Location): string =>
  join(
    cacheDirOf(workspace),
    'modules',
    `${createHash('sha256').update(path).digest('hex').slice(0, 16)}.json`,
  )

const openingOf = (key: string): string => `{"key":${JSON.stringify(key)},`

interface KeptOption<A> {
  readonly _tag: string
  readonly value?: A
}

const optionOf = <A>(kept: KeptOption<A>): Option.Option<A> =>
  kept._tag === 'Some' && kept.value !== undefined ? Option.some(kept.value) : Option.none()

const revivedPart: (part: Part) => Part = byType<Part>()({
  NameRef: (ref): Part => ({
    ...ref,
    target: optionOf(ref.target as unknown as KeptOption<SectionId>),
    toBeSettled: optionOf(ref.toBeSettled as unknown as KeptOption<Position>),
  }),
  ModuleRef: (ref): Part => ({
    ...ref,
    target: optionOf(ref.target as unknown as KeptOption<SectionId>),
    file: optionOf(ref.file as unknown as KeptOption<WrittenFile>),
    toBeSettled: optionOf(ref.toBeSettled as unknown as KeptOption<Position>),
  }),
  Fragment: (fragment): Part => fragment,
})

const revivedCode = (code: Code): Code => ({
  ...code,
  fragments: code.fragments.map(revivedPart),
})

const revived = (module: LoomModule): LoomModule => ({
  ...module,
  product: {
    code: module.product.code.map(revivedCode),
    files: module.product.files.map((file) => ({ ...file, code: revivedCode(file.code) })),
  },
})

const opensWith = (file: string, opening: string): boolean =>
  Option.getOrElse(
    Option.liftThrowable(() => {
      const wanted = Buffer.from(opening)
      const held = Buffer.alloc(wanted.length)
      const descriptor = openSync(file, 'r')
      try {
        return readSync(descriptor, held, 0, wanted.length, 0) === wanted.length && held.equals(wanted)
      } finally {
        closeSync(descriptor)
      }
    })(),
    () => false,
  )

const recall = (file: string, key: string, path: Location, text: string): Option.Option<Built> =>
  pipe(
    Option.some(file),
    Option.filter((kept) => opensWith(kept, openingOf(key))),
    Option.flatMap((kept) =>
      Option.liftThrowable(() => JSON.parse(readFileSync(kept, 'latin1')) as KeptModule)(),
    ),
    Option.filter(
      (kept) => kept.key === key && kept.module.path === path && kept.module.text === text,
    ),
    Option.map((kept): Built => ({ module: revived(kept.module), builtAs: kept.builtAs })),
  )

const beyondAscii = /[\u0080-\uffff]/g

const asciiOf = (json: string): string =>
  json.replace(
    beyondAscii,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )

const write = (workspace: string, file: string, key: string, built: Built): void =>
  void Option.liftThrowable(() => {
    const cacheDir = cacheDirOf(workspace)
    mkdirSync(dirname(file), { recursive: true })
    if (!existsSync(join(cacheDir, '.gitignore'))) writeFileSync(join(cacheDir, '.gitignore'), '*\n')
    const draft = `${file}.${process.pid}.tmp`
    writeFileSync(draft, asciiOf(JSON.stringify({ key, ...built } satisfies KeptModule)), 'latin1')
    renameSync(draft, file)
  })()

const keepSaved = (
  saved: Source,
  workspace: string,
  file: string,
  key: string,
  built: Built,
): Effect.Effect<void> =>
  saved.read(built.module.path).pipe(
    Effect.option,
    Effect.flatMap((text) =>
      Option.contains(text, built.module.text)
        ? Effect.sync(() => write(workspace, file, key, built))
        : Effect.void,
    ),
  )

export class LoomDiskCache extends Context.Service<LoomDiskCache>()('LoomDiskCache', {
  make: Effect.gen(function* () {
    const fingerprint = yield* Effect.sync(fingerprintNow)
    const config = yield* LoomConfig

    const workspaceOf = (path: Location): Effect.Effect<Option.Option<string>> =>
      config
        .resolve(path)
        .pipe(Effect.map(({ workspaceRoot }) => Option.fromNullishOr(workspaceRoot)))

    return {
      recalled: (
        source: Source,
        path: Location,
        settings: BuildSettings,
      ): Effect.Effect<Option.Option<Built>> =>
        workspaceOf(path).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(Option.none<Built>()),
              onSome: (workspace) =>
                source.read(path).pipe(
                  Effect.map((text) =>
                    recall(
                      keptFileOf(workspace, path),
                      keyOf(fingerprint, path, text, settings),
                      path,
                      text,
                    ),
                  ),
                  Effect.catchTag('ReadError', () => Effect.succeed(Option.none<Built>())),
                ),
            }),
          ),
        ),

      keep: (saved: Source, settings: BuildSettings, built: Built): Effect.Effect<void> =>
        workspaceOf(built.module.path).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (workspace) =>
                keepSaved(
                  saved,
                  workspace,
                  keptFileOf(workspace, built.module.path),
                  keyOf(fingerprint, built.module.path, built.module.text, settings),
                  built,
                ),
            }),
          ),
        ),
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)

  static readonly none = Layer.succeed(this, {
    recalled: (
      _source: Source,
      _path: Location,
      _settings: BuildSettings,
    ): Effect.Effect<Option.Option<Built>> => Effect.succeed(Option.none<Built>()),
    keep: (_saved: Source, _settings: BuildSettings, _built: Built): Effect.Effect<void> =>
      Effect.void,
  })
}
