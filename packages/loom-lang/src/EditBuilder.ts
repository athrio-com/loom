import { Array, Data, Match, Option, Order, pipe, Result, Schema } from 'effect'
import {
  isVariableName,
  NotAVariableName,
  type WorkspaceManifest,
} from '@athrio/loom-config/LoomConfig'
import {
  ArrowTokenSchema,
  BoxFenceTokenSchema,
  chapterKind,
  closesFence,
  conclusionKind,
  discussionKind,
  DividerTokenSchema,
  type Fence,
  getProbe,
  HeadingStartTokenSchema,
  noteKind,
  openingFence,
  sectionKinds,
  TildeTokenSchema,
} from '@athrio/loom-ast/LoomTokens'
import type { LoomFrontmatter, LoomHeading, LoomSection } from '@athrio/loom-ast/LoomAst'
import { byType, type Position } from '@athrio/loom-ast/LoomNode'
import type { LoomWeft } from '@athrio/loom-ast/Weft'
import {
  bookOf,
  type Catalogue,
  catalogueOf,
  type Chapter,
  chapterOf,
  conceptRenameAt,
  type CorpusLocation,
  isBookLoom,
  type Location,
  type LoomCorpusAst,
  loomKindOf,
  type LoomModule,
  numberNamesOf,
  numberPathsOf,
  type OpenedBox,
  partNamesOf,
  partNumbersOf,
  type PartRef,
  renameAt,
} from '@athrio/loom-ast/LoomCorpusAst'
import { normaliseTitle } from '#ast/WeftTokeniser'
import { romanValue, titleOf } from './weave/TableOfContentsBuilder'
import {
  blockOf,
  boxesOfKind,
  boxText,
  NoSuchLoom,
  type Piece,
  PieceSchema,
} from './OutlineBuilder'

const AfterSchema = Schema.optional(Schema.NullOr(Schema.String))

const NewPartSchema = Schema.Struct({ name: Schema.String, after: AfterSchema })

const PartChosenSchema = Schema.optional(Schema.Union([Schema.String, NewPartSchema]))

const BodySchema = Schema.Array(PieceSchema)

export const LoomIntentSchema = Schema.TaggedUnion({
  MakeLoom: {
    uri: Schema.String,
    kind: Schema.String,
    book: Schema.String,
    part: PartChosenSchema,
    title: Schema.String,
    language: Schema.optional(Schema.String),
    after: AfterSchema,
  },
  MakeBook: { uri: Schema.String, name: Schema.String },
  MoveLoom: { uri: Schema.String, book: Schema.String, part: PartChosenSchema, after: AfterSchema },
  RemoveLoom: { uri: Schema.String },
  RetitleLoom: { uri: Schema.String, title: Schema.String },
  RenamePart: { book: Schema.String, part: Schema.String, name: Schema.String },
  MovePart: { book: Schema.String, part: Schema.String, after: AfterSchema },
  RemovePart: { book: Schema.String, part: Schema.String },
  RenameBook: { book: Schema.String, name: Schema.String },
  ReplaceSection: { uri: Schema.String, section: Schema.String, body: BodySchema },
  AddSection: {
    uri: Schema.String,
    after: AfterSchema,
    name: Schema.String,
    kind: Schema.optional(Schema.String),
    language: Schema.optional(Schema.String),
    body: BodySchema,
  },
  RemoveSection: { uri: Schema.String, section: Schema.String },
  MoveSection: { uri: Schema.String, section: Schema.String, after: AfterSchema },
  RenameSection: { uri: Schema.String, section: Schema.String, name: Schema.String },
  AddNote: { uri: Schema.String, section: Schema.String, text: Schema.String },
  ResolveNote: { uri: Schema.String, section: Schema.String, text: Schema.String },
  OpenTopic: { uri: Schema.String, name: Schema.String },
  AddMessage: {
    uri: Schema.String,
    topic: Schema.String,
    author: Schema.String,
    text: Schema.String,
  },
  Conclude: { uri: Schema.String, topic: Schema.String, text: Schema.String },
  SetVariable: { name: Schema.String, value: Schema.String },
})
export type LoomIntent = typeof LoomIntentSchema.Type

type Intent<Tag extends LoomIntent['_tag']> = Extract<LoomIntent, { readonly _tag: Tag }>

type PartChosen = Intent<'MakeLoom'>['part']

export type Splice = {
  readonly path: Location
  readonly start: number
  readonly end: number
  readonly text: string
}

export type MadeLoom = { readonly path: Location; readonly text: string }

export type Setting = { readonly path: ReadonlyArray<string>; readonly value: string }

export type LoomEdit = {
  readonly made: ReadonlyArray<MadeLoom>
  readonly splices: ReadonlyArray<Splice>
  readonly gone: ReadonlyArray<Location>
  readonly configuration: Option.Option<Setting>
}

const sameSpan = (one: Splice, other: Splice): boolean =>
  one.path === other.path && one.start === other.start && one.end === other.end

const editOf = (splices: ReadonlyArray<Splice>, gone: ReadonlyArray<Location> = []): LoomEdit => ({
  made: [],
  splices: Array.dedupeWith(splices, sameSpan),
  gone,
  configuration: Option.none(),
})

const lastFirst: Order.Order<Splice> = Order.mapInput(
  Order.Number,
  (splice: Splice) => -splice.start,
)

export const splicedText = (text: string, splices: ReadonlyArray<Splice>): string =>
  Array.sort(splices, lastFirst).reduce(
    (done, splice) => done.slice(0, splice.start) + splice.text + done.slice(splice.end),
    text,
  )

export class LoomExists extends Data.TaggedError('LoomExists')<{ readonly path: Location }> {}

export class NoSuchBook extends Data.TaggedError('NoSuchBook')<{ readonly book: string }> {}

export class BookExists extends Data.TaggedError('BookExists')<{ readonly book: string }> {}

export class NoSuchPart extends Data.TaggedError('NoSuchPart')<{
  readonly book: string
  readonly part: string
}> {}

export class PartExists extends Data.TaggedError('PartExists')<{
  readonly book: string
  readonly part: string
}> {}

export class TitleTaken extends Data.TaggedError('TitleTaken')<{
  readonly title: string
  readonly book: string
  readonly part: string
}> {}

export class PartNameIsNumber extends Data.TaggedError('PartNameIsNumber')<{
  readonly name: string
}> {}

export class NotInPart extends Data.TaggedError('NotInPart')<{ readonly path: Location }> {}

export class NotOfKind extends Data.TaggedError('NotOfKind')<{
  readonly path: Location
  readonly kind: string
}> {}

export class NoSuchSection extends Data.TaggedError('NoSuchSection')<{
  readonly path: Location
  readonly section: string
}> {}

export class SectionExists extends Data.TaggedError('SectionExists')<{
  readonly path: Location
  readonly section: string
}> {}

export class OpensTheLoom extends Data.TaggedError('OpensTheLoom')<{
  readonly path: Location
  readonly section: string
}> {}

export class NoSuchNote extends Data.TaggedError('NoSuchNote')<{
  readonly path: Location
  readonly section: string
  readonly text: string
}> {}

export class NotADiscussion extends Data.TaggedError('NotADiscussion')<{
  readonly path: Location
}> {}

export class UnfitName extends Data.TaggedError('UnfitName')<{ readonly name: string }> {}

export class UnfitText extends Data.TaggedError('UnfitText')<{ readonly line: string }> {}

export class OpensABook extends Data.TaggedError('OpensABook')<{ readonly path: Location }> {}

export class NoConfiguration extends Data.TaggedError('NoConfiguration')<{
  readonly workspace: Location
}> {}

export class EditBreaksLoom extends Data.TaggedError('EditBreaksLoom')<{
  readonly path: Location
  readonly problems: ReadonlyArray<string>
}> {}

export type EditRefusal =
  | NoSuchLoom
  | LoomExists
  | NoSuchBook
  | BookExists
  | NoSuchPart
  | PartExists
  | PartNameIsNumber
  | TitleTaken
  | NotInPart
  | NotOfKind
  | NoSuchSection
  | SectionExists
  | OpensTheLoom
  | NoSuchNote
  | NotADiscussion
  | UnfitName
  | UnfitText
  | OpensABook
  | NoConfiguration
  | NotAVariableName

export type EditContext = {
  readonly corpus: LoomCorpusAst
  readonly workspace: Location
  readonly manifest: Option.Option<WorkspaceManifest>
  readonly locate: (uri: string) => Location
}

const loomAt = (corpus: LoomCorpusAst, path: Location): Result.Result<LoomModule, NoSuchLoom> =>
  Result.fromOption(Option.fromNullishOr(corpus.modules.get(path)), () => new NoSuchLoom({ path }))

const fitName = (name: string): Result.Result<string, UnfitName> =>
  name.trim() === '' || /[\r\n]/.test(name)
    ? Result.fail(new UnfitName({ name }))
    : Result.succeed(name.trim())

const fitChosen = (name: string | undefined): Result.Result<Option.Option<string>, UnfitName> =>
  Option.match(Option.fromNullishOr(name), {
    onNone: () => Result.succeed(Option.none()),
    onSome: (given) => Result.map(fitName(given), Option.some),
  })

type Spot = Data.TaggedEnum<{
  First: {}
  Last: {}
  After: { readonly name: string }
}>

const Spot = Data.taggedEnum<Spot>()

const spotOf = Match.type<string | null | undefined>().pipe(
  Match.withReturnType<Spot>(),
  Match.when(Match.undefined, () => Spot.Last()),
  Match.when(Match.null, () => Spot.First()),
  Match.orElse((name) => Spot.After({ name })),
)

const spotIndex = <Item>(
  items: ReadonlyArray<Item>,
  spot: Spot,
  answers: (item: Item, name: string) => boolean,
): Option.Option<number> =>
  Spot.$match(spot, {
    First: () => Option.some(0),
    Last: () => Option.some(items.length),
    After: ({ name }) =>
      Option.map(
        Array.findFirstIndex(items, (item) => answers(item, name)),
        (at) => at + 1,
      ),
  })

const spotName = (spot: Spot): string =>
  Spot.$match(spot, { First: () => '', Last: () => '', After: ({ name }) => name })

const namesItself = (spot: Spot, itself: (name: string) => boolean): boolean =>
  Spot.$match(spot, { First: () => false, Last: () => false, After: ({ name }) => itself(name) })

const lineStartsOf = (text: string): ReadonlyArray<number> => [
  0,
  ...Array.fromIterable(text.matchAll(/\n/g)).map((found) => found.index + 1),
]

const breakLength = (found: RegExpExecArray | null): number =>
  Option.match(Option.fromNullishOr(found), { onNone: () => 0, onSome: (line) => line[0].length })

const breakAt = (text: string, at: number): number =>
  breakLength(/^\r?\n/.exec(text.slice(at, at + 2)))

const breakBefore = (text: string, at: number): number =>
  breakLength(/\r?\n$/.exec(text.slice(Math.max(0, at - 2), at)))

const blankBefore = (text: string, at: number): boolean => {
  const last = breakBefore(text, at)
  return last > 0 && breakBefore(text, at - last) > 0
}

const afterWords = (text: string, at: number): number => {
  const words = text.slice(0, at).replace(/[\r\n]+$/, '').length
  return words + breakAt(text, words)
}

const lineSpanOf = (
  text: string,
  line: number,
): { readonly start: number; readonly end: number } => {
  const starts = lineStartsOf(text)
  return {
    start: Option.getOrElse(Array.get(starts, line - 1), () => text.length),
    end: Option.getOrElse(Array.get(starts, line), () => text.length),
  }
}

const blockAt = (text: string, at: number, block: string): string => {
  const before = at === 0 || breakBefore(text, at) > 0 ? '' : '\n'
  const after = at === text.length || breakAt(text, at) > 0 ? '' : '\n'
  return `${before}\n${block}\n${after}`
}

const blockBefore = (text: string, at: number, block: string): string =>
  `${at > 0 && !blankBefore(text, at) ? '\n' : ''}${block}\n\n`

const contentEnd = (lines: ReadonlyArray<LoomWeft>, fallback: number): number =>
  Option.getOrElse(
    Option.map(
      Array.findLast(lines, (line) => line.source.trim() !== ''),
      (line) => line.position.end.offset,
    ),
    () => fallback,
  )

type Part = {
  readonly book: string
  readonly number: Option.Option<string>
  readonly name: Option.Option<string>
}

const bookNameOf = (chapter: Chapter): string => Option.getOrElse(chapter.book, () => '')

const placedIn = (catalogue: Catalogue, book: string): ReadonlyArray<Chapter> =>
  catalogue.chapters.filter(
    (chapter) => chapter.module.doc.frontmatter !== undefined && bookNameOf(chapter) === book,
  )

const partOf = (chapter: Chapter): Option.Option<Part> =>
  Option.isNone(chapter.part.number) && Option.isNone(chapter.part.name)
    ? Option.none()
    : Option.some({
        book: bookNameOf(chapter),
        number: chapter.part.number,
        name: chapter.part.name,
      })

const sameIdentity = (part: Part, other: Part): boolean =>
  part.book === other.book &&
  Option.match(part.number, {
    onSome: (number) => Option.contains(other.number, number),
    onNone: () =>
      Option.isNone(other.number) && Option.getOrNull(part.name) === Option.getOrNull(other.name),
  })

const standsIn =
  (part: Option.Option<Part>) =>
  (chapter: Chapter): boolean =>
    Option.match(part, {
      onNone: () => Option.isNone(partOf(chapter)),
      onSome: (asked) => Option.exists(partOf(chapter), (held) => sameIdentity(held, asked)),
    })

const byPart: Order.Order<Part> = Order.combineAll([
  Order.mapInput(Order.Number, (part: Part) => (Option.isSome(part.number) ? 0 : 1)),
  Order.mapInput(Order.Number, (part: Part) =>
    Option.match(part.number, { onNone: () => 0, onSome: romanValue }),
  ),
  Order.mapInput(Order.String, (part: Part) => Option.getOrElse(part.name, () => '')),
])

const partsOf = (catalogue: Catalogue, book: string): ReadonlyArray<Part> =>
  Array.sort(
    Array.dedupeWith(Array.getSomes(placedIn(catalogue, book).map(partOf)), sameIdentity),
    byPart,
  )

const answersTo = (part: Part, name: string): boolean =>
  Option.contains(part.number, name) || Option.contains(part.name, name)

const partNamed = (parts: ReadonlyArray<Part>, asked: string): Option.Option<Part> =>
  Option.orElse(
    Array.findFirst(parts, (part) => Option.contains(part.number, asked)),
    () => Array.findFirst(parts, (part) => Option.contains(part.name, asked)),
  )

const partAsked = (
  catalogue: Catalogue,
  book: string,
  asked: string,
): Result.Result<Part, NoSuchPart> =>
  Result.fromOption(
    partNamed(partsOf(catalogue, book), asked),
    () => new NoSuchPart({ book, part: asked }),
  )

const knownBook = (catalogue: Catalogue, book: string): Result.Result<string, NoSuchBook> =>
  book === '' || catalogue.books.has(book)
    ? Result.succeed(book)
    : Result.fail(new NoSuchBook({ book }))

const refOf = (part: Part): PartRef => ({
  book: part.book === '' ? Option.none() : Option.some(part.book),
  number: part.number,
  name: part.name,
})

const isNumberedPart = (part: Part): boolean => Option.isSome(part.number)

const numbersParts = (parts: ReadonlyArray<Part>): boolean =>
  parts.length === 0 || parts.some(isNumberedPart)

const partLabel = (part: Part): string =>
  Option.getOrElse(
    Option.orElse(part.number, () => part.name),
    () => '',
  )

const numberOf = (chapter: Chapter): Option.Option<number> =>
  Option.filter(
    Option.map(chapter.number, (written) => Number.parseInt(written, 10)),
    Number.isFinite,
  )

const byNumber: Order.Order<Chapter> = Order.combineAll([
  Order.mapInput(Order.Number, (chapter: Chapter) =>
    Option.getOrElse(numberOf(chapter), () => Infinity),
  ),
  Order.mapInput(Order.String, (chapter: Chapter) => chapter.title),
])

const siblingsOf = (
  catalogue: Catalogue,
  book: string,
  part: Option.Option<Part>,
  kind: string,
): ReadonlyArray<Chapter> =>
  Array.sort(
    placedIn(catalogue, book).filter((chapter) => chapter.kind === kind && standsIn(part)(chapter)),
    byNumber,
  )

const isNumbered = (chapter: Chapter): boolean => Option.isSome(numberOf(chapter))

const numbersItself = (siblings: ReadonlyArray<Chapter>): boolean =>
  siblings.length === 0 || siblings.some(isNumbered)

type Slot = { readonly path: Location; readonly number: Option.Option<number> }

const slotOf = (chapter: Chapter): Slot => ({
  path: chapter.module.path,
  number: numberOf(chapter),
})

const renumbered = (slots: ReadonlyArray<Slot>, from: number): ReadonlyMap<Location, number> => {
  const first =
    Option.getOrElse(
      Option.flatMap(Array.get(slots, from - 1), (slot) => slot.number),
      () => 0,
    ) + 1
  return new Map(
    Array.getSomes(
      slots
        .slice(from)
        .map((slot, at) =>
          Option.contains(slot.number, first + at)
            ? Option.none()
            : Option.some([slot.path, first + at] as const),
        ),
    ),
  )
}

type Placing = {
  readonly number: Option.Option<number>
  readonly numbers: ReadonlyMap<Location, number>
}

type Sequence = {
  readonly book: string
  readonly part: Option.Option<Part>
  readonly kind: string
  readonly siblings: ReadonlyArray<Chapter>
  readonly moving: Slot
  readonly earliest: Option.Option<number>
}

type Following = Result.Result<number, NotInPart | NotOfKind>

const afterLoom = (
  catalogue: Catalogue,
  sequence: Sequence,
  numbered: ReadonlyArray<Slot>,
  path: Location,
): Following =>
  pipe(
    Option.map(
      Array.findFirstIndex(numbered, (slot) => slot.path === path),
      (at) => at + 1,
    ),
    Option.orElse(() =>
      Option.as(
        Array.findFirst(sequence.siblings, (sibling) => sibling.module.path === path),
        numbered.length,
      ),
    ),
    Option.map((at): Following => Result.succeed(at)),
    Option.orElse(() =>
      Option.as(
        Option.filter(
          chapterOf(catalogue, path),
          (chapter) =>
            chapter.kind !== sequence.kind &&
            bookNameOf(chapter) === sequence.book &&
            standsIn(sequence.part)(chapter),
        ),
        Result.fail(new NotOfKind({ path, kind: sequence.kind })),
      ),
    ),
    Option.getOrElse((): Following => Result.fail(new NotInPart({ path }))),
  )

const placing = (
  context: EditContext,
  sequence: Sequence,
  spot: Spot,
): Result.Result<Placing, NotInPart | NotOfKind> => {
  const { siblings, moving, earliest } = sequence
  if (!numbersItself(siblings)) return Result.succeed({ number: Option.none(), numbers: new Map() })
  const numbered = siblings.filter(isNumbered).map(slotOf)
  return Result.map(
    Spot.$match(spot, {
      First: (): Following => Result.succeed(0),
      Last: (): Following => Result.succeed(numbered.length),
      After: ({ name }) =>
        afterLoom(catalogueOf(context.corpus.modules), sequence, numbered, context.locate(name)),
    }),
    (at) => {
      const numbers = renumbered(
        [...numbered.slice(0, at), moving, ...numbered.slice(at)],
        Math.min(
          at,
          Option.getOrElse(earliest, () => at),
        ),
      )
      return {
        number: Option.orElse(Option.fromNullishOr(numbers.get(moving.path)), () => moving.number),
        numbers: new Map([...numbers].filter(([path]) => path !== moving.path)),
      }
    },
  )
}

const gapNumbers = (catalogue: Catalogue, chapter: Chapter): ReadonlyMap<Location, number> => {
  const numbered = siblingsOf(catalogue, bookNameOf(chapter), partOf(chapter), chapter.kind).filter(
    isNumbered,
  )
  return Option.match(
    Array.findFirstIndex(numbered, (sibling) => sibling.module.path === chapter.module.path),
    {
      onNone: () => new Map(),
      onSome: (at) =>
        renumbered(
          numbered.filter((sibling) => sibling.module.path !== chapter.module.path).map(slotOf),
          at,
        ),
    },
  )
}

const foldedTitle = (title: string): string =>
  Option.getOrElse(
    Option.fromNullishOr(title.toLowerCase().match(/[\p{L}\p{N}]+/gu)),
    () => [],
  ).join(' ')

const titleFree = (
  catalogue: Catalogue,
  book: string,
  part: Option.Option<Part>,
  title: string,
  keeping: Option.Option<Location>,
): Result.Result<string, TitleTaken> =>
  Option.match(part, {
    onNone: () => Result.succeed(title),
    onSome: (held) =>
      placedIn(catalogue, book).some(
        (chapter) =>
          standsIn(part)(chapter) &&
          foldedTitle(chapter.title) === foldedTitle(title) &&
          !Option.contains(keeping, chapter.module.path),
      )
        ? Result.fail(new TitleTaken({ title, book, part: partLabel(held) }))
        : Result.succeed(title),
  })

type Placed = {
  readonly book: string
  readonly part: Option.Option<Part>
  readonly number: Option.Option<number>
}

const partLines = (part: Option.Option<Part>): ReadonlyArray<string> =>
  Option.match(
    Option.flatMap(part, (held) => Option.map(held.name, (name) => ({ held, name }))),
    {
      onNone: () => [],
      onSome: ({ held, name }) => [
        Option.match(held.number, {
          onNone: () => `Part: ${name}`,
          onSome: (number) => `Part ${number}: ${name}`,
        }),
      ],
    },
  )

const identityLine = (word: string, title: string, placed: Placed): string => {
  const own = Option.match(placed.number, {
    onNone: () => word,
    onSome: (number) => `${word} ${number}`,
  })
  return Option.match(
    Option.flatMap(placed.part, (part) => (Option.isNone(part.name) ? part.number : Option.none())),
    {
      onNone: () => `${own}: ${title}`,
      onSome: (number) => `Part ${number}, ${own}: ${title}`,
    },
  )
}

const placementLines = (word: string, title: string, placed: Placed): ReadonlyArray<string> => [
  ...partLines(placed.part),
  identityLine(word, title, placed),
  ...(placed.book === '' ? [] : [`Book: ${placed.book}`]),
]

const wordOf = (module: LoomModule): string =>
  module.doc.frontmatter?.trope === undefined ? loomKindOf(module) : 'Trope Chapter'

const declaredTitle = (module: LoomModule): string =>
  module.doc.frontmatter?.title?.value ?? titleOf(module)

type Spanned = { readonly position: Position }

const placingToken = (token: Spanned | undefined): Option.Option<Spanned> =>
  Option.fromNullishOr(token)

const placingTokens = (frontmatter: LoomFrontmatter): ReadonlyArray<Spanned> =>
  Array.getSomes(
    [
      frontmatter.part,
      frontmatter.partName,
      frontmatter.chapter,
      frontmatter.discussion,
      frontmatter.kind,
      frontmatter.title,
      frontmatter.book,
      frontmatter.trope,
    ].map(placingToken),
  )

const placementSplices = (module: LoomModule, placed: Placed): ReadonlyArray<Splice> => {
  const lines = placementLines(wordOf(module), declaredTitle(module), placed)
  const written = `${lines.join('\n')}\n`
  return Option.match(Option.fromNullishOr(module.doc.frontmatter), {
    onNone: () => [{ path: module.path, start: 0, end: 0, text: `---\n${written}---\n\n` }],
    onSome: (frontmatter) =>
      Array.match(
        Array.sort(
          Array.dedupe(placingTokens(frontmatter).map((token) => token.position.start.line)),
          Order.Number,
        ),
        {
          onEmpty: () => {
            const { start } = lineSpanOf(module.text, frontmatter.position.start.line + 1)
            return [{ path: module.path, start, end: start, text: written }]
          },
          onNonEmpty: ([first, ...rest]) => [
            { path: module.path, ...lineSpanOf(module.text, first), text: written },
            ...rest.map((line) => ({
              path: module.path,
              ...lineSpanOf(module.text, line),
              text: '',
            })),
          ],
        },
      ),
  })
}

type Moves = {
  readonly numbers: ReadonlyMap<Location, number>
  readonly placed: ReadonlyMap<Location, Placed>
  readonly parts: ReadonlyArray<readonly [Part, number]>
  readonly leaving: ReadonlyMap<Location, Leaving>
}

const withNumber = (written: string, number: number): string =>
  written.replace(/\S+$/, String(number))

const spliceAt = (
  corpus: LoomCorpusAst,
  location: CorpusLocation,
  text: (written: string) => string,
): Option.Option<Splice> =>
  Option.map(Option.fromNullishOr(corpus.modules.get(location.path)), (module) => ({
    path: location.path,
    start: location.position.start.offset,
    end: location.position.end.offset,
    text: text(module.text.slice(location.position.start.offset, location.position.end.offset)),
  }))

const inFrontmatterOf = (corpus: LoomCorpusAst, location: CorpusLocation): boolean =>
  Option.exists(
    Option.flatMap(Option.fromNullishOr(corpus.modules.get(location.path)), (module) =>
      Option.fromNullishOr(module.doc.frontmatter),
    ),
    (frontmatter) => location.position.start.offset <= frontmatter.position.end.offset,
  )

const numberSplices = (corpus: LoomCorpusAst, moves: Moves): ReadonlyArray<Splice> =>
  Array.fromIterable(moves.numbers).flatMap(([path, number]) =>
    Array.getSomes(
      numberNamesOf(corpus, path)
        .filter(
          (location) => !(moves.placed.has(location.path) && inFrontmatterOf(corpus, location)),
        )
        .map((location) => spliceAt(corpus, location, (written) => withNumber(written, number))),
    ),
  )

const partMark = (module: LoomModule, number: number): Option.Option<Splice> =>
  Option.flatMap(Option.fromNullishOr(module.doc.frontmatter), (frontmatter) =>
    Option.match(Option.fromNullishOr(frontmatter.part), {
      onSome: (part) =>
        Option.some({
          path: module.path,
          start: part.position.start.offset,
          end: part.position.end.offset,
          text: `Part ${romanOf(number)}`,
        }),
      onNone: () =>
        Option.map(Option.fromNullishOr(frontmatter.partName), (name) => {
          const line = lineSpanOf(module.text, name.position.start.line)
          const at =
            line.start + module.text.slice(line.start, line.end).indexOf('Part') + 'Part'.length
          return { path: module.path, start: at, end: at, text: ` ${romanOf(number)}` }
        }),
    }),
  )

const partSplices = (
  corpus: LoomCorpusAst,
  placed: ReadonlyMap<Location, Placed>,
  part: Part,
  number: number,
): ReadonlyArray<Splice> => [
  ...Array.getSomes(
    placedIn(catalogueOf(corpus.modules), part.book)
      .filter((chapter) => standsIn(Option.some(part))(chapter) && !placed.has(chapter.module.path))
      .map((chapter) => partMark(chapter.module, number)),
  ),
  ...(Option.isSome(part.number)
    ? Array.getSomes(
        partNumbersOf(corpus, refOf(part)).map((location) =>
          spliceAt(corpus, location, () => `Part ${romanOf(number)}`),
        ),
      )
    : []),
]

const covers = (outer: Splice, inner: Splice): boolean =>
  outer.path === inner.path && outer.start <= inner.start && inner.end <= outer.end

const splicesOf = (corpus: LoomCorpusAst, moves: Moves): ReadonlyArray<Splice> => {
  const paths = pathSplices(corpus, moves.leaving)
  return [
    ...paths,
    ...[
      ...numberSplices(corpus, moves),
      ...Array.fromIterable(moves.placed).flatMap(([path, placed]) =>
        Option.match(Option.fromNullishOr(corpus.modules.get(path)), {
          onNone: (): ReadonlyArray<Splice> => [],
          onSome: (module) => placementSplices(module, placed),
        }),
      ),
      ...moves.parts.flatMap(([part, number]) => partSplices(corpus, moves.placed, part, number)),
    ].filter((splice) => !paths.some((path) => covers(path, splice))),
  ]
}

const romanUnits: ReadonlyArray<readonly [number, string]> = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
]

export const romanOf = (value: number): string =>
  romanUnits.reduce(
    ({ left, written }, [unit, letters]) => ({
      left: left % unit,
      written: written + letters.repeat(Math.floor(left / unit)),
    }),
    { left: value, written: '' },
  ).written

const partValue = (part: Part): number =>
  Option.match(part.number, { onNone: () => 0, onSome: romanValue })

const readsAsNumber = (name: string): boolean =>
  /^[IVXLCDM]+$/.test(name) && romanOf(romanValue(name)) === name

const partNumbers = (
  before: ReadonlyArray<Part>,
  after: ReadonlyArray<Part>,
): ReadonlyArray<readonly [Part, number]> => {
  const from = Option.getOrElse(
    Array.findFirstIndex(
      after,
      (part, at) => !Option.exists(Array.get(before, at), (held) => sameIdentity(held, part)),
    ),
    () => after.length,
  )
  const first = Option.getOrElse(Option.map(Array.get(after, from - 1), partValue), () => 0) + 1
  return after.slice(from).map((part, at) => [part, first + at] as const)
}

type Numbering = {
  readonly parts: ReadonlyArray<readonly [Part, number]>
  readonly final: (part: Part) => Part
}

const numbering = (numbers: ReadonlyArray<readonly [Part, number]>): Numbering => ({
  parts: numbers.filter(([part, number]) => partValue(part) !== number),
  final: (part) =>
    Option.match(
      Array.findFirst(numbers, ([held]) => sameIdentity(held, part)),
      {
        onNone: () => part,
        onSome: ([, number]) => ({ ...part, number: Option.some(romanOf(number)) }),
      },
    ),
})

type Leaving = Data.TaggedEnum<{
  Moving: { readonly placed: Placed }
  Going: {}
}>

const Leaving = Data.taggedEnum<Leaving>()

const partSegment = (part: Part): string =>
  Option.match(part.number, {
    onSome: (number) => `Part ${number}`,
    onNone: () => Option.getOrElse(part.name, () => ''),
  })

const loomSegment = (chapter: Chapter, placed: Placed): string =>
  Option.match(
    Option.filter(placed.number, () => Option.isSome(placed.part)),
    {
      onSome: (number) => `${chapter.kind} ${number}`,
      onNone: () => chapter.title,
    },
  )

const bookSegments = (
  placed: Placed,
  named: boolean,
  home: string,
): Option.Option<ReadonlyArray<string>> =>
  named || placed.book !== home
    ? Option.map(
        Option.liftPredicate(placed.book, (book) => book !== ''),
        (book) => [book],
      )
    : Option.some([])

const pathFor = (chapter: Chapter, placed: Placed, named: boolean, home: string): string =>
  Option.match(bookSegments(placed, named, home), {
    onNone: () => chapter.title,
    onSome: (books) =>
      [
        ...books,
        ...Option.toArray(Option.map(placed.part, partSegment)),
        loomSegment(chapter, placed),
      ].join(', '),
  })

const homeOf = (corpus: LoomCorpusAst, path: Location): string =>
  Option.getOrElse(Option.flatMap(Option.fromNullishOr(corpus.modules.get(path)), bookOf), () => '')

const pathSplices = (
  corpus: LoomCorpusAst,
  leaving: ReadonlyMap<Location, Leaving>,
): ReadonlyArray<Splice> => {
  const catalogue = catalogueOf(corpus.modules)
  return Array.fromIterable(leaving).flatMap(([path, leaves]) =>
    Option.match(chapterOf(catalogue, path), {
      onNone: (): ReadonlyArray<Splice> => [],
      onSome: (chapter) =>
        Leaving.$match(leaves, {
          Moving: ({ placed }) =>
            Array.getSomes(
              numberPathsOf(corpus, path).map((named) =>
                spliceAt(corpus, named.location, () =>
                  pathFor(chapter, placed, named.book, homeOf(corpus, named.location.path)),
                ),
              ),
            ),
          Going: () =>
            Array.getSomes(
              numberNamesOf(corpus, path)
                .filter((location) => location.path !== path)
                .map((location) => spliceAt(corpus, location, () => chapter.title)),
            ),
        }),
    }),
  )
}

const announces = (chapter: Chapter): boolean =>
  chapter.module.doc.frontmatter?.partName !== undefined

const byPlace: Order.Order<Chapter> = Order.combineAll([
  Order.mapInput(Order.Number, (chapter: Chapter) => (chapter.kind === chapterKind ? 0 : 1)),
  byNumber,
])

const keptNamed = (
  catalogue: Catalogue,
  leaver: Chapter,
  numbers: ReadonlyMap<Location, number>,
  final: (part: Part) => Part,
): ReadonlyMap<Location, Placed> =>
  Option.match(
    pipe(
      partOf(leaver),
      Option.filter((part) => Option.isSome(part.name) && announces(leaver)),
      Option.flatMap((part) => {
        const staying = placedIn(catalogue, part.book).filter(
          (chapter) =>
            standsIn(Option.some(part))(chapter) && chapter.module.path !== leaver.module.path,
        )
        return staying.some(announces)
          ? Option.none()
          : Option.map(Array.head(Array.sort(staying, byPlace)), (heir) => ({ heir, part }))
      }),
    ),
    {
      onNone: () => new Map(),
      onSome: ({ heir, part }) =>
        new Map([
          [
            heir.module.path,
            {
              book: part.book,
              part: Option.some(final(part)),
              number: Option.orElse(Option.fromNullishOr(numbers.get(heir.module.path)), () =>
                numberOf(heir),
              ),
            },
          ],
        ]),
    },
  )

type Target = Data.TaggedEnum<{
  NoPart: {}
  Held: { readonly part: Part }
  Fresh: { readonly part: Part; readonly at: Option.Option<number> }
}>

const Target = Data.taggedEnum<Target>()

const targetPart = (target: Target): Option.Option<Part> =>
  Target.$match(target, {
    NoPart: () => Option.none(),
    Held: ({ part }) => Option.some(part),
    Fresh: ({ part }) => Option.some(part),
  })

const siblingsIn = (
  catalogue: Catalogue,
  book: string,
  target: Target,
  kind: string,
): ReadonlyArray<Chapter> =>
  Target.$is('Fresh')(target) ? [] : siblingsOf(catalogue, book, targetPart(target), kind)

const titleFreeIn = (
  catalogue: Catalogue,
  book: string,
  target: Target,
  title: string,
  keeping: Option.Option<Location>,
): Result.Result<string, TitleTaken> =>
  Target.$is('Fresh')(target)
    ? Result.succeed(title)
    : titleFree(catalogue, book, targetPart(target), title, keeping)

type PartRefusal = UnfitName | PartNameIsNumber | PartExists | NoSuchPart

const fitPartName = (
  parts: ReadonlyArray<Part>,
  book: string,
  asked: string,
  keeping: Option.Option<Part>,
): Result.Result<string, UnfitName | PartNameIsNumber | PartExists> =>
  Result.gen(function* () {
    const name = yield* fitName(asked)
    yield* readsAsNumber(name) ? Result.fail(new PartNameIsNumber({ name })) : Result.succeed(name)
    return yield* parts.some(
      (part) =>
        Option.contains(part.name, name) &&
        !Option.exists(keeping, (kept) => sameIdentity(kept, part)),
    )
      ? Result.fail(new PartExists({ book, part: name }))
      : Result.succeed(name)
  })

const newPart = (
  catalogue: Catalogue,
  book: string,
  asked: { readonly name: string; readonly after?: string | null },
): Result.Result<Target, PartRefusal> =>
  Result.gen(function* () {
    const parts = partsOf(catalogue, book)
    const name = yield* fitPartName(parts, book, asked.name, Option.none())
    const spot = spotOf(asked.after)
    const at = yield* numbersParts(parts)
      ? Result.map(
          Result.fromOption(
            spotIndex(parts.filter(isNumberedPart), spot, answersTo),
            () => new NoSuchPart({ book, part: spotName(spot) }),
          ),
          Option.some,
        )
      : Result.succeed(Option.none<number>())
    return Target.Fresh({ part: { book, number: Option.none(), name: Option.some(name) }, at })
  })

const partChosen = Match.fn(
  (_where: { readonly catalogue: Catalogue; readonly book: string }, chosen: PartChosen) => chosen,
).pipe(
  Match.withReturnType<Result.Result<Target, PartRefusal>>(),
  Match.when(Match.undefined, () => Result.succeed(Target.NoPart())),
  Match.when(Match.string, (asked, { catalogue, book }) =>
    Result.map(partAsked(catalogue, book, asked), (part) => Target.Held({ part })),
  ),
  Match.orElse((asked, { catalogue, book }) => newPart(catalogue, book, asked)),
)

const vacatedBy = (catalogue: Catalogue, leaver: Chapter): Option.Option<Part> =>
  Option.filter(
    partOf(leaver),
    (part) =>
      !placedIn(catalogue, part.book).some(
        (chapter) =>
          standsIn(Option.some(part))(chapter) && chapter.module.path !== leaver.module.path,
      ),
  )

const partsAfter = (
  numbered: ReadonlyArray<Part>,
  book: string,
  vacated: Option.Option<Part>,
  target: Target,
): ReadonlyArray<Part> => {
  const kept = numbered.filter(
    (part) => !Option.exists(vacated, (gone) => sameIdentity(gone, part)),
  )
  return Option.match(
    Option.filter(
      Option.flatMap(Option.liftPredicate(target, Target.$is('Fresh')), ({ part, at }) =>
        Option.map(at, (place) => ({ part, place })),
      ),
      ({ part }) => part.book === book,
    ),
    {
      onNone: () => kept,
      onSome: ({ part, place }) => {
        const shifted =
          place - numbered.slice(0, place).filter((held) => !kept.includes(held)).length
        return [...kept.slice(0, shifted), part, ...kept.slice(shifted)]
      },
    },
  )
}

const partNumbering = (
  catalogue: Catalogue,
  book: string,
  vacated: Option.Option<Part>,
  target: Target,
): Numbering => {
  const numbered = partsOf(catalogue, book).filter(isNumberedPart)
  return numbering(partNumbers(numbered, partsAfter(numbered, book, vacated, target)))
}

const joined = (numberings: ReadonlyArray<Numbering>): Numbering => ({
  parts: numberings.flatMap((held) => held.parts),
  final: (part) => numberings.reduce((done, held) => held.final(done), part),
})

const freePath = (context: EditContext, uri: string): Result.Result<Location, LoomExists> => {
  const path = context.locate(uri)
  return context.corpus.modules.has(path)
    ? Result.fail(new LoomExists({ path }))
    : Result.succeed(path)
}

const madeText = (
  word: string,
  title: string,
  placed: Placed,
  language: Option.Option<string>,
): string =>
  [
    '---',
    ...placementLines(word, title, placed),
    ...Option.toArray(Option.map(language, (named) => `Language: ${named}`)),
    '---',
    '',
    `# ${title}`,
    '',
  ].join('\n')

const madeLoom = (
  context: EditContext,
  intent: Intent<'MakeLoom'>,
): Result.Result<LoomEdit, EditRefusal> =>
  Result.gen(function* () {
    const catalogue = catalogueOf(context.corpus.modules)
    const path = yield* freePath(context, intent.uri)
    const book = yield* knownBook(catalogue, intent.book)
    const kind = yield* fitName(intent.kind)
    const language = yield* fitChosen(intent.language)
    const target = yield* partChosen({ catalogue, book }, intent.part)
    const title = yield* fitName(intent.title)
    yield* titleFreeIn(catalogue, book, target, title, Option.none())
    const parts = partNumbering(catalogue, book, Option.none(), target)
    const placement = yield* placing(
      context,
      {
        book,
        part: targetPart(target),
        kind,
        siblings: siblingsIn(catalogue, book, target, kind),
        moving: { path, number: Option.none() },
        earliest: Option.none(),
      },
      spotOf(intent.after),
    )
    const placed: Placed = {
      book,
      part: Option.map(targetPart(target), parts.final),
      number: placement.number,
    }
    return {
      made: [{ path, text: madeText(kind, title, placed, language) }],
      splices: splicesOf(context.corpus, {
        numbers: placement.numbers,
        placed: new Map(),
        parts: parts.parts,
        leaving: new Map(),
      }),
      gone: [],
      configuration: Option.none(),
    }
  })

const bookOpened = (corpus: LoomCorpusAst, book: string): boolean =>
  Array.fromIterable(corpus.modules.values()).some(
    (module) => isBookLoom(module) && Option.contains(bookOf(module), book),
  )

const madeBook = (
  context: EditContext,
  intent: Intent<'MakeBook'>,
): Result.Result<LoomEdit, EditRefusal> =>
  Result.gen(function* () {
    const path = yield* freePath(context, intent.uri)
    const name = yield* fitName(intent.name)
    yield* bookOpened(context.corpus, name)
      ? Result.fail(new BookExists({ book: name }))
      : Result.succeed(name)
    return {
      made: [{ path, text: ['---', `Book: ${name}`, '---', '', `# ${name}`, ''].join('\n') }],
      splices: [],
      gone: [],
      configuration: Option.none(),
    }
  })

const staysPut = (context: EditContext, path: Location, spot: Spot): boolean =>
  namesItself(spot, (uri) => context.locate(uri) === path)

const movedLoom = (
  context: EditContext,
  intent: Intent<'MoveLoom'>,
): Result.Result<LoomEdit, EditRefusal> =>
  Result.gen(function* () {
    const catalogue = catalogueOf(context.corpus.modules)
    const path = context.locate(intent.uri)
    const module = yield* loomAt(context.corpus, path)
    const chapter = yield* Result.fromOption(
      Option.filter(chapterOf(catalogue, path), () => !isBookLoom(module)),
      () => new OpensABook({ path }),
    )
    const book = yield* knownBook(catalogue, intent.book)
    const target = yield* partChosen({ catalogue, book }, intent.part)
    yield* titleFreeIn(catalogue, book, target, chapter.title, Option.some(path))
    const spot = spotOf(intent.after)
    const stays =
      bookNameOf(chapter) === book &&
      Target.$match(target, {
        NoPart: () => Option.isNone(partOf(chapter)),
        Held: ({ part }) => standsIn(Option.some(part))(chapter),
        Fresh: () => false,
      })
    return yield* stays && staysPut(context, path, spot)
      ? Result.succeed(editOf([]))
      : moved(context, { catalogue, chapter, book, target, stays, spot })
  })

type Move = {
  readonly catalogue: Catalogue
  readonly chapter: Chapter
  readonly book: string
  readonly target: Target
  readonly stays: boolean
  readonly spot: Spot
}

const moved = (context: EditContext, move: Move): Result.Result<LoomEdit, EditRefusal> =>
  Result.gen(function* () {
    const { catalogue, chapter, book, target, stays, spot } = move
    const path = chapter.module.path
    const left = bookNameOf(chapter)
    const vacated = stays ? Option.none<Part>() : vacatedBy(catalogue, chapter)
    const parts = joined([
      partNumbering(catalogue, left, vacated, left === book ? target : Target.NoPart()),
      ...(left === book ? [] : [partNumbering(catalogue, book, Option.none(), target)]),
    ])
    const siblings = siblingsIn(catalogue, book, target, chapter.kind)
    const placement = yield* placing(
      context,
      {
        book,
        part: targetPart(target),
        kind: chapter.kind,
        siblings: siblings.filter((sibling) => sibling.module.path !== path),
        moving: stays ? slotOf(chapter) : { path, number: Option.none() },
        earliest: stays
          ? Array.findFirstIndex(
              siblings.filter(isNumbered),
              (sibling) => sibling.module.path === path,
            )
          : Option.none(),
      },
      spot,
    )
    const numbers = new Map([
      ...(stays ? [] : gapNumbers(catalogue, chapter)),
      ...placement.numbers,
      ...(stays
        ? Option.toArray(
            Option.filter(
              Option.map(placement.number, (number) => [path, number] as const),
              ([, number]) => !Option.contains(numberOf(chapter), number),
            ),
          )
        : []),
    ])
    const placed: Placed = {
      book,
      part: Option.map(targetPart(target), parts.final),
      number: placement.number,
    }
    return editOf(
      splicesOf(context.corpus, {
        numbers,
        placed: stays
          ? new Map()
          : new Map([...keptNamed(catalogue, chapter, numbers, parts.final), [path, placed]]),
        parts: parts.parts,
        leaving: stays ? new Map() : new Map([[path, Leaving.Moving({ placed })]]),
      }),
    )
  })

const outside =
  (paths: ReadonlyArray<Location>) =>
  (splice: Splice): boolean =>
    !Array.contains(paths, splice.path)

const removedLoom = (
  context: EditContext,
  intent: Intent<'RemoveLoom'>,
): Result.Result<LoomEdit, EditRefusal> =>
  Result.gen(function* () {
    const catalogue = catalogueOf(context.corpus.modules)
    const path = context.locate(intent.uri)
    yield* loomAt(context.corpus, path)
    return Option.match(chapterOf(catalogue, path), {
      onNone: () => editOf([], [path]),
      onSome: (chapter) => {
        const numbers = gapNumbers(catalogue, chapter)
        const parts = partNumbering(
          catalogue,
          bookNameOf(chapter),
          vacatedBy(catalogue, chapter),
          Target.NoPart(),
        )
        return editOf(
          splicesOf(context.corpus, {
            numbers,
            placed: keptNamed(catalogue, chapter, numbers, parts.final),
            parts: parts.parts,
            leaving: new Map([[path, Leaving.Going()]]),
          }).filter(outside([path])),
          [path],
        )
      },
    })
  })

const renamedAll = (
  corpus: LoomCorpusAst,
  path: Location,
  offsets: ReadonlyArray<number>,
  name: string,
): ReadonlyArray<Splice> =>
  Array.getSomes(
    offsets
      .flatMap((offset) => renameAt(corpus, path, offset))
      .map((location) => spliceAt(corpus, location, () => name)),
  )

const openingTitle = (module: LoomModule): Option.Option<{ readonly position: Position }> =>
  Option.flatMap(openingSection(module), (section) => Option.fromNullishOr(section.heading.title))

const retitledLoom = (
  context: EditContext,
  intent: Intent<'RetitleLoom'>,
): Result.Result<LoomEdit, EditRefusal> =>
  Result.gen(function* () {
    const catalogue = catalogueOf(context.corpus.modules)
    const path = context.locate(intent.uri)
    const module = yield* loomAt(context.corpus, path)
    const title = yield* fitName(intent.title)
    yield* Option.match(chapterOf(catalogue, path), {
      onNone: () => Result.succeed(title),
      onSome: (chapter) =>
        titleFree(catalogue, bookNameOf(chapter), partOf(chapter), title, Option.some(path)),
    })
    return editOf(
      renamedAll(
        context.corpus,
        path,
        Array.getSomes([
          Option.fromNullishOr(module.doc.frontmatter?.title),
          openingTitle(module),
        ]).map((token) => token.position.start.offset),
        title,
      ),
    )
  })

const bookLine = (
  corpus: LoomCorpusAst,
  book: string,
): Option.Option<readonly [Location, number]> =>
  Array.findFirst(Array.fromIterable(corpus.modules.values()), (module) =>
    Option.map(
      Option.filter(
        Option.fromNullishOr(module.doc.frontmatter?.book),
        (line) => line.value === book,
      ),
      (line) => [module.path, line.position.start.offset] as const,
    ),
  )

const renamedBook = (
  context: EditContext,
  intent: Intent<'RenameBook'>,
): Result.Result<LoomEdit, EditRefusal> =>
  Result.gen(function* () {
    const catalogue = catalogueOf(context.corpus.modules)
    const [path, offset] = yield* Result.fromOption(
      Option.filter(bookLine(context.corpus, intent.book), () => intent.book !== ''),
      () => new NoSuchBook({ book: intent.book }),
    )
    const name = yield* fitName(intent.name)
    yield* catalogue.books.has(name)
      ? Result.fail(new BookExists({ book: name }))
      : Result.succeed(name)
    const opening = Array.fromIterable(context.corpus.modules.values())
      .filter((module) => isBookLoom(module) && Option.contains(bookOf(module), intent.book))
      .flatMap((module) =>
        Option.match(openingTitle(module), {
          onNone: (): ReadonlyArray<Splice> => [],
          onSome: (title) =>
            renamedAll(context.corpus, module.path, [title.position.start.offset], name),
        }),
      )
    return editOf([...renamedAll(context.corpus, path, [offset], name), ...opening])
  })

const renamedPart = (
  context: EditContext,
  intent: Intent<'RenamePart'>,
): Result.Result<LoomEdit, EditRefusal> =>
  Result.gen(function* () {
    const catalogue = catalogueOf(context.corpus.modules)
    const part = yield* partAsked(catalogue, intent.book, intent.part)
    const name = yield* fitPartName(
      partsOf(catalogue, intent.book),
      intent.book,
      intent.name,
      Option.some(part),
    )
    const looms = Array.sort(
      placedIn(catalogue, intent.book).filter(standsIn(Option.some(part))),
      byPlace,
    )
    const announced = Array.getSomes(
      looms.map((chapter) =>
        Option.map(Option.fromNullishOr(chapter.module.doc.frontmatter?.partName), (token) => ({
          path: chapter.module.path,
          start: token.position.start.offset,
          end: token.position.end.offset,
          text: name,
        })),
      ),
    )
    const named: Part = { ...part, name: Option.some(name) }
    return editOf([
      ...announced,
      ...Array.getSomes(
        partNamesOf(context.corpus, refOf(part)).map((location) =>
          spliceAt(context.corpus, location, () => name),
        ),
      ),
      ...(announced.length > 0
        ? []
        : Array.head(looms).pipe(
            Option.map((first) =>
              placementSplices(first.module, {
                book: intent.book,
                part: Option.some(named),
                number: numberOf(first),
              }),
            ),
            Option.getOrElse((): ReadonlyArray<Splice> => []),
          )),
    ])
  })

const movedPart = (
  context: EditContext,
  intent: Intent<'MovePart'>,
): Result.Result<LoomEdit, EditRefusal> =>
  Result.gen(function* () {
    const catalogue = catalogueOf(context.corpus.modules)
    const part = yield* partAsked(catalogue, intent.book, intent.part)
    const numbered = partsOf(catalogue, intent.book).filter(isNumberedPart)
    const others = numbered.filter((held) => !sameIdentity(held, part))
    const spot = spotOf(intent.after)
    const order = yield* namesItself(spot, (name) => answersTo(part, name))
      ? Result.succeed(numbered)
      : Result.map(
          Result.fromOption(
            spotIndex(others, spot, answersTo),
            () => new NoSuchPart({ book: intent.book, part: spotName(spot) }),
          ),
          (at) => [...others.slice(0, at), part, ...others.slice(at)],
        )
    return editOf(
      splicesOf(context.corpus, {
        numbers: new Map(),
        placed: new Map(),
        parts: numbering(partNumbers(numbered, order)).parts,
        leaving: new Map(),
      }),
    )
  })

const removedPart = (
  context: EditContext,
  intent: Intent<'RemovePart'>,
): Result.Result<LoomEdit, EditRefusal> =>
  Result.gen(function* () {
    const catalogue = catalogueOf(context.corpus.modules)
    const part = yield* partAsked(catalogue, intent.book, intent.part)
    const removed = placedIn(catalogue, intent.book)
      .filter(standsIn(Option.some(part)))
      .map((chapter) => chapter.module.path)
    return editOf(
      splicesOf(context.corpus, {
        numbers: new Map(),
        placed: new Map(),
        parts: partNumbering(catalogue, intent.book, Option.some(part), Target.NoPart()).parts,
        leaving: new Map(removed.map((path) => [path, Leaving.Going()] as const)),
      }).filter(outside(removed)),
      removed,
    )
  })

const titleOfSection = (section: LoomSection): Option.Option<string> =>
  Option.fromNullishOr(section.heading.title?.source)

const sameName = (section: LoomSection, name: string): boolean =>
  Option.exists(titleOfSection(section), (title) => normaliseTitle(title) === normaliseTitle(name))

const sectionNamed = (module: LoomModule, name: string): Option.Option<LoomSection> =>
  Array.findFirst(module.doc.sections, (section) => sameName(section, name))

const sectionAsked = (
  module: LoomModule,
  name: string,
): Result.Result<LoomSection, NoSuchSection> =>
  Result.fromOption(
    sectionNamed(module, name),
    () => new NoSuchSection({ path: module.path, section: name }),
  )

const nameFree = (
  module: LoomModule,
  name: string,
  keeping: Option.Option<LoomSection>,
): Result.Result<string, SectionExists> =>
  module.doc.sections.some(
    (section) => sameName(section, name) && !Option.contains(keeping, section),
  )
    ? Result.fail(new SectionExists({ path: module.path, section: name }))
    : Result.succeed(name)

const indexOfSection = (module: LoomModule, section: LoomSection): number =>
  Option.getOrElse(
    Array.findFirstIndex(module.doc.sections, (held) => held === section),
    () => module.doc.sections.length,
  )

const startOfSlot = (module: LoomModule, slot: number): number =>
  Option.getOrElse(
    Option.map(Array.get(module.doc.sections, slot), (next) => next.position.start.offset),
    () => module.text.length,
  )

const nextStart = (module: LoomModule, section: LoomSection): number =>
  startOfSlot(module, indexOfSection(module, section) + 1)

const levelOf: (marker: LoomHeading['marker']) => number = byType<LoomHeading['marker']>()({
  HeadingStart: (start) => start.source.trim().length,
  Divider: () => 7,
})

const sectionLevel = (section: LoomSection): number => levelOf(section.heading.marker)

const spanEndIndex = (module: LoomModule, section: LoomSection): number => {
  const at = indexOfSection(module, section)
  return Option.getOrElse(
    Option.map(
      Array.findFirstIndex(
        module.doc.sections.slice(at + 1),
        (later) => sectionLevel(later) <= sectionLevel(section),
      ),
      (found) => at + 1 + found,
    ),
    () => module.doc.sections.length,
  )
}

const openingSection = (module: LoomModule): Option.Option<LoomSection> =>
  Option.filter(Array.head(module.doc.sections), (section) => sectionLevel(section) === 1)

const notOpening = (
  module: LoomModule,
  section: LoomSection,
): Result.Result<LoomSection, OpensTheLoom> =>
  Option.exists(openingSection(module), (opening) => opening === section)
    ? Result.fail(
        new OpensTheLoom({
          path: module.path,
          section: Option.getOrElse(titleOfSection(section), () => ''),
        }),
      )
    : Result.succeed(section)

const bodyStart = (module: LoomModule, section: LoomSection): number =>
  Option.getOrElse(
    Option.map(
      Array.head([...section.preamble, ...section.code]),
      (line) => line.position.start.offset,
    ),
    () => nextStart(module, section),
  )

const headingMark = Option.getOrThrow(getProbe(HeadingStartTokenSchema))
const arrowMark = Option.getOrThrow(getProbe(ArrowTokenSchema))
const tildeMark = Option.getOrThrow(getProbe(TildeTokenSchema))
const dividerMark = Option.getOrThrow(getProbe(DividerTokenSchema))
const boxMark = Option.getOrThrow(getProbe(BoxFenceTokenSchema))

const codeMarks: ReadonlyArray<RegExp> = [headingMark, arrowMark, tildeMark, dividerMark]
const openMarks: ReadonlyArray<RegExp> = [...codeMarks, boxMark]
const boxedMarks: ReadonlyArray<RegExp> = [boxMark]

const readsAsMark =
  (marks: ReadonlyArray<RegExp>) =>
  (line: string): boolean =>
    marks.some((mark) => mark.test(line))

type Scan = {
  readonly quote: Option.Option<{ readonly fence: Fence; readonly line: string }>
  readonly unfit: Option.Option<string>
}

const scanned =
  (marks: ReadonlyArray<RegExp>, quoting: boolean) =>
  (scan: Scan, line: string): Scan =>
    Option.isSome(scan.unfit)
      ? scan
      : Option.match(scan.quote, {
          onSome: ({ fence }) =>
            closesFence(fence)(line) ? { ...scan, quote: Option.none() } : scan,
          onNone: () =>
            Option.match(
              Option.filter(openingFence(line), () => quoting),
              {
                onSome: (fence) => ({ ...scan, quote: Option.some({ fence, line }) }),
                onNone: () =>
                  readsAsMark(marks)(line) ? { ...scan, unfit: Option.some(line) } : scan,
              },
            ),
        })

const unfitLine = (
  marks: ReadonlyArray<RegExp>,
  quoting: boolean,
  text: string,
): Option.Option<string> => {
  const scan = text
    .split(/\r?\n/)
    .reduce(scanned(marks, quoting), { quote: Option.none(), unfit: Option.none() })
  return Option.orElse(scan.unfit, () => Option.map(scan.quote, ({ line }) => line))
}

const fitText =
  (marks: ReadonlyArray<RegExp>, quoting: boolean) =>
  (text: string): Result.Result<string, UnfitText> =>
    Option.match(unfitLine(marks, quoting, text), {
      onNone: () => Result.succeed(text),
      onSome: (line) => Result.fail(new UnfitText({ line })),
    })

const fitOpenText = fitText(openMarks, true)

const fitBoxedText = fitText(boxedMarks, false)

const fitBody = (body: ReadonlyArray<Piece>): Result.Result<ReadonlyArray<Piece>, UnfitText> =>
  Result.map(
    Result.all(
      body.map((piece) =>
        PieceSchema.match(piece, {
          Code: ({ text }) => Result.succeed(text),
          Prose: ({ text }) => fitOpenText(text),
        }),
      ),
    ),
    () => body,
  )

const needsFence = (code: string): boolean =>
  code.split(/\r?\n/).some(readsAsMark(codeMarks)) || /^\s*```/.test(code)

const fenced = (code: string): string => {
  const fence = '`'.repeat(
    Math.max(
      3,
      ...Array.fromIterable(code.matchAll(/^(`+)/gm)).map((run) => (run[1] ?? '').length + 1),
    ),
  )
  return `${fence}\n${code}\n${fence}`
}

const tidied = (piece: Piece): Piece => ({ ...piece, text: blockOf(piece.text.split(/\r?\n/)) })

const mergedPieces = (body: ReadonlyArray<Piece>): ReadonlyArray<Piece> =>
  body
    .map(tidied)
    .filter((piece) => piece.text !== '')
    .reduce(
      (merged: ReadonlyArray<Piece>, piece) =>
        Option.match(
          Option.filter(Array.last(merged), (last) => last._tag === piece._tag),
          {
            onNone: () => [...merged, piece],
            onSome: (last) => [
              ...Array.dropRight(merged, 1),
              { ...last, text: `${last.text}\n\n${piece.text}` },
            ],
          },
        ),
      [],
    )

const writtenPiece = (piece: Piece, before: Option.Option<Piece>): ReadonlyArray<string> =>
  PieceSchema.match(piece, {
    Code: ({ text }) => ['=>', needsFence(text) ? fenced(text) : text],
    Prose: ({ text }) =>
      Option.exists(before, (prior) => prior._tag === 'Code' && !needsFence(prior.text))
        ? ['~', text]
        : [text],
  })

export const writtenBody = (body: ReadonlyArray<Piece>, notes: ReadonlyArray<string>): string => {
  const pieces = mergedPieces(body)
  const written = pieces.map((piece, at) => writtenPiece(piece, Array.get(pieces, at - 1)))
  return Array.matchLeft(written, {
    onEmpty: () => notes,
    onNonEmpty: (first, rest) =>
      Option.exists(Array.head(pieces), (opening) => opening._tag === 'Prose')
        ? [...first, ...notes, ...rest.flat()]
        : [...notes, ...written.flat()],
  }).join('\n\n')
}

const noteSource = (module: LoomModule, opened: OpenedBox): string =>
  module.text
    .slice(
      opened.opener.position.start.offset,
      Option.getOrElse(
        Option.orElse(opened.closer, () => Array.last(opened.body)),
        () => opened.opener,
      ).position.end.offset,
    )
    .replace(/\s+$/, '')

const replacedSection = (
  context: EditContext,
  intent: Intent<'ReplaceSection'>,
): Result.Result<LoomEdit, EditRefusal> =>
  Result.gen(function* () {
    const module = yield* loomAt(context.corpus, context.locate(intent.uri))
    const section = yield* sectionAsked(module, intent.section)
    const body = yield* fitBody(intent.body)
    const start = bodyStart(module, section)
    const end =
      loomKindOf(module) === discussionKind
        ? Option.getOrElse(
            Option.map(Array.head(section.code), (line) => line.position.start.offset),
            () => nextStart(module, section),
          )
        : nextStart(module, section)
    const kept = boxesOfKind(module, section, noteKind).filter(
      (note) =>
        note.opener.position.start.offset >= start && note.opener.position.start.offset < end,
    )
    const written = writtenBody(
      body,
      kept.map((note) => noteSource(module, note)),
    )
    const opening = breakBefore(module.text, start) > 0 ? '' : '\n'
    const middle = written === '' ? '' : `\n${written}\n`
    const closing = end < module.text.length ? '\n' : ''
    return editOf([{ path: module.path, start, end, text: `${opening}${middle}${closing}` }])
  })

const labelWord = /^[a-zA-Z0-9_-]+(?: [a-zA-Z0-9_-]+)*$/

const quoted = (value: string): string =>
  /^[^\s"{}=\\]+$/.test(value) ? value : `"${value.replace(/["\\]/g, '\\$&')}"`

const labelled = (
  kind: Option.Option<string>,
  language: Option.Option<string>,
): Option.Option<string> =>
  Option.isSome(kind)
    ? Option.filter(kind, (named) => Array.contains(sectionKinds, named) && Option.isNone(language))
    : Option.filter(language, (named) => labelWord.test(named))

const bracesOf = (kind: Option.Option<string>, language: Option.Option<string>): string => {
  const keys = [
    ...Option.toArray(Option.map(kind, (named) => `kind=${quoted(named)}`)),
    ...Option.toArray(Option.map(language, (named) => `lang=${quoted(named)}`)),
  ]
  return Option.match(labelled(kind, language), {
    onSome: (label) => ` {${label}}`,
    onNone: () => (keys.length === 0 ? '' : ` {${keys.join(' ')}}`),
  })
}

type SectionPlace = { readonly slot: number; readonly level: number }

const firstPlace = (module: LoomModule): SectionPlace => ({
  slot: Option.isSome(openingSection(module)) ? 1 : 0,
  level: 2,
})

const placeAfter = (module: LoomModule, section: LoomSection): SectionPlace =>
  Option.exists(openingSection(module), (opening) => opening === section)
    ? firstPlace(module)
    : {
        slot: spanEndIndex(module, section),
        level: sectionLevel(section) > 6 ? 2 : sectionLevel(section),
      }

const sectionSlot = (module: LoomModule, spot: Spot): Result.Result<SectionPlace, NoSuchSection> =>
  Result.fromOption(
    Spot.$match(spot, {
      First: () => Option.some(firstPlace(module)),
      Last: () => Option.some({ slot: module.doc.sections.length, level: 2 }),
      After: ({ name }) =>
        Option.map(sectionNamed(module, name), (section) => placeAfter(module, section)),
    }),
    () => new NoSuchSection({ path: module.path, section: spotName(spot) }),
  )

const insertedAt = (module: LoomModule, slot: number, block: string): Splice =>
  Option.match(Array.get(module.doc.sections, slot), {
    onSome: (next) => ({
      path: module.path,
      start: next.position.start.offset,
      end: next.position.start.offset,
      text: blockBefore(module.text, next.position.start.offset, block),
    }),
    onNone: () => ({
      path: module.path,
      start: module.text.length,
      end: module.text.length,
      text: blockAt(module.text, module.text.length, block),
    }),
  })

const addedSection = (
  context: EditContext,
  intent: Intent<'AddSection'>,
): Result.Result<LoomEdit, EditRefusal> =>
  Result.gen(function* () {
    const module = yield* loomAt(context.corpus, context.locate(intent.uri))
    const name = yield* fitName(intent.name)
    yield* nameFree(module, name, Option.none())
    const kind = yield* fitChosen(intent.kind)
    const language = yield* fitChosen(intent.language)
    const body = writtenBody(yield* fitBody(intent.body), [])
    const place = yield* sectionSlot(module, spotOf(intent.after))
    const heading = `${'#'.repeat(place.level)} ${name}${bracesOf(kind, language)}`
    return editOf([insertedAt(module, place.slot, body === '' ? heading : `${heading}\n\n${body}`)])
  })

const removalOf = (module: LoomModule, section: LoomSection): Splice => {
  const start = section.position.start.offset
  const end = startOfSlot(module, spanEndIndex(module, section))
  return end < module.text.length
    ? { path: module.path, start, end, text: '' }
    : { path: module.path, start: afterWords(module.text, start), end, text: '' }
}

const removedSection = (
  context: EditContext,
  intent: Intent<'RemoveSection'>,
): Result.Result<LoomEdit, EditRefusal> =>
  Result.gen(function* () {
    const module = yield* loomAt(context.corpus, context.locate(intent.uri))
    const section = yield* sectionAsked(module, intent.section)
    yield* notOpening(module, section)
    return editOf([removalOf(module, section)])
  })

const movedSection = (
  context: EditContext,
  intent: Intent<'MoveSection'>,
): Result.Result<LoomEdit, EditRefusal> =>
  Result.gen(function* () {
    const module = yield* loomAt(context.corpus, context.locate(intent.uri))
    const section = yield* sectionAsked(module, intent.section)
    yield* notOpening(module, section)
    const { slot } = yield* sectionSlot(module, spotOf(intent.after))
    const at = indexOfSection(module, section)
    const end = spanEndIndex(module, section)
    const block = module.text
      .slice(section.position.start.offset, startOfSlot(module, end))
      .replace(/\s+$/, '')
    return slot >= at && slot <= end
      ? editOf([])
      : editOf([removalOf(module, section), insertedAt(module, slot, block)])
  })

const renamedSection = (
  context: EditContext,
  intent: Intent<'RenameSection'>,
): Result.Result<LoomEdit, EditRefusal> =>
  Result.gen(function* () {
    const module = yield* loomAt(context.corpus, context.locate(intent.uri))
    const section = yield* sectionAsked(module, intent.section)
    const name = yield* fitName(intent.name)
    yield* nameFree(module, name, Option.some(section))
    const offset = Option.getOrElse(
      Option.map(
        Option.fromNullishOr(section.heading.title),
        (title) => title.position.start.offset,
      ),
      () => section.position.start.offset,
    )
    return editOf([
      ...renamedAll(context.corpus, module.path, [offset], name),
      ...Option.toArray(
        Option.map(conceptRenameAt(context.corpus, module.path, offset), ({ kept }) => ({
          path: kept.path,
          start: kept.at.start.offset,
          end: kept.at.end.offset,
          text: kept.text,
        })),
      ),
    ])
  })

const addedNote = (
  context: EditContext,
  intent: Intent<'AddNote'>,
): Result.Result<LoomEdit, EditRefusal> =>
  Result.gen(function* () {
    const module = yield* loomAt(context.corpus, context.locate(intent.uri))
    const section = yield* sectionAsked(module, intent.section)
    const text = yield* fitBoxedText(intent.text)
    const at = contentEnd(section.preamble, bodyStart(module, section))
    return editOf([
      {
        path: module.path,
        start: at,
        end: at,
        text: blockAt(module.text, at, `:::\n${blockOf(text.split(/\r?\n/))}\n:::`),
      },
    ])
  })

const noteRemoval = (module: LoomModule, opened: OpenedBox): Splice => {
  const start = opened.opener.position.start.offset
  const end = Option.getOrElse(
    Option.orElse(opened.closer, () => Array.last(opened.body)),
    () => opened.opener,
  ).position.end.offset
  return blankBefore(module.text, start)
    ? { path: module.path, start: start - breakBefore(module.text, start), end, text: '' }
    : { path: module.path, start, end: end + breakAt(module.text, end), text: '' }
}

const resolvedNote = (
  context: EditContext,
  intent: Intent<'ResolveNote'>,
): Result.Result<LoomEdit, EditRefusal> =>
  Result.gen(function* () {
    const module = yield* loomAt(context.corpus, context.locate(intent.uri))
    const section = yield* sectionAsked(module, intent.section)
    const words = blockOf(intent.text.split(/\r?\n/))
    const note = yield* Result.fromOption(
      Array.findFirst(
        boxesOfKind(module, section, noteKind),
        (opened) => boxText(opened) === words,
      ),
      () => new NoSuchNote({ path: module.path, section: intent.section, text: intent.text }),
    )
    return editOf([noteRemoval(module, note)])
  })

const discussionAt = (
  context: EditContext,
  uri: string,
): Result.Result<LoomModule, NoSuchLoom | NotADiscussion> =>
  Result.flatMap(loomAt(context.corpus, context.locate(uri)), (module) =>
    loomKindOf(module) === discussionKind
      ? Result.succeed(module)
      : Result.fail(new NotADiscussion({ path: module.path })),
  )

const openedTopic = (
  context: EditContext,
  intent: Intent<'OpenTopic'>,
): Result.Result<LoomEdit, EditRefusal> =>
  Result.gen(function* () {
    const module = yield* discussionAt(context, intent.uri)
    const name = yield* fitName(intent.name)
    yield* fitOpenText(name)
    yield* nameFree(module, name, Option.none())
    return editOf([
      {
        path: module.path,
        start: module.text.length,
        end: module.text.length,
        text: blockAt(module.text, module.text.length, `${name}\n---`),
      },
    ])
  })

const topicEnd = (module: LoomModule, topic: LoomSection): number =>
  contentEnd([...topic.preamble, ...topic.code], bodyStart(module, topic))

const addedMessage = (
  context: EditContext,
  intent: Intent<'AddMessage'>,
): Result.Result<LoomEdit, EditRefusal> =>
  Result.gen(function* () {
    const module = yield* discussionAt(context, intent.uri)
    const topic = yield* sectionAsked(module, intent.topic)
    const author = yield* fitName(intent.author)
    const text = yield* fitOpenText(intent.text)
    const block = `~ ${author}\n${blockOf(text.split(/\r?\n/))}`
    return editOf([
      Option.match(Array.head(boxesOfKind(module, topic, conclusionKind)), {
        onSome: (conclusion) => {
          const at = conclusion.opener.position.start.offset
          return {
            path: module.path,
            start: at,
            end: at,
            text: blockBefore(module.text, at, block),
          }
        },
        onNone: () => {
          const at = topicEnd(module, topic)
          return { path: module.path, start: at, end: at, text: blockAt(module.text, at, block) }
        },
      }),
    ])
  })

const concluded = (
  context: EditContext,
  intent: Intent<'Conclude'>,
): Result.Result<LoomEdit, EditRefusal> =>
  Result.gen(function* () {
    const module = yield* discussionAt(context, intent.uri)
    const topic = yield* sectionAsked(module, intent.topic)
    const words = blockOf((yield* fitBoxedText(intent.text)).split(/\r?\n/))
    return editOf([
      Option.match(Array.head(boxesOfKind(module, topic, conclusionKind)), {
        onSome: (conclusion) => ({
          path: module.path,
          start: conclusion.opener.position.end.offset,
          end: Option.getOrElse(
            Option.map(conclusion.closer, (closer) => closer.position.start.offset),
            () => conclusion.opener.position.end.offset,
          ),
          text: `${words}\n`,
        }),
        onNone: () => {
          const at = topicEnd(module, topic)
          return {
            path: module.path,
            start: at,
            end: at,
            text: blockAt(module.text, at, `::: {Conclusion}\n${words}\n:::`),
          }
        },
      }),
    ])
  })

const variableSet = (
  context: EditContext,
  intent: Intent<'SetVariable'>,
): Result.Result<LoomEdit, EditRefusal> =>
  Result.gen(function* () {
    const name = yield* isVariableName(intent.name)
      ? Result.succeed(intent.name)
      : Result.fail(new NotAVariableName({ name: intent.name }))
    yield* Result.fromOption(
      context.manifest,
      () => new NoConfiguration({ workspace: context.workspace }),
    )
    return {
      made: [],
      splices: [],
      gone: [],
      configuration: Option.some({ path: ['variables', name], value: intent.value }),
    }
  })

type Edit = (context: EditContext) => Result.Result<LoomEdit, EditRefusal>

const editFor = LoomIntentSchema.match({
  MakeLoom:
    (intent): Edit =>
    (context) =>
      madeLoom(context, intent),
  MakeBook:
    (intent): Edit =>
    (context) =>
      madeBook(context, intent),
  MoveLoom:
    (intent): Edit =>
    (context) =>
      movedLoom(context, intent),
  RemoveLoom:
    (intent): Edit =>
    (context) =>
      removedLoom(context, intent),
  RetitleLoom:
    (intent): Edit =>
    (context) =>
      retitledLoom(context, intent),
  RenamePart:
    (intent): Edit =>
    (context) =>
      renamedPart(context, intent),
  MovePart:
    (intent): Edit =>
    (context) =>
      movedPart(context, intent),
  RemovePart:
    (intent): Edit =>
    (context) =>
      removedPart(context, intent),
  RenameBook:
    (intent): Edit =>
    (context) =>
      renamedBook(context, intent),
  ReplaceSection:
    (intent): Edit =>
    (context) =>
      replacedSection(context, intent),
  AddSection:
    (intent): Edit =>
    (context) =>
      addedSection(context, intent),
  RemoveSection:
    (intent): Edit =>
    (context) =>
      removedSection(context, intent),
  MoveSection:
    (intent): Edit =>
    (context) =>
      movedSection(context, intent),
  RenameSection:
    (intent): Edit =>
    (context) =>
      renamedSection(context, intent),
  AddNote:
    (intent): Edit =>
    (context) =>
      addedNote(context, intent),
  ResolveNote:
    (intent): Edit =>
    (context) =>
      resolvedNote(context, intent),
  OpenTopic:
    (intent): Edit =>
    (context) =>
      openedTopic(context, intent),
  AddMessage:
    (intent): Edit =>
    (context) =>
      addedMessage(context, intent),
  Conclude:
    (intent): Edit =>
    (context) =>
      concluded(context, intent),
  SetVariable:
    (intent): Edit =>
    (context) =>
      variableSet(context, intent),
})

const lineEndingOf = (text: string): string => (text.includes('\r\n') ? '\r\n' : '\n')

const endedAs =
  (ending: string) =>
  (text: string): string =>
    ending === '\n' ? text : text.replace(/\r?\n/g, ending)

const inLineEndings = (corpus: LoomCorpusAst, edit: LoomEdit): LoomEdit => {
  const endingAt = (path: Location): string =>
    Option.getOrElse(
      Option.map(Option.fromNullishOr(corpus.modules.get(path)), (module) =>
        lineEndingOf(module.text),
      ),
      () => '\n',
    )
  const endings = new Map(
    Array.dedupe(edit.splices.map((splice) => splice.path)).map(
      (path) => [path, endingAt(path)] as const,
    ),
  )
  const made = Option.getOrElse(
    Option.map(Array.head(Array.fromIterable(corpus.modules.values())), (module) =>
      lineEndingOf(module.text),
    ),
    () => '\n',
  )
  return {
    ...edit,
    made: edit.made.map((loom) => ({ ...loom, text: endedAs(made)(loom.text) })),
    splices: edit.splices.map((splice) => ({
      ...splice,
      text: endedAs(Option.getOrElse(Option.fromNullishOr(endings.get(splice.path)), () => '\n'))(
        splice.text,
      ),
    })),
  }
}

export const buildEdit = (
  context: EditContext,
  intent: LoomIntent,
): Result.Result<LoomEdit, EditRefusal> =>
  Result.map(editFor(intent)(context), (edit) => inLineEndings(context.corpus, edit))

export const problemsAdded = (
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  after.reduce(
    ({ left, added }, problem) =>
      Option.match(
        Array.findFirstIndex(left, (held) => held === problem),
        {
          onSome: (at) => ({ left: Array.remove(left, at), added }),
          onNone: () => ({ left, added: [...added, problem] }),
        },
      ),
    { left: before, added: [] as ReadonlyArray<string> },
  ).added
