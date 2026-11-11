import { Array, Option, Order, pipe, Schema } from 'effect'
import { type LoomCorpusAst, type LoomModule } from '@athrio/loom-ast/LoomCorpusAst'

export const TocChapterSchema = Schema.Struct({
  number: Schema.String,
  title: Schema.String,
  status: Schema.optional(Schema.String),
  priority: Schema.optional(Schema.String),
  language: Schema.optional(Schema.String),
  path: Schema.String,
})
export type TocChapter = typeof TocChapterSchema.Type

export const TocPartSchema = Schema.Struct({
  number: Schema.String,
  name: Schema.String,
  chapters: Schema.Array(TocChapterSchema),
})
export type TocPart = typeof TocPartSchema.Type

export const TocDiscussionSchema = Schema.Struct({
  place: Schema.String,
  number: Schema.String,
  title: Schema.String,
  path: Schema.String,
})
export type TocDiscussion = typeof TocDiscussionSchema.Type

export const TocBackMatterSchema = Schema.Struct({
  discussions: Schema.Array(TocDiscussionSchema),
})
export type TocBackMatter = typeof TocBackMatterSchema.Type

export const TableOfContentsSchema = Schema.Struct({
  parts: Schema.Array(TocPartSchema),
  backMatter: TocBackMatterSchema,
  loose: Schema.Array(TocChapterSchema),
})
export type TableOfContents = typeof TableOfContentsSchema.Type

export const buildContents = (corpus: LoomCorpusAst): TableOfContents => {
  const modules = Array.fromIterable(corpus.modules.values())
  const chapters = Array.getSomes(Array.map(modules, chapterDeclOf))
  const parts = pipe(
    dedupeParts(Array.getSomes(Array.map(modules, partDeclOf))),
    Array.sort(byPart),
    Array.map((decl) =>
      TocPartSchema.make({
        number: decl.number,
        name: decl.name,
        chapters: chaptersUnder(chapters, identityOf(decl)),
      }),
    ),
  )
  const loose = pipe(
    Array.filter(chapters, (chapter) => chapter.partId === undefined),
    Array.map(toTocChapter),
  )
  const backMatter = TocBackMatterSchema.make({
    discussions: pipe(
      Array.getSomes(Array.map(modules, discussionDeclOf)),
      Array.sort(byDiscussion),
      Array.map(toTocDiscussion),
    ),
  })
  return TableOfContentsSchema.make({ parts, backMatter, loose })
}

type PartDecl = { readonly number: string; readonly name: string }

type Chapter = {
  readonly partId: string | undefined
  readonly number: string
  readonly title: string
  readonly status: string | undefined
  readonly priority: string | undefined
  readonly language: string | undefined
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
    Option.filter((frontmatter) => frontmatter.discussion === undefined),
    Option.flatMap((frontmatter) =>
      Option.map(Option.fromNullishOr(frontmatter.title), (title) => ({
        partId: frontmatter.part?.value ?? frontmatter.partName?.value,
        number: frontmatter.chapter?.value ?? '',
        title: title.value,
        status: frontmatter.status?.value,
        priority: frontmatter.priority?.value,
        language: frontmatter.language?.value,
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
    language: chapter.language,
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
  const units = Array.map(roman.toUpperCase().split(''), (letter) => romanUnits[letter] ?? 0)
  return pipe(
    units,
    Array.map((unit, index) => (unit < (units[index + 1] ?? 0) ? -unit : unit)),
    Array.reduce(0, (sum, unit) => sum + unit),
  )
}

const identityOf = (part: PartDecl): string => (part.number === '' ? part.name : part.number)

const dedupeParts = (decls: ReadonlyArray<PartDecl>): ReadonlyArray<PartDecl> =>
  Array.reduce(decls, [] as ReadonlyArray<PartDecl>, (kept, decl) =>
    Array.some(kept, (seen) => identityOf(seen) === identityOf(decl)) ? kept : [...kept, decl],
  )

const byPart: Order.Order<PartDecl> = Order.combineAll([
  Order.mapInput(Order.Number, (part: PartDecl) => (part.number === '' ? 1 : 0)),
  Order.mapInput(Order.Number, (part: PartDecl) =>
    part.number === '' ? 0 : romanValue(part.number),
  ),
  Order.mapInput(Order.String, (part: PartDecl) => part.name),
])

type Numbered = { readonly number: string; readonly title: string }

const byNumber: Order.Order<Numbered> = Order.combineAll([
  Order.mapInput(Order.Number, (entry: Numbered) => (entry.number === '' ? 1 : 0)),
  Order.mapInput(Order.Number, (entry: Numbered) =>
    entry.number === '' ? 0 : Number(entry.number),
  ),
  Order.mapInput(Order.String, (entry: Numbered) => entry.title),
])

const chaptersUnder = (
  chapters: ReadonlyArray<Chapter>,
  identity: string,
): ReadonlyArray<TocChapter> =>
  pipe(
    Array.filter(chapters, (chapter) => chapter.partId === identity),
    Array.sort(byNumber),
    Array.map(toTocChapter),
  )

type Discussion = {
  readonly part: PartDecl
  readonly number: string
  readonly title: string
  readonly path: string
}

export const backMatterHeading = 'Back matter'

const discussionDeclOf = (module: LoomModule): Option.Option<Discussion> =>
  pipe(
    Option.fromNullishOr(module.doc.frontmatter),
    Option.flatMap((frontmatter) =>
      pipe(
        Option.all({
          discussion: Option.fromNullishOr(frontmatter.discussion),
          title: Option.fromNullishOr(frontmatter.title),
          part: Option.fromNullishOr(frontmatter.part ?? frontmatter.partName),
        }),
        Option.map(({ discussion, title }) => ({
          part: { number: frontmatter.part?.value ?? '', name: frontmatter.partName?.value ?? '' },
          number: discussion.value,
          title: title.value,
          path: module.path,
        })),
      ),
    ),
  )

const byDiscussion: Order.Order<Discussion> = Order.combineAll([
  Order.mapInput(byPart, (discussion: Discussion) => discussion.part),
  byNumber,
])

const toTocDiscussion = (discussion: Discussion): TocDiscussion =>
  TocDiscussionSchema.make({
    place: discussion.part.number === '' ? discussion.part.name : `Part ${discussion.part.number}`,
    number: discussion.number,
    title: discussion.title,
    path: discussion.path,
  })
