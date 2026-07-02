import { Array, Match, Effect, Option, Order, pipe } from 'effect'
import type {
  LoomDocument,
  LoomFrontmatter,
  LoomSection,
} from '@athrio/loom-ast/LoomAst'
import {
  okHealth,
  type Health,
  type Point,
  type Position,
} from '@athrio/loom-ast/LoomNode'
import type {
  SinkToken,
  WarpAnchorToken,
  WarpToken,
} from '@athrio/loom-ast/LoomTokens'
import type { SectionBodyWeft } from '@athrio/loom-ast/Weft'
import {
  type Code,
  CodeSchema,
  type File,
  FileSchema,
  type Fragment,
  FragmentSchema,
  NameRefSchema,
  type Part,
  type Product,
  ProductSchema,
  type SectionId,
} from '@athrio/loom-ast/ProductAst'
import { sinkPathOf } from '@athrio/loom-ast/LoomCorpusAst'
import {
  AmbiguousAnchor,
  CrossLanguageAnchor,
  faulty,
  UnresolvedAnchor,
} from '#ast/LoomFault'
import { normaliseTitle } from '#ast/WeftTokeniser'

export class ProductBuilder extends Effect.Service<ProductBuilder>()(
  'ProductBuilder',
  {
    succeed: {
      build: (
        doc: LoomDocument,
        path: string,
        packageLanguage?: string,
      ): Effect.Effect<Product> =>
        Effect.sync(() => buildProduct(doc, path, packageLanguage)),
    },
  },
) {}

export const buildProduct = (
  doc: LoomDocument,
  modulePath: string,
  packageLanguage?: string,
): Product => {
  const fm = Option.fromNullable(doc.frontmatter)
  const pkg = pipe(
    fm,
    Option.flatMapNullable((f) => f.package),
    Option.map((p) => p.value),
  )
  const lang = pipe(
    frontmatterLanguage(fm),
    Option.orElse(() => Option.fromNullable(packageLanguage)),
    Option.getOrElse(() => 'plaintext'),
  )
  const index = nameIndex(doc.sections, lang, pkg)
  return pipe(
    doc.sections,
    Array.map(buildSection(index, lang, modulePath, pkg)),
    Array.reduce(emptyProduct, appendSection),
  )
}

const emptyProduct: Product = ProductSchema.make({ code: [], files: [] })

const appendSection = (product: Product, built: Built): Product =>
  ProductSchema.make({
    code: [...product.code, built.code],
    files: [...product.files, ...Option.toArray(built.file)],
  })

type NameEntry = {
  readonly name: string
  readonly pos: Position
  readonly language: string
}
type NameIndex = ReadonlyMap<string, ReadonlyArray<NameEntry>>

const reservedLanguage: Record<string, string> = { config: 'yaml' }

const specifierLanguage = (
  label: string,
  sink: Option.Option<SinkToken>,
  defaultLang: string,
  pkg: Option.Option<string>,
): string => {
  const id = label.toLowerCase()
  if (id === 'tangle')
    return Option.match(pkg, {
      onNone: () => defaultLang,
      onSome: (p) => extensionLanguage(tangleFilePath(p, sink)),
    })
  if (id === 'toc') return 'prose'
  return reservedLanguage[id] ?? id
}

const sectionLanguage = (
  section: LoomSection,
  defaultLang: string,
  pkg: Option.Option<string>,
): string => {
  const { specifier, sink } = section.heading
  if (specifier !== undefined)
    return specifierLanguage(
      specifier.label.value,
      Option.fromNullable(sink),
      defaultLang,
      pkg,
    )
  if (sink === undefined) return defaultLang
  return sink.file !== undefined ? extensionLanguage(sink.file.value) : 'prose'
}

const nameIndex = (
  sections: ReadonlyArray<LoomSection>,
  defaultLang: string,
  pkg: Option.Option<string>,
): NameIndex =>
  pipe(
    sections,
    Array.filterMap((s) =>
      Option.map(Option.fromNullable(s.heading.title), (title) =>
        [
          title.source,
          {
            name: sectionNameOf(s),
            pos: title.position,
            language: sectionLanguage(s, defaultLang, pkg),
          },
        ] as const,
      ),
    ),
    Array.reduce(
      new Map<string, ReadonlyArray<NameEntry>>(),
      (index, [title, entry]) =>
        new Map(index).set(title, [...(index.get(title) ?? []), entry]),
    ),
  )

const frontmatterLanguage = (
  frontmatter: Option.Option<LoomFrontmatter>,
): Option.Option<string> =>
  pipe(
    frontmatter,
    Option.flatMapNullable((f) => f.language),
    Option.map((l) => l.value.trim().toLowerCase()),
  )

const languageByExtension: ReadonlyMap<string, string> = new Map([
  ['ts', 'typescript'],
  ['mts', 'typescript'],
  ['cts', 'typescript'],
  ['tsx', 'tsx'],
  ['js', 'javascript'],
  ['mjs', 'javascript'],
  ['cjs', 'javascript'],
  ['jsx', 'jsx'],
  ['json', 'json'],
])

const extensionLanguage = (path: string): string => {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return languageByExtension.get(ext) ?? ext
}

interface ValueWarp {
  readonly text: string
  readonly pos: Position
}

const decodeLiteral = (text: string): string => {
  const s = text.trim()
  const quoted =
    /^"(?:\\.|[^"\\])*"$/.test(s) || /^'(?:\\.|[^'\\])*'$/.test(s)
  return quoted ? s.slice(1, -1).replace(/\\(.)/g, (_, c) => c) : text
}

const valueWarps = (
  warps: ReadonlyArray<WarpToken>,
): ReadonlyMap<string, ValueWarp> =>
  new Map(
    Array.filterMap(warps, (w) =>
      w.default
        ? Option.some([
            w.name.value,
            { text: decodeLiteral(w.default.value), pos: w.default.position },
          ] as const)
        : Option.none(),
    ),
  )

interface Built {
  readonly code: Code
  readonly file: Option.Option<File>
}

const buildSection =
  (
    index: NameIndex,
    defaultLang: string,
    modulePath: string,
    pkg: Option.Option<string>,
  ) =>
  (section: LoomSection): Built => {
    const values = valueWarps(section.preamble.flatMap((w) => w.warps))
    const origin: SectionId = { path: modulePath, name: sectionNameOf(section) }
    const languageId = sectionLanguage(section, defaultLang, pkg)
    const code = buildCode(section, values, index, origin, languageId)
    const file = tangleFile(section, pkg, code)
    return { code, file }
  }

const tangleFilePath = (
  pkg: string,
  sink: Option.Option<SinkToken>,
): string =>
  pkg.endsWith('/')
    ? pkg + Option.getOrElse(Option.map(sink, (s) => s.dir.value), () => '')
    : pkg

const tangleFile = (
  section: LoomSection,
  pkg: Option.Option<string>,
  code: Code,
): Option.Option<File> => {
  const { specifier, sink } = section.heading
  if (
    specifier !== undefined &&
    specifier.label.value.toLowerCase() === 'tangle'
  )
    return Option.map(pkg, (p) =>
      FileSchema.make({
        path: tangleFilePath(p, Option.fromNullable(sink)),
        code,
      }),
    )
  return pipe(
    Option.fromNullable(sink),
    Option.filter((s) => s.file !== undefined),
    Option.map((s) => FileSchema.make({ path: sinkPathOf(s), code })),
  )
}

const buildCode = (
  section: LoomSection,
  values: ReadonlyMap<string, ValueWarp>,
  index: NameIndex,
  origin: SectionId,
  languageId: string,
): Code => {
  const bind = bindAnchor(index, values, languageId, origin.path)
  const fragments = pipe(codeRuns(section.code), Array.flatMap(walkRun(bind)))
  return CodeSchema.make({ origin, languageId, fragments })
}

interface CodePiece {
  readonly source: string
  readonly position: Position
  readonly anchors: ReadonlyArray<WarpAnchorToken>
}

const pieceOf = (w: SectionBodyWeft): Option.Option<CodePiece> =>
  pipe(
    Match.value(w),
    Match.when({ type: 'CodeWeft' }, (c) =>
      Option.some({ source: c.source, position: c.position, anchors: c.anchors }),
    ),
    Match.when({ type: 'ArrowWeft' }, (a) =>
      Option.map(Option.fromNullable(a.code), (code) => ({
        source: a.source.slice(
          code.position.start.offset - a.position.start.offset,
        ),
        position: between(code.position.start, a.position.end),
        anchors: a.anchors,
      })),
    ),
    Match.orElse(() => Option.none<CodePiece>()),
  )

const isBlank = (p: CodePiece): boolean => p.source.trim().length === 0

const dropLeadingBlank = (
  run: ReadonlyArray<CodePiece>,
): ReadonlyArray<CodePiece> => Array.dropWhile(run, isBlank)

const dropTrailingBlank = (
  run: ReadonlyArray<CodePiece>,
): ReadonlyArray<CodePiece> =>
  pipe(run, Array.reverse, Array.dropWhile(isBlank), Array.reverse)

const trimBlank = (
  run: ReadonlyArray<CodePiece>,
): ReadonlyArray<CodePiece> => dropTrailingBlank(dropLeadingBlank(run))

const seamTrailing = (
  run: ReadonlyArray<CodePiece>,
): ReadonlyArray<CodePiece> => {
  const lead = dropLeadingBlank(run)
  const body = dropTrailingBlank(lead)
  return Option.match(Array.get(lead, body.length), {
    onNone: () => body,
    onSome: (blank) => [...body, blank],
  })
}

const sealRuns = (
  runs: ReadonlyArray<ReadonlyArray<CodePiece>>,
): ReadonlyArray<ReadonlyArray<CodePiece>> =>
  Array.map(runs, (run, i) =>
    i === runs.length - 1 ? trimBlank(run) : seamTrailing(run),
  )

const codeRuns = (
  code: ReadonlyArray<SectionBodyWeft>,
): ReadonlyArray<ReadonlyArray<CodePiece>> =>
  Array.isNonEmptyReadonlyArray(code)
    ? pipe(
        code,
        Array.groupWith((a, _b) => a.type !== 'ArrowWeft'),
        Array.map((block) => Array.filterMap(block, pieceOf)),
        Array.filter((run) => Array.some(run, (p) => !isBlank(p))),
        sealRuns,
      )
    : []

const walkRun =
  (bind: (anchor: WarpAnchorToken) => Part) =>
  (pieces: ReadonlyArray<CodePiece>): ReadonlyArray<Part> => {
    const { start, end } = spanOf(pieces)
    const text = sourceOf(pieces)
    const slice = (from: Point, to: Point): string =>
      text.slice(from.offset - start.offset, to.offset - start.offset)
    const fragment = (from: Point, to: Point): ReadonlyArray<Fragment> => {
      const lit = slice(from, to)
      return lit.length === 0
        ? []
        : [FragmentSchema.make({ text: lit, origin: between(from, to) })]
    }
    const anchors = pipe(
      pieces,
      Array.flatMap((p) => p.anchors),
      Array.sort(byStart),
    )
    const opensAt = (i: number): Point =>
      pipe(
        Array.get(anchors, i - 1),
        Option.match({ onNone: () => start, onSome: (a) => a.position.end }),
      )
    return [
      ...Array.flatMap(anchors, (anchor, i) => [
        ...fragment(opensAt(i), anchor.position.start),
        bind(anchor),
      ]),
      ...fragment(opensAt(anchors.length), end),
    ]
  }

const byStart: Order.Order<WarpAnchorToken> = Order.mapInput(
  Order.number,
  (a) => a.position.start.offset,
)

const bindAnchor =
  (
    index: NameIndex,
    values: ReadonlyMap<string, ValueWarp>,
    host: string,
    modulePath: string,
  ) =>
  (anchor: WarpAnchorToken): Part => {
    const name = anchor.name.value
    const at = anchor.name.position
    if (anchor.health.status !== 'ok') return blankFragment(anchor.position)
    const value = values.get(name)
    if (value !== undefined) {
      return FragmentSchema.make({ text: value.text, origin: at })
    }
    return Array.matchLeft(index.get(name) ?? [], {
      onEmpty: () => blankFragment(anchor.position, unresolved(name, at)),
      onNonEmpty: (entry, rest) =>
        rest.length === 0
          ? NameRefSchema.make({
              target: Option.some<SectionId>({
                path: modulePath,
                name: entry.name,
              }),
              anchor: at,
              health:
                entry.language === host
                  ? okHealth
                  : crossLanguage(name, at, host, entry.language),
            })
          : blankFragment(
              anchor.position,
              ambiguous(name, at, rest.length + 1),
            ),
    })
  }

const blankFragment = (at: Position, health: Health = okHealth): Fragment =>
  FragmentSchema.make({ text: '', origin: at, health })

const unresolved = (name: string, at: Position): Health =>
  faulty(UnresolvedAnchor({ name }), at)

const ambiguous = (name: string, at: Position, count: number): Health =>
  faulty(AmbiguousAnchor({ name, count }), at)

const crossLanguage = (
  name: string,
  at: Position,
  host: string,
  found: string,
): Health => faulty(CrossLanguageAnchor({ name, host, found }), at)

const sectionNameOf = (section: LoomSection): string =>
  normaliseTitle(section.heading.title?.source ?? '')

const sourceOf = (nodes: ReadonlyArray<{ readonly source: string }>): string =>
  nodes.map((n) => n.source).join('')

const spanOf = (
  nodes: ReadonlyArray<{ readonly position: Position }>,
): Position => ({
  start: nodes[0]!.position.start,
  end: nodes[nodes.length - 1]!.position.end,
})

const between = (start: Point, end: Point): Position => ({ start, end })
