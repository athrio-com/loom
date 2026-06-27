import { Array, Effect, Match, Option } from 'effect'
import { readdirSync, readFileSync } from 'node:fs'
import {
  basename,
  dirname,
  relative as relativePath,
  resolve as resolvePath,
} from 'node:path'
import {
  LoomConfig,
  parseConfig,
  type Config,
  type PackageConfig,
  type PackageEntry,
  type WorkspaceConfig,
  type WorkspaceManifest,
} from '@athrio/loom-config/LoomConfig'
import { LoomCorpusAstBuilder, ReadError, type Source } from '#ast/LoomCorpusAstBuilder'
import type { LoomDocument } from '@athrio/loom-ast/LoomAst'
import type { SectionBodyWeft } from '@athrio/loom-ast/Weft'
import type { Path } from '@athrio/loom-ast/LoomCorpusAst'

const ignored = new Set(['node_modules', '.loom', 'dist', '.git'])

const loomFiles = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (ignored.has(entry.name)) return []
    const full = resolvePath(dir, entry.name)
    return entry.isDirectory()
      ? loomFiles(full)
      : entry.name.endsWith('.loom')
        ? [full]
        : []
  })

const codeOf = (weft: SectionBodyWeft): Option.Option<string> =>
  Match.value(weft).pipe(
    Match.when({ type: 'CodeWeft' }, (code) => Option.some(code.source)),
    Match.when({ type: 'ArrowWeft' }, (arrow) =>
      Option.map(Option.fromNullable(arrow.code), (code) =>
        arrow.source.slice(
          code.position.start.offset - arrow.position.start.offset,
        ),
      ),
    ),
    Match.orElse(() => Option.none<string>()),
  )

const configBodyOf = (doc: LoomDocument): string | undefined => {
  const section = doc.sections.find(
    (s) =>
      s.heading.specifier?.type === 'Specifier' &&
      s.heading.specifier.label.value === 'Config',
  )
  return section === undefined
    ? undefined
    : Array.filterMap(section.code, codeOf).join('')
}

const diskSource: Source = {
  read: (path) =>
    Effect.try({
      try: () => readFileSync(path, 'utf8'),
      catch: (cause) => new ReadError({ path, cause }),
    }),
}

interface ConfigSource {
  readonly file: Path
  readonly config: Config
}

const isPackage = (config: Config): config is PackageConfig => 'package' in config

const entryOf = (
  workspace: string,
  source: { readonly file: Path; readonly config: PackageConfig },
): readonly [string, PackageEntry] => [
  basename(source.config.package),
  {
    corpus: relativePath(workspace, dirname(source.file)),
    output: source.config.package,
    primary: source.config.primary,
    anchor: source.config.anchor,
    settings: source.config.settings,
  },
]

const buildManifest = (
  workspace: string,
  sources: ReadonlyArray<ConfigSource>,
): WorkspaceManifest => {
  const defaults = sources
    .map((source) => source.config)
    .find((config): config is WorkspaceConfig => !isPackage(config))
  const packages = Object.fromEntries(
    sources
      .filter(
        (source): source is { file: Path; config: PackageConfig } =>
          isPackage(source.config),
      )
      .map((source) => entryOf(workspace, source)),
  )
  return {
    languages: defaults?.languages,
    primary: defaults?.primary,
    anchor: defaults?.anchor,
    settings: defaults?.settings,
    packages,
  }
}

export class ManifestBuilder extends Effect.Service<ManifestBuilder>()(
  'ManifestBuilder',
  {
    effect: Effect.gen(function* () {
      const corpus = yield* LoomCorpusAstBuilder
      const config = yield* LoomConfig

      const configAt = (file: Path): Effect.Effect<ConfigSource | undefined> =>
        corpus.build(diskSource, file).pipe(
          Effect.map((built) => {
            const body = configBodyOf(built.doc)
            if (body === undefined) return undefined
            const parsed = parseConfig(body)
            return parsed === undefined ? undefined : { file, config: parsed }
          }),
        )

      const build = (workspace: string): Effect.Effect<WorkspaceManifest> =>
        Effect.forEach(loomFiles(workspace), configAt).pipe(
          Effect.map((sources) =>
            buildManifest(
              workspace,
              sources.filter((source): source is ConfigSource => source !== undefined),
            ),
          ),
        )

      const materialize = (workspace: string): Effect.Effect<void> =>
        build(workspace).pipe(
          Effect.flatMap((manifest) => config.materialize(workspace, manifest)),
        )

      return { build, materialize }
    }),
    dependencies: [LoomCorpusAstBuilder.Default, LoomConfig.Default],
  },
) {}
