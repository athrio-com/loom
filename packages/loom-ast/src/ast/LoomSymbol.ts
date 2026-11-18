import { Array, Match, Option, pipe, Schema } from 'effect'
import { type Position } from '#ast/LoomNode'
import {
  type LoomDocument,
  type LoomFrontmatter,
  type LoomHeading,
  type LoomSection,
} from '#ast/LoomAst'
import { boxOf, type LoomWeft, type SectionBodyWeft } from '#ast/Weft'
import {
  type ParametersToken,
  type ParameterToken,
  type SpecifierToken,
  valueWords,
  type WarpAnchorToken,
  type WarpToken,
} from '#ast/LoomTokens'

export const SymbolKindSchema = Schema.Literals([
  'headingTitle',
  'sectionAnchor',
  'warpAnchor',
  'warpDef',
  'specifier',
  'sink',
  'arrow',
  'tilde',
  'prose',
  'frontmatterMembership',
  'frontmatterValue',
  'frontmatterTitle',
  'frontmatterEntry',
  'frontmatterRootedIn',
  'frontmatterBook',
  'frontmatterPart',
  'frontmatterPartName',
  'boxName',
  'referenceValue',
  'divider',
])
export type SymbolKind = typeof SymbolKindSchema.Type

export interface SpanFeatures {
  readonly navigation?: boolean
  readonly semantic?: boolean
  readonly structure?: boolean
  readonly verification?: boolean
  readonly completion?: boolean
}

export const SemanticTokenSchema = Schema.Literals([
  'namespace',
  'variable',
  'keyword',
  'string',
  'operator',
])
export type SemanticToken = typeof SemanticTokenSchema.Type

export interface SymbolProfile {
  readonly semantic: Option.Option<SemanticToken>
  readonly features: SpanFeatures
}

const profile = (
  semantic: Option.Option<SemanticToken>,
  features: SpanFeatures,
): SymbolProfile => ({ semantic, features })

export const profileOf = (kind: SymbolKind): SymbolProfile =>
  Match.value(kind).pipe(
    Match.when('headingTitle', () =>
      profile(Option.some('namespace'), { navigation: true, structure: true }),
    ),
    Match.when('sectionAnchor', () =>
      profile(Option.some('namespace'), {
        navigation: true,
        structure: true,
        verification: true,
      }),
    ),
    Match.when('warpAnchor', () =>
      profile(Option.some('variable'), { navigation: true, verification: true }),
    ),
    Match.when('warpDef', () => profile(Option.some('variable'), { navigation: true })),
    Match.when('specifier', () => profile(Option.some('keyword'), { verification: true })),
    Match.when('sink', () => profile(Option.some('string'), { verification: true })),
    Match.when('arrow', () => profile(Option.some('operator'), {})),
    Match.when('tilde', () => profile(Option.some('operator'), {})),
    Match.when('prose', () => profile(Option.none(), { structure: true })),
    Match.when('frontmatterMembership', () =>
      profile(Option.some('namespace'), { navigation: true, structure: true }),
    ),
    Match.when('frontmatterValue', () => profile(Option.some('string'), { structure: true })),
    Match.whenOr('frontmatterEntry', 'frontmatterRootedIn', 'frontmatterBook', () =>
      profile(Option.some('namespace'), {
        navigation: true,
        structure: true,
        verification: true,
      }),
    ),
    Match.when('frontmatterTitle', () =>
      profile(Option.some('namespace'), { navigation: true, structure: true }),
    ),
    Match.when('frontmatterPart', () =>
      profile(Option.some('namespace'), { navigation: true, structure: true }),
    ),
    Match.when('frontmatterPartName', () =>
      profile(Option.some('namespace'), { navigation: true, structure: true }),
    ),
    Match.when('divider', () => profile(Option.some('operator'), {})),
    Match.whenOr('boxName', 'referenceValue', () =>
      profile(Option.some('namespace'), {
        navigation: true,
        structure: true,
        verification: true,
      }),
    ),
    Match.exhaustive,
  )

export interface Symbol {
  readonly kind: SymbolKind
  readonly position: Position
}

const anchorKind = (warpsInScope: ReadonlySet<string>, anchor: WarpAnchorToken): SymbolKind =>
  warpsInScope.has(anchor.name.value) ? 'warpAnchor' : 'sectionAnchor'

const namesOf = (warps: ReadonlyArray<WarpToken>): ReadonlyArray<string> =>
  Array.map(warps, (warp) => warp.name.value)

const at = (kind: SymbolKind, position: Position): Symbol => ({ kind, position })

const optSymbol = (
  kind: SymbolKind,
  token: { readonly position: Position } | undefined,
): ReadonlyArray<Symbol> =>
  Option.toArray(Option.map(Option.fromNullishOr(token), (t) => at(kind, t.position)))

const frontmatterSymbols = (fm: LoomFrontmatter): ReadonlyArray<Symbol> => [
  ...optSymbol('frontmatterPart', fm.part),
  ...optSymbol('frontmatterPartName', fm.partName),
  ...optSymbol('frontmatterMembership', fm.chapter),
  ...optSymbol('frontmatterMembership', fm.discussion),
  ...optSymbol('frontmatterMembership', fm.kind?.zone === undefined ? undefined : fm.kind),
  ...optSymbol('frontmatterTitle', fm.title),
  ...optSymbol('frontmatterValue', fm.package),
  ...optSymbol('frontmatterValue', fm.language),
  ...Array.map(
    Option.getOrElse(Option.fromNullishOr(fm.entries), () => []),
    (name) => at('frontmatterEntry', name.position),
  ),
  ...optSymbol('frontmatterRootedIn', fm.rootedIn),
  ...optSymbol('frontmatterBook', fm.book),
]

const referenceSymbols = (parameter: ParameterToken): ReadonlyArray<Symbol> =>
  Array.map(parameter.values, (value) => at('referenceValue', valueWords(value)))

const specifierSymbols = (held: ParametersToken): ReadonlyArray<Symbol> =>
  Array.flatMap(held.parameters, (parameter) =>
    parameter.refers === true
      ? [at('specifier', parameter.key.position), ...referenceSymbols(parameter)]
      : [at('specifier', parameter.position)],
  )

const heldSymbols = (
  braces: SpecifierToken | ParametersToken | undefined,
): ReadonlyArray<Symbol> =>
  pipe(
    Option.fromNullishOr(braces),
    Option.flatMap((held) =>
      held.type === 'Parameters' ? Option.some(held.parameters) : Option.none(),
    ),
    Option.getOrElse((): ReadonlyArray<ParameterToken> => []),
    Array.filter((parameter) => parameter.refers === true),
    Array.flatMap(referenceSymbols),
  )

const anchorSymbols =
  (scope: ReadonlySet<string>) =>
  (anchor: WarpAnchorToken): ReadonlyArray<Symbol> => [
    at(anchorKind(scope, anchor), anchor.name.position),
    ...heldSymbols(anchor.specifier),
  ]

const headingSymbols = (heading: LoomHeading): ReadonlyArray<Symbol> => [
  ...(heading.marker.type === 'Divider' ? [at('divider', heading.marker.position)] : []),
  ...Option.toArray(
    Option.map(Option.fromNullishOr(heading.title), (t) => at('headingTitle', t.position)),
  ),
  ...Option.match(Option.fromNullishOr(heading.specifier), {
    onNone: (): ReadonlyArray<Symbol> => [],
    onSome: specifierSymbols,
  }),
  ...Option.toArray(Option.map(Option.fromNullishOr(heading.sink), (s) => at('sink', s.position))),
]

const boxSymbols = (weft: LoomWeft): ReadonlyArray<Symbol> =>
  Option.match(boxOf(weft), {
    onNone: (): ReadonlyArray<Symbol> => [],
    onSome: (box) => [
      ...optSymbol('boxName', box.name),
      ...heldSymbols(box.specifier),
    ],
  })

const delimiterOf = (weft: SectionBodyWeft): ReadonlyArray<Symbol> =>
  Match.value(weft).pipe(
    Match.when({ type: 'ArrowWeft' }, (w) => [at('arrow', w.arrow.position)]),
    Match.when({ type: 'TildeWeft' }, (w) => [at('tilde', w.tilde.position)]),
    Match.orElse(() => []),
  )

const sectionSymbols = (
  section: LoomSection,
  documentWarps: ReadonlyArray<string>,
): ReadonlyArray<Symbol> => {
  const warps = Array.flatMap(section.preamble, (weft) => weft.warps)
  const scope = new Set([...documentWarps, ...namesOf(warps)])
  const anchors = [
    ...Array.flatMap(section.preamble, (weft) => weft.anchors),
    ...Array.flatMap(section.code, (weft) => weft.anchors),
  ]
  return [
    ...headingSymbols(section.heading),
    ...Array.map(warps, (warp) => at('warpDef', warp.name.position)),
    ...Array.flatMap(anchors, anchorSymbols(scope)),
    ...Array.flatMap(section.code, delimiterOf),
    ...Array.flatMap([...section.preamble, ...section.code], boxSymbols),
  ]
}

export const symbolsOf = (doc: LoomDocument): ReadonlyArray<Symbol> => {
  const warps = Array.flatMap(doc.preamble, (weft) => weft.warps)
  const scope = new Set(namesOf(warps))
  return [
    ...Array.flatMap(Option.toArray(Option.fromNullishOr(doc.frontmatter)), frontmatterSymbols),
    ...Array.map(warps, (warp) => at('warpDef', warp.name.position)),
    ...Array.flatMap(
      Array.flatMap(doc.preamble, (weft) => weft.anchors),
      anchorSymbols(scope),
    ),
    ...Array.flatMap(doc.preamble, boxSymbols),
    ...Array.flatMap(doc.sections, (section) => sectionSymbols(section, namesOf(warps))),
  ]
}

export const symbolAt = (doc: LoomDocument, offset: number): Option.Option<Symbol> =>
  Array.findFirst(
    symbolsOf(doc),
    (symbol) => symbol.position.start.offset <= offset && offset <= symbol.position.end.offset,
  )
