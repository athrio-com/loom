import { Array, Data, Option, Order, Schema } from 'effect'
import { byType, byTypeOr } from '@athrio/loom-ast/LoomNode'
import {
  boxKeys,
  boxKind,
  boxKinds,
  codelessKinds,
  conclusionKind,
  discussionKind,
  type DividerToken,
  headingLang,
  type HeadingStartToken,
  type Keys,
  KeysSchema,
  loomKinds,
  noteKind,
  type ParametersToken,
  type ParameterToken,
  sectionKinds,
  type SpecifierToken,
  tropeKind,
} from '@athrio/loom-ast/LoomTokens'
import type { LoomSection } from '@athrio/loom-ast/LoomAst'
import type { LoomWeft, PreambleWeft, SectionBodyWeft, TildeWeft } from '@athrio/loom-ast/Weft'
import {
  bookOf,
  catalogueOf,
  chapterOf,
  isBookLoom,
  type Location,
  type LoomCorpusAst,
  loomKindOf,
  type LoomModule,
  type OpenedBox,
  openedBoxesOf,
  ordinalOf,
  type PartRef,
} from '@athrio/loom-ast/LoomCorpusAst'
import { sectionNameOf } from '#ast/ProductBuilder'
import { type Declarations, noDeclarations } from '#ast/DeclaredKinds'
import { titleOf } from './weave/TableOfContentsBuilder'
import { conceptKey, conceptUsesOf } from './weave/WeaveBuilder'

export const PieceSchema = Schema.TaggedUnion({
  Prose: { text: Schema.String },
  Code: { text: Schema.String },
})
export type Piece = typeof PieceSchema.Type

export const OutlineNoteSchema = Schema.Struct({
  text: Schema.String,
  caption: Schema.optional(Schema.String),
})
export type OutlineNote = typeof OutlineNoteSchema.Type

export const OutlineMessageSchema = Schema.Struct({ author: Schema.String, text: Schema.String })
export type OutlineMessage = typeof OutlineMessageSchema.Type

export const ParameterValuesSchema = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Array(Schema.String)]),
)
export type ParameterValues = typeof ParameterValuesSchema.Type

export const keysApart: ReadonlyArray<string> = ['kind', 'lang']

export const OutlineBoxSchema = Schema.Struct({
  kind: Schema.String,
  name: Schema.optional(Schema.String),
  parameters: ParameterValuesSchema,
  text: Schema.String,
})
export type OutlineBox = typeof OutlineBoxSchema.Type

export const OutlineSectionSchema = Schema.Struct({
  name: Schema.String,
  line: Schema.Number,
  level: Schema.Number,
  kind: Schema.optional(Schema.String),
  language: Schema.optional(Schema.String),
  parameters: ParameterValuesSchema,
  file: Schema.optional(Schema.String),
  body: Schema.Array(PieceSchema),
  notes: Schema.Array(OutlineNoteSchema),
  boxes: Schema.Array(OutlineBoxSchema),
  messages: Schema.Array(OutlineMessageSchema),
  conclusion: Schema.optional(Schema.String),
})
export type OutlineSection = typeof OutlineSectionSchema.Type

export const OutlinePartSchema = Schema.Struct({
  number: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
})
export type OutlinePart = typeof OutlinePartSchema.Type

export const OutlineVariableSchema = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
  section: Schema.optional(Schema.String),
})
export type OutlineVariable = typeof OutlineVariableSchema.Type

export const OutlineSchema = Schema.Struct({
  kind: Schema.String,
  title: Schema.String,
  book: Schema.String,
  part: Schema.optional(OutlinePartSchema),
  number: Schema.optional(Schema.String),
  language: Schema.optional(Schema.String),
  sections: Schema.Array(OutlineSectionSchema),
  variables: Schema.Array(OutlineVariableSchema),
  configuration: Schema.Record(Schema.String, Schema.String),
})
export type Outline = typeof OutlineSchema.Type

export class NoSuchLoom extends Data.TaggedError('NoSuchLoom')<{ readonly path: Location }> {}

export const looseKind = 'Loose'

export const bookLoomKind = 'Book'

const outlineKindOf = (module: LoomModule): string => {
  if (module.doc.frontmatter === undefined) return looseKind
  if (isBookLoom(module)) return bookLoomKind
  return loomKindOf(module)
}

type Standing = 'prose' | 'code'

type BodyLine = { readonly standing: Standing; readonly text: Option.Option<string> }

const lineText = (source: string): string => source.replace(/\r?\n$/, '')

const bodyLineOf = byType<PreambleWeft | SectionBodyWeft>()<BodyLine>({
  PreambleWeft: (line) => ({ standing: 'prose', text: Option.some(lineText(line.source)) }),
  ProseWeft: (line) => ({ standing: 'prose', text: Option.some(lineText(line.source)) }),
  TildeWeft: (tilde) => ({
    standing: 'prose',
    text: Option.map(Option.fromNullishOr(tilde.prose), (prose) => lineText(prose.source)),
  }),
  ArrowWeft: (arrow) => ({
    standing: 'code',
    text: Option.map(Option.fromNullishOr(arrow.code), (code) => lineText(code.source)),
  }),
  CodeWeft: (line) => ({ standing: 'code', text: Option.some(lineText(line.source)) }),
  FenceWeft: () => ({ standing: 'code', text: Option.none() }),
})

const isBlank = (line: string): boolean => line.trim() === ''

export const blockOf = (lines: ReadonlyArray<string>): string =>
  Array.reverse(Array.dropWhile(Array.reverse(Array.dropWhile(lines, isBlank)), isBlank)).join('\n')

const pieceOf: { readonly [Each in Standing]: (text: string) => Piece } = {
  prose: (text) => ({ _tag: 'Prose', text }),
  code: (text) => ({ _tag: 'Code', text }),
}

export const piecesOf = (
  wefts: ReadonlyArray<PreambleWeft | SectionBodyWeft>,
): ReadonlyArray<Piece> =>
  Array.match(wefts.map(bodyLineOf), {
    onEmpty: (): ReadonlyArray<Piece> => [],
    onNonEmpty: (lines) =>
      Array.groupWith(lines, (one, other) => one.standing === other.standing)
        .map((run) =>
          pieceOf[Array.headNonEmpty(run).standing](
            blockOf(Array.getSomes(run.map((line) => line.text))),
          ),
        )
        .filter((piece) => piece.text !== ''),
  })

const opensWithin = (section: LoomSection, opened: OpenedBox): boolean =>
  opened.opener.position.start.offset >= section.position.start.offset &&
  opened.opener.position.start.offset < section.position.end.offset

export const boxesIn = (module: LoomModule, section: LoomSection): ReadonlyArray<OpenedBox> =>
  openedBoxesOf(module.doc).filter((opened) => opensWithin(section, opened))

export const boxesOfKind = (
  module: LoomModule,
  section: LoomSection,
  kind: string,
): ReadonlyArray<OpenedBox> =>
  boxesIn(module, section).filter((opened) => boxKind(opened.box) === kind)

export const boxText = (opened: OpenedBox): string =>
  blockOf(opened.body.map((line) => lineText(line.source)))

const linesOfBox = (opened: OpenedBox): ReadonlyArray<LoomWeft> => [
  opened.opener,
  ...opened.body,
  ...Option.toArray(opened.closer),
]

const outsideOf = (boxes: ReadonlyArray<OpenedBox>): ((line: LoomWeft) => boolean) => {
  const inside = new Set(boxes.flatMap(linesOfBox))
  return (line) => !inside.has(line)
}

const nameOf = (opened: OpenedBox): string | undefined =>
  Option.getOrUndefined(Option.map(Option.fromNullishOr(opened.box.name), (name) => name.value))

const noteOutline = (opened: OpenedBox): OutlineNote => ({
  text: boxText(opened),
  caption: nameOf(opened),
})

const boxOutline = (opened: OpenedBox): OutlineBox => ({
  kind: boxKind(opened.box),
  name: nameOf(opened),
  parameters: parameterValuesOf(opened.box.specifier),
  text: boxText(opened),
})

type Thread = ReadonlyArray<{ readonly author: string; readonly lines: ReadonlyArray<string> }>

const authorOf = (tilde: TildeWeft): string =>
  Option.getOrElse(
    Option.map(Option.fromNullishOr(tilde.prose), (prose) => lineText(prose.source).trim()),
    () => '',
  )

const threadAfter = byTypeOr<SectionBodyWeft, [thread: Thread]>()<Thread>(
  { TildeWeft: (tilde, thread) => [...thread, { author: authorOf(tilde), lines: [] }] },
  (line, thread) =>
    Option.match(Array.last(thread), {
      onNone: () => thread,
      onSome: (open) => [
        ...Array.dropRight(thread, 1),
        { ...open, lines: [...open.lines, lineText(line.source)] },
      ],
    }),
)

const messagesOf = (lines: ReadonlyArray<SectionBodyWeft>): ReadonlyArray<OutlineMessage> =>
  lines
    .reduce((thread: Thread, line) => threadAfter(line, thread), [])
    .map(({ author, lines: said }) => ({ author, text: blockOf(said) }))

const levelOf = byType<HeadingStartToken | DividerToken>()<number>({
  HeadingStart: (start) => start.source.trim().length,
  Divider: () => 0,
})

const writtenAsList = (parameter: ParameterToken): boolean =>
  parameter.source.slice(parameter.key.source.length + 1).startsWith('[')

const writtenValues = (parameter: ParameterToken): string | ReadonlyArray<string> => {
  const values = parameter.values.map((value) => value.value)
  return writtenAsList(parameter) ? values : Option.getOrElse(Array.head(values), () => '')
}

const parametersIn = byType<SpecifierToken | ParametersToken>()<ReadonlyArray<ParameterToken>>({
  Specifier: () => [],
  Parameters: (held) => held.parameters,
})

export const parameterValuesOf = (
  specifier: SpecifierToken | ParametersToken | undefined,
): ParameterValues =>
  Object.fromEntries(
    Option.match(Option.fromNullishOr(specifier), {
      onNone: (): ReadonlyArray<ParameterToken> => [],
      onSome: parametersIn,
    })
      .filter((parameter) => !Array.contains(keysApart, parameter.key.value))
      .map((parameter) => [parameter.key.value, writtenValues(parameter)]),
  )

const fileOf = (module: LoomModule, section: LoomSection): Option.Option<string> =>
  Option.map(
    Array.findFirst(
      module.product.files,
      (file) => file.code.origin.name === sectionNameOf(section),
    ),
    (file) => file.path,
  )

const standsAside = (opened: OpenedBox): boolean =>
  !Array.contains([noteKind, conclusionKind], boxKind(opened.box))

const sectionOutline =
  (module: LoomModule, discussion: boolean) =>
  (section: LoomSection): OutlineSection => {
    const notes = boxesOfKind(module, section, noteKind)
    const conclusion = Array.head(boxesOfKind(module, section, conclusionKind))
    const held = boxesIn(module, section)
    const outside = outsideOf(held)
    return {
      name: section.heading.title?.source ?? '',
      line: section.position.start.line - 1,
      level: levelOf(section.heading.marker),
      kind: section.kind,
      language: Option.getOrUndefined(
        Option.flatMap(Option.fromNullishOr(section.heading.specifier), headingLang),
      ),
      parameters: parameterValuesOf(section.heading.specifier),
      file: Option.getOrUndefined(fileOf(module, section)),
      body: piecesOf(
        (discussion ? section.preamble : [...section.preamble, ...section.code]).filter(outside),
      ),
      notes: notes.map(noteOutline),
      boxes: held.filter(standsAside).map(boxOutline),
      messages: discussion ? messagesOf(section.code.filter(outside)) : [],
      conclusion: Option.getOrUndefined(Option.map(conclusion, boxText)),
    }
  }

const variablesIn = (
  lines: ReadonlyArray<PreambleWeft>,
  section: Option.Option<string>,
): ReadonlyArray<OutlineVariable> =>
  lines
    .flatMap((line) => line.warps)
    .flatMap((warp) =>
      Option.toArray(
        Option.map(Option.fromNullishOr(warp.default), (value) => ({
          name: warp.name.value,
          value: value.value.trim(),
          section: Option.getOrUndefined(section),
        })),
      ),
    )

const variablesOf = (module: LoomModule): ReadonlyArray<OutlineVariable> => [
  ...variablesIn(module.doc.preamble, Option.none()),
  ...module.doc.sections.flatMap((section) =>
    variablesIn(section.preamble, Option.fromNullishOr(section.heading.title?.source)),
  ),
]

const partOutline = (part: PartRef): Option.Option<OutlinePart> =>
  Option.isNone(part.number) && Option.isNone(part.name)
    ? Option.none()
    : Option.some({
        number: Option.getOrUndefined(part.number),
        name: Option.getOrUndefined(part.name),
      })

export const buildOutline = (
  corpus: LoomCorpusAst,
  path: Location,
  configuration: Readonly<Record<string, string>>,
): Option.Option<Outline> =>
  Option.map(Option.fromNullishOr(corpus.modules.get(path)), (module) => {
    const place = chapterOf(catalogueOf(corpus.modules), path)
    return {
      kind: outlineKindOf(module),
      title: titleOf(module),
      book: Option.getOrElse(bookOf(module), () => ''),
      part: Option.getOrUndefined(Option.flatMap(place, (chapter) => partOutline(chapter.part))),
      number: Option.getOrUndefined(ordinalOf(module)),
      language: module.doc.frontmatter?.language?.value,
      sections: module.doc.sections.map(
        sectionOutline(module, loomKindOf(module) === discussionKind),
      ),
      variables: variablesOf(module),
      configuration: { ...configuration },
    }
  })

export const ConceptPlaceSchema = Schema.Struct({
  path: Schema.String,
  section: Schema.optional(Schema.String),
})
export type ConceptPlace = typeof ConceptPlaceSchema.Type

export const ConceptEntrySchema = Schema.Struct({
  name: Schema.String,
  forms: Schema.Array(Schema.String),
  path: Schema.String,
  section: Schema.String,
  uses: Schema.Array(ConceptPlaceSchema),
})
export type ConceptEntry = typeof ConceptEntrySchema.Type

export const ConceptsSchema = Schema.Struct({ concepts: Schema.Array(ConceptEntrySchema) })
export type Concepts = typeof ConceptsSchema.Type

const byName: Order.Order<ConceptEntry> = Order.mapInput(Order.String, (entry: ConceptEntry) =>
  entry.name.toLowerCase(),
)

export const buildConcepts = (corpus: LoomCorpusAst): Concepts => {
  const uses = conceptUsesOf(corpus.modules)
  return {
    concepts: Array.sort(
      catalogueOf(corpus.modules).concepts.map((concept): ConceptEntry => ({
        name: concept.name.source,
        forms: concept.forms.map((form) => form.value),
        path: concept.module,
        section: concept.name.source,
        uses: Option.getOrElse(
          Option.fromNullishOr(uses.get(conceptKey(concept.module, concept.section))),
          () => [],
        ).map((use) => ({
          path: use.module.path,
          section: Option.getOrUndefined(
            Option.flatMap(use.section, (section) =>
              Option.fromNullishOr(section.heading.title?.source),
            ),
          ),
        })),
      })),
      byName,
    ),
  }
}

export const LoomTypeSchema = Schema.Struct({
  kind: Schema.String,
  trope: Schema.optional(Schema.String),
})
export type LoomType = typeof LoomTypeSchema.Type

export const SectionTypeSchema = Schema.Struct({
  kind: Schema.String,
  trope: Schema.optional(Schema.String),
  parameters: KeysSchema,
  codeless: Schema.Boolean,
})
export type SectionType = typeof SectionTypeSchema.Type

export const BoxTypeSchema = Schema.Struct({
  kind: Schema.String,
  trope: Schema.optional(Schema.String),
  parameters: KeysSchema,
  body: Schema.String,
})
export type BoxType = typeof BoxTypeSchema.Type

export const TypesSchema = Schema.Struct({
  looms: Schema.Array(LoomTypeSchema),
  sections: Schema.Array(SectionTypeSchema),
  boxes: Schema.Array(BoxTypeSchema),
  headings: KeysSchema,
})
export type Types = typeof TypesSchema.Type

const tropeBoxKeys: Keys = Object.fromEntries(
  Object.entries(boxKeys).filter(([key]) => key !== 'kind'),
)

export const buildTypes = (declarations: Declarations): Types => ({
  looms: [
    ...loomKinds.map((kind): LoomType => ({ kind })),
    ...declarations.loom.map((declared): LoomType => ({
      kind: declared.kind,
      trope: declared.trope,
    })),
  ],
  sections: [
    ...sectionKinds.map(
      (kind): SectionType => ({
        kind,
        parameters: {},
        codeless: Array.contains(codelessKinds, kind),
      }),
    ),
    ...declarations.section.map(
      (declared): SectionType => ({
        kind: declared.kind,
        trope: declared.trope,
        parameters: declared.parameters,
        codeless: declared.codeless,
      }),
    ),
  ],
  boxes: [
    ...boxKinds.map(
      (kind): BoxType => ({
        kind,
        parameters: kind === tropeKind ? tropeBoxKeys : {},
        body: 'text',
      }),
    ),
    ...declarations.box.map(
      (declared): BoxType => ({
        kind: declared.kind,
        trope: declared.trope,
        parameters: declared.parameters,
        body: declared.body,
      }),
    ),
  ],
  headings: Object.fromEntries(
    declarations.headings.map((declared) => [declared.key, declared.type] as const),
  ),
})

export const coreTypes: Types = buildTypes(noDeclarations)
