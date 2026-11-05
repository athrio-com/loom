import { Array, Context, Effect, Layer, Match, Option, pipe } from 'effect'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
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
import { type Position } from '@athrio/loom-ast/LoomNode'
import { serviceVersion } from '@athrio/loom-lang-services/LoomStore'
import { LoomConfig } from '@athrio/loom-config/LoomConfig'
import { type Source } from '#ast/LoomCorpusAstBuilder'
import { type BuildSettings } from './WorkspaceSettings'

const cacheFormat = 1

const newestIn = (dir: string): number =>
  pipe(
    Option.liftThrowable(() => readdirSync(dir, { recursive: true, withFileTypes: true }))(),
    Option.map((entries) =>
      Array.reduce(entries, 0, (newest, entry) =>
        entry.isFile()
          ? Math.max(newest, statSync(join(entry.parentPath, entry.name)).mtimeMs)
          : newest,
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
  `${serviceVersion}:${Math.max(0, ...Array.map(sourceDirs(), newestIn))}`

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

interface KeptModule {
  readonly key: string
  readonly module: LoomModule
}

const cacheDirOf = (workspace: string): string => join(workspace, '.loom', 'cache')

const keptFileOf = (workspace: string, path: Location): string =>
  join(
    cacheDirOf(workspace),
    'modules',
    `${createHash('sha256').update(path).digest('hex').slice(0, 16)}.json`,
  )

interface KeptOption<A> {
  readonly _tag: string
  readonly value?: A
}

const optionOf = <A>(kept: KeptOption<A>): Option.Option<A> =>
  kept._tag === 'Some' && kept.value !== undefined ? Option.some(kept.value) : Option.none()

const revivedPart = (part: Part): Part =>
  Match.value(part).pipe(
    Match.when({ type: 'NameRef' }, (ref): Part => ({
      ...ref,
      target: optionOf(ref.target as unknown as KeptOption<SectionId>),
      toBeSettled: optionOf(ref.toBeSettled as unknown as KeptOption<Position>),
    })),
    Match.when({ type: 'ModuleRef' }, (ref): Part => ({
      ...ref,
      target: optionOf(ref.target as unknown as KeptOption<SectionId>),
      file: optionOf(ref.file as unknown as KeptOption<WrittenFile>),
      toBeSettled: optionOf(ref.toBeSettled as unknown as KeptOption<Position>),
    })),
    Match.when({ type: 'Fragment' }, (fragment): Part => fragment),
    Match.exhaustive,
  )

const revivedCode = (code: Code): Code => ({
  ...code,
  fragments: Array.map(code.fragments, revivedPart),
})

const revived = (module: LoomModule): LoomModule => ({
  ...module,
  product: {
    code: Array.map(module.product.code, revivedCode),
    files: Array.map(module.product.files, (file) => ({ ...file, code: revivedCode(file.code) })),
  },
})

const recall = (file: string, key: string, path: Location, text: string): Option.Option<LoomModule> =>
  pipe(
    Option.liftThrowable(() => JSON.parse(readFileSync(file, 'utf8')) as KeptModule)(),
    Option.filter(
      (kept) => kept.key === key && kept.module.path === path && kept.module.text === text,
    ),
    Option.map((kept) => revived(kept.module)),
  )

const write = (workspace: string, file: string, key: string, module: LoomModule): void =>
  void Option.liftThrowable(() => {
    const cacheDir = cacheDirOf(workspace)
    mkdirSync(dirname(file), { recursive: true })
    if (!existsSync(join(cacheDir, '.gitignore'))) writeFileSync(join(cacheDir, '.gitignore'), '*\n')
    const draft = `${file}.${process.pid}.tmp`
    writeFileSync(draft, JSON.stringify({ key, module } satisfies KeptModule))
    renameSync(draft, file)
  })()

const keep = (
  saved: Source,
  workspace: string,
  file: string,
  key: string,
  module: LoomModule,
): Effect.Effect<void> =>
  saved.read(module.path).pipe(
    Effect.option,
    Effect.flatMap((text) =>
      Option.contains(text, module.text)
        ? Effect.sync(() => write(workspace, file, key, module))
        : Effect.void,
    ),
  )

export class LoomDiskCache extends Context.Service<LoomDiskCache>()('LoomDiskCache', {
  make: Effect.gen(function* () {
    const fingerprint = yield* Effect.sync(fingerprintNow)
    const config = yield* LoomConfig
    return {
      through: (
        source: Source,
        saved: Source,
        path: Location,
        settings: BuildSettings,
        build: Effect.Effect<LoomModule>,
      ): Effect.Effect<LoomModule> =>
        config.resolve(path).pipe(
          Effect.flatMap(({ workspaceRoot }) =>
            Option.match(Option.fromNullishOr(workspaceRoot), {
              onNone: () => build,
              onSome: (workspace) =>
                source.read(path).pipe(
                  Effect.flatMap((text) => {
                    const key = keyOf(fingerprint, path, text, settings)
                    const file = keptFileOf(workspace, path)
                    return Effect.sync(() => recall(file, key, path, text)).pipe(
                      Effect.flatMap(
                        Option.match({
                          onSome: (module) => Effect.succeed(module),
                          onNone: () =>
                            build.pipe(
                              Effect.tap((module) => keep(saved, workspace, file, key, module)),
                            ),
                        }),
                      ),
                    )
                  }),
                  Effect.catchTag('ReadError', () => build),
                ),
            }),
          ),
        ),
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)

  static readonly none = Layer.succeed(this, {
    through: (
      _source: Source,
      _saved: Source,
      _path: Location,
      _settings: BuildSettings,
      build: Effect.Effect<LoomModule>,
    ): Effect.Effect<LoomModule> => build,
  })
}
