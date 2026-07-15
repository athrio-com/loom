import { Array, Context, Effect, Layer, Match, Option, Order, pipe, Schema } from 'effect'
import type { LoomSection } from '@athrio/loom-ast/LoomAst'
import type { TocWeft } from '@athrio/loom-ast/Weft'
import {
  type LoomCorpusAst,
  type LoomModule,
  type Path,
} from '@athrio/loom-ast/LoomCorpusAst'

export const TocChapterSchema = Schema.Struct({
  number: Schema.String,
  title: Schema.String,
  status: Schema.optional(Schema.String),
  priority: Schema.optional(Schema.String),
  path: Schema.String,
})
export type TocChapter = typeof TocChapterSchema.Type

export const TocPartSchema = Schema.Struct({
  number: Schema.String,
  name: Schema.String,
  description: Schema.String,
  chapters: Schema.Array(TocChapterSchema),
})
export type TocPart = typeof TocPartSchema.Type

export const TableOfContentsSchema = Schema.Struct({
  parts: Schema.Array(TocPartSchema),
  loose: Schema.Array(TocChapterSchema),
})
export type TableOfContents = typeof TableOfContentsSchema.Type

export class TableOfContentsBuilder extends Context.Service<TableOfContentsBuilder>()(
  'TableOfContentsBuilder',
  {
    make: Effect.succeed({
      build: (corpus: LoomCorpusAst): Effect.Effect<TableOfContents> =>
        Effect.sync(() => buildContents(corpus)),
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make)
}

export const buildContents = (corpus: LoomCorpusAst): TableOfContents => {
  const modules = Array.fromIterable(corpus.modules.values())
  const descriptions = descriptionsFrom(modules)
  const chapters = Array.getSomes(Array.map(modules, chapterDeclOf))
  const parts = pipe(
    dedupeParts(Array.getSomes(Array.map(modules, partDeclOf))),
    Array.sort(byPart),
    Array.map((decl) =>
      TocPartSchema.make({
        number: decl.number,
        name: decl.name,
        description: Option.getOrElse(
          Option.fromNullishOr(descriptions.get(identityOf(decl))),
          () => '',
        ),
        chapters: chaptersUnder(chapters, identityOf(decl)),
      }),
    ),
  )
  const loose = pipe(
    Array.filter(chapters, (chapter) => chapter.partId === undefined),
    Array.map(toTocChapter),
  )
  return TableOfContentsSchema.make({ parts, loose })
}

type PartDecl = { readonly number: string; readonly name: string }

type Chapter = {
  readonly partId: string | undefined
  readonly number: string
  readonly title: string
  readonly status: string | undefined
  readonly priority: string | undefined
  readonly path: string
}

const partDeclOf = (module: LoomModule): Option.Option<PartDecl> =>
  pipe(
    Option.fromNullishOr(module.doc.frontmatter),
    Option.flatMap((frontmatter) =>
      Option.map(Option.fromNullishOr(frontmatter.partName), (partName) => ({
        number: frontmatter.part?.value ?? '',
        name: partName.value,
      })),
    ),
  )

const chapterDeclOf = (module: LoomModule): Option.Option<Chapter> =>
  pipe(
    Option.fromNullishOr(module.doc.frontmatter),
    Option.flatMap((frontmatter) =>
      Option.map(Option.fromNullishOr(frontmatter.title), (title) => ({
        partId: frontmatter.part?.value ?? frontmatter.partName?.value,
        number: frontmatter.chapter?.value ?? '',
        title: title.value,
        status: frontmatter.status?.value,
        priority: frontmatter.priority?.value,
        path: module.path,
      })),
    ),
  )

const toTocChapter = (chapter: Chapter): TocChapter =>
  TocChapterSchema.make({
    number: chapter.number,
    title: chapter.title,
    status: chapter.status,
    priority: chapter.priority,
    path: chapter.path,
  })

const romanUnits: Record<string, number> = {
  I: 1,
  V: 5,
  X: 10,
  L: 50,
  C: 100,
  D: 500,
  M: 1000,
}

const romanValue = (roman: string): number => {
  const units = Array.map(
    roman.toUpperCase().split(''),
    (letter) => romanUnits[letter] ?? 0,
  )
  return pipe(
    units,
    Array.map((unit, index) => (unit < (units[index + 1] ?? 0) ? -unit : unit)),
    Array.reduce(0, (sum, unit) => sum + unit),
  )
}

const identityOf = (part: PartDecl): string =>
  part.number === '' ? part.name : part.number

const dedupeParts = (
  decls: ReadonlyArray<PartDecl>,
): ReadonlyArray<PartDecl> =>
  Array.reduce(decls, [] as ReadonlyArray<PartDecl>, (kept, decl) =>
    Array.some(kept, (seen) => identityOf(seen) === identityOf(decl))
      ? kept
      : [...kept, decl],
  )

const byPart: Order.Order<PartDecl> = Order.combineAll([
  Order.mapInput(Order.Number, (part: PartDecl) => (part.number === '' ? 1 : 0)),
  Order.mapInput(Order.Number, (part: PartDecl) =>
    part.number === '' ? 0 : romanValue(part.number),
  ),
  Order.mapInput(Order.String, (part: PartDecl) => part.name),
])

const byChapter: Order.Order<Chapter> = Order.combineAll([
  Order.mapInput(Order.Number, (chapter: Chapter) =>
    chapter.number === '' ? 1 : 0,
  ),
  Order.mapInput(Order.Number, (chapter: Chapter) =>
    chapter.number === '' ? 0 : Number(chapter.number),
  ),
  Order.mapInput(Order.String, (chapter: Chapter) => chapter.title),
])

const chaptersUnder = (
  chapters: ReadonlyArray<Chapter>,
  identity: string,
): ReadonlyArray<TocChapter> =>
  pipe(
    Array.filter(chapters, (chapter) => chapter.partId === identity),
    Array.sort(byChapter),
    Array.map(toTocChapter),
  )

const partLabel = /^Part\s+(\S+)\s*[—–-]\s*/
const bulletMarker = /^\s*[-*]\s+\S/

const partNumberOf = (label: string): string =>
  Option.match(Option.fromNullishOr(partLabel.exec(label)), {
    onNone: () => label,
    onSome: (match) => match[1] ?? label,
  })

const bookEntries = (
  modules: ReadonlyArray<LoomModule>,
): ReadonlyArray<TocWeft> =>
  pipe(
    Array.findFirst(modules, (module) =>
      Array.some(module.doc.sections, (section) => section.entries !== undefined),
    ),
    Option.map((module) =>
      Array.flatMap(module.doc.sections, (section) => section.entries ?? []),
    ),
    Option.getOrElse((): ReadonlyArray<TocWeft> => []),
  )

type Line =
  | { readonly kind: 'part'; readonly identity: string }
  | { readonly kind: 'chapter' }
  | { readonly kind: 'prose' }

const lineOf = (entry: TocWeft): Line =>
  Option.match(Option.fromNullishOr(entry.part), {
    onSome: (part): Line => ({ kind: 'part', identity: partNumberOf(part.value) }),
    onNone: (): Line =>
      entry.chapter !== undefined || bulletMarker.test(entry.source)
        ? { kind: 'chapter' }
        : { kind: 'prose' },
  })

type Gather = {
  readonly part: Option.Option<string>
  readonly open: boolean
  readonly lines: ReadonlyArray<string>
  readonly found: ReadonlyMap<string, string>
}

const flushed = (state: Gather): ReadonlyMap<string, string> => {
  const description = state.lines.join('\n').trim()
  return Option.match(state.part, {
    onNone: () => state.found,
    onSome: (part) =>
      description.length === 0
        ? state.found
        : new Map(state.found).set(part, description),
  })
}

const descriptionsFrom = (
  modules: ReadonlyArray<LoomModule>,
): ReadonlyMap<string, string> => {
  const gathered = Array.reduce(
    bookEntries(modules),
    {
      part: Option.none<string>(),
      open: false,
      lines: [],
      found: new Map<string, string>(),
    } as Gather,
    (state, entry): Gather =>
      Match.value(lineOf(entry)).pipe(
        Match.when(
          { kind: 'part' },
          ({ identity }): Gather => ({
            part: Option.some(identity),
            open: true,
            lines: [],
            found: flushed(state),
          }),
        ),
        Match.when(
          { kind: 'chapter' },
          (): Gather => ({
            ...state,
            open: false,
            lines: [],
            found: flushed(state),
          }),
        ),
        Match.orElse(
          (): Gather =>
            state.open
              ? { ...state, lines: [...state.lines, entry.source] }
              : state,
        ),
      ),
  )
  return flushed(gathered)
}

const chapterLine = (chapter: TocChapter): string =>
  chapter.number === '' ? `- ${chapter.title}` : `${chapter.number}. ${chapter.title}`

const partBlock = (part: TocPart): string => {
  const heading =
    part.number === ''
      ? `### ${part.name}`
      : `### Part ${part.number} — ${part.name}`
  const list = pipe(part.chapters, Array.map(chapterLine), Array.join('\n'))
  const description = part.description.trim()
  return description.length === 0
    ? `${heading}\n\n${list}`
    : `${heading}\n\n${description}\n\n${list}`
}

export const renderContents = (toc: TableOfContents): string =>
  pipe(toc.parts, Array.map(partBlock), Array.join('\n\n'))

const tocSectionOf = (module: LoomModule): Option.Option<LoomSection> =>
  Array.findFirst(module.doc.sections, (section) => section.entries !== undefined)

const spliceToc = (
  module: LoomModule,
  section: LoomSection,
  toc: TableOfContents,
): string => {
  const heading = module.text
    .slice(
      section.heading.position.start.offset,
      section.heading.position.end.offset,
    )
    .trimEnd()
  const before = module.text.slice(0, section.position.start.offset)
  const tail = module.text.slice(section.position.end.offset).replace(/^\n+/, '')
  const rebuilt = `${before}${heading}\n\n${renderContents(toc)}\n`
  return tail.length === 0 ? rebuilt : `${rebuilt}\n${tail}`
}

export const rewriteBook = (
  corpus: LoomCorpusAst,
  path: Path,
  toc: TableOfContents,
): string =>
  Option.match(Option.fromNullishOr(corpus.modules.get(path)), {
    onNone: () => '',
    onSome: (module) =>
      Option.match(tocSectionOf(module), {
        onNone: () => module.text,
        onSome: (section) => spliceToc(module, section, toc),
      }),
  })
