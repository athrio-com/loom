import { Array, Option, Order, pipe, Schema } from 'effect'
import {
  bookOf,
  isBookLoom,
  type Location,
  type LoomCorpusAst,
  type LoomModule,
} from '@athrio/loom-ast/LoomCorpusAst'

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

export const TocBookSchema = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  parts: Schema.Array(TocPartSchema),
  orphans: Schema.Array(TocChapterSchema),
  backMatter: TocBackMatterSchema,
})
export type TocBook = typeof TocBookSchema.Type

export const TableOfContentsSchema = Schema.Struct({
  books: Schema.Array(TocBookSchema),
})
export type TableOfContents = typeof TableOfContentsSchema.Type

export const buildContents = (corpus: LoomCorpusAst, root?: Location): TableOfContents => {
  const modules = Array.filter(
    Array.fromIterable(corpus.modules.values()),
    (module) => module.path !== root,
  )
  const declared: Declared = {
    modules,
    parts: dedupeParts(Array.getSomes(Array.map(modules, partDeclOf))),
    chapters: Array.getSomes(Array.map(modules, chapterDeclOf)),
    discussions: Array.getSomes(Array.map(modules, discussionDeclOf)),
  }
  const defaultBook = contentsOf(declared, '')
  return TableOfContentsSchema.make({
    books: [
      ...(holdsAnything(defaultBook) ? [defaultBook] : []),
      ...Array.map(bookNamesIn(modules), (name) => contentsOf(declared, name)),
    ],
  })
}

type Declared = {
  readonly modules: ReadonlyArray<LoomModule>
  readonly parts: ReadonlyArray<PartDecl>
  readonly chapters: ReadonlyArray<Chapter>
  readonly discussions: ReadonlyArray<Discussion>
}

const contentsOf = (declared: Declared, book: string): TocBook =>
  TocBookSchema.make({
    name: book,
    path: Option.getOrElse(
      Option.map(
        Array.findFirst(
          declared.modules,
          (module) => isBookLoom(module) && bookNameOf(module) === book,
        ),
        (module) => module.path,
      ),
      () => '',
    ),
    parts: pipe(
      Array.filter(declared.parts, (decl) => decl.book === book),
      Array.sort(byPart),
      Array.map((decl) =>
        TocPartSchema.make({
          number: decl.number,
          name: decl.name,
          chapters: chaptersUnder(declared.chapters, decl),
        }),
      ),
    ),
    orphans: pipe(
      Array.filter(
        declared.chapters,
        (chapter) => chapter.book === book && chapter.partId === undefined,
      ),
      Array.sort(byNumber),
      Array.map(toTocChapter),
    ),
    backMatter: TocBackMatterSchema.make({
      discussions: pipe(
        Array.filter(declared.discussions, (discussion) => discussion.book === book),
        Array.sort(byDiscussion),
        Array.map(toTocDiscussion),
      ),
    }),
  })

const bookNamesIn = (modules: ReadonlyArray<LoomModule>): ReadonlyArray<string> =>
  pipe(
    Array.map(modules, bookNameOf),
    Array.filter((name) => name !== ''),
    Array.dedupe,
    Array.sort(Order.String),
  )

const holdsAnything = (book: TocBook): boolean =>
  book.parts.length > 0 || book.orphans.length > 0 || book.backMatter.discussions.length > 0

type PartDecl = { readonly book: string; readonly number: string; readonly name: string }

type Chapter = {
  readonly book: string
  readonly partId: string | undefined
  readonly number: string
  readonly title: string
  readonly status: string | undefined
  readonly priority: string | undefined
  readonly language: string | undefined
  readonly path: string
}

const bookNameOf = (module: LoomModule): string => Option.getOrElse(bookOf(module), () => '')

const partDeclOf = (module: LoomModule): Option.Option<PartDecl> =>
  pipe(
    Option.fromNullishOr(module.doc.frontmatter),
    Option.flatMap((frontmatter) =>
      Option.map(Option.fromNullishOr(frontmatter.partName), (partName) => ({
        book: bookNameOf(module),
        number: frontmatter.part?.value ?? '',
        name: partName.value,
      })),
    ),
  )

const firstHeadingTitle = (module: LoomModule): Option.Option<string> =>
  pipe(
    Array.findFirst(module.doc.sections, (section) => section.heading.title !== undefined),
    Option.flatMap((section) => Option.fromNullishOr(section.heading.title)),
    Option.map((title) => title.source),
  )

const chapterDeclOf = (module: LoomModule): Option.Option<Chapter> => {
  const frontmatter = module.doc.frontmatter
  return frontmatter?.discussion !== undefined || isBookLoom(module)
    ? Option.none()
    : Option.map(
        Option.orElse(
          Option.map(Option.fromNullishOr(frontmatter?.title), (title) => title.value),
          () => firstHeadingTitle(module),
        ),
        (title) => ({
          book: bookNameOf(module),
          partId: frontmatter?.part?.value ?? frontmatter?.partName?.value,
          number: frontmatter?.chapter?.value ?? '',
          title,
          status: frontmatter?.status?.value,
          priority: frontmatter?.priority?.value,
          language: frontmatter?.language?.value,
          path: module.path,
        }),
      )
}

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

const samePart = (part: PartDecl, other: PartDecl): boolean =>
  part.book === other.book && identityOf(part) === identityOf(other)

const dedupeParts = (decls: ReadonlyArray<PartDecl>): ReadonlyArray<PartDecl> =>
  Array.reduce(decls, [] as ReadonlyArray<PartDecl>, (kept, decl) =>
    Array.some(kept, (seen) => samePart(seen, decl)) ? kept : [...kept, decl],
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
  part: PartDecl,
): ReadonlyArray<TocChapter> =>
  pipe(
    Array.filter(
      chapters,
      (chapter) => chapter.book === part.book && chapter.partId === identityOf(part),
    ),
    Array.sort(byNumber),
    Array.map(toTocChapter),
  )

type Discussion = {
  readonly book: string
  readonly part: PartDecl
  readonly number: string
  readonly title: string
  readonly path: string
}

export const backMatterHeading = 'Back matter'

export const orphansHeading = 'Orphan chapters'

const discussionDeclOf = (module: LoomModule): Option.Option<Discussion> =>
  pipe(
    Option.fromNullishOr(module.doc.frontmatter),
    Option.flatMap((frontmatter) =>
      Option.map(
        Option.all({
          discussion: Option.fromNullishOr(frontmatter.discussion),
          title: Option.fromNullishOr(frontmatter.title),
        }),
        ({ discussion, title }) => ({
          book: bookNameOf(module),
          part: {
            book: bookNameOf(module),
            number: frontmatter.part?.value ?? '',
            name: frontmatter.partName?.value ?? '',
          },
          number: discussion.value,
          title: title.value,
          path: module.path,
        }),
      ),
    ),
  )

const byDiscussion: Order.Order<Discussion> = Order.combineAll([
  Order.mapInput(byPart, (discussion: Discussion) => discussion.part),
  byNumber,
])

const placeOf = (part: PartDecl): string => (part.number === '' ? part.name : `Part ${part.number}`)

const toTocDiscussion = (discussion: Discussion): TocDiscussion =>
  TocDiscussionSchema.make({
    place: placeOf(discussion.part),
    number: discussion.number,
    title: discussion.title,
    path: discussion.path,
  })
