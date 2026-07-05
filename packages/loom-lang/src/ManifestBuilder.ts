import { Array, Context, Effect, Layer, Match, Option } from 'effect'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import {
  LoomConfig,
  parseConfig,
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
      Option.map(Option.fromNullishOr(arrow.code), (code) =>
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
    : Array.getSomes(Array.map(section.code, codeOf)).join('')
}

const diskSource: Source = {
  read: (path) =>
    Effect.try({
      try: () => readFileSync(path, 'utf8'),
      catch: (cause) => new ReadError({ path, cause }),
    }),
  list: Option.none(),
}

const buildManifest = (
  found: Option.Option<WorkspaceConfig>,
): WorkspaceManifest =>
  Option.match(found, {
    onNone: () => ({}),
    onSome: (config) => ({
      languages: config.languages,
      corpus: config.corpus,
      primary: config.primary,
      anchor: config.anchor,
      settings: config.settings,
    }),
  })

export class ManifestBuilder extends Context.Service<ManifestBuilder>()(
  'ManifestBuilder',
  {
    make: Effect.gen(function* () {
      const corpus = yield* LoomCorpusAstBuilder
      const config = yield* LoomConfig

      const configAt = (file: Path): Effect.Effect<Option.Option<WorkspaceConfig>> =>
        corpus.build(diskSource, file).pipe(
          Effect.map((built) =>
            Option.fromNullishOr(configBodyOf(built.doc)).pipe(
              Option.flatMap((body) => Option.fromNullishOr(parseConfig(body))),
            ),
          ),
        )

      const build = (workspace: string): Effect.Effect<WorkspaceManifest> =>
        Effect.forEach(loomFiles(workspace), configAt).pipe(
          Effect.map((configs) => buildManifest(Option.firstSomeOf(configs))),
        )

      const materialize = (workspace: string): Effect.Effect<void> =>
        build(workspace).pipe(
          Effect.flatMap((manifest) => config.materialize(workspace, manifest)),
        )

      return { build, materialize }
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(Layer.mergeAll(LoomCorpusAstBuilder.layer, LoomConfig.layer)),
  )
}
