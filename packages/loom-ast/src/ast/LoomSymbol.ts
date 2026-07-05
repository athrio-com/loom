import { Array, Match, Option, Schema } from 'effect'
import { type Position } from '#ast/LoomNode'
import {
  type LoomDocument,
  type LoomFrontmatter,
  type LoomHeading,
  type LoomSection,
} from '#ast/LoomAst'
import { type SectionBodyWeft, type TocWeft } from '#ast/Weft'
import {
  type WarpAnchorToken,
  type WarpToken,
} from '#ast/LoomTokens'

export const SymbolKindSchema = Schema.Literals(['headingTitle', 'sectionAnchor', 'warpAnchor', 'warpDef', 'specifier', 'sink', 'arrow', 'tilde', 'prose', 'frontmatterMembership', 'frontmatterValue', 'frontmatterTitle', 'frontmatterPart', 'frontmatterPartName', 'tocPart', 'tocEntry'])
export type SymbolKind = typeof SymbolKindSchema.Type

export interface SpanFeatures {
  readonly navigation?: boolean
  readonly semantic?: boolean
  readonly structure?: boolean
  readonly verification?: boolean
  readonly completion?: boolean
}

export const SemanticTokenSchema = Schema.Literals(['namespace', 'variable', 'keyword', 'string', 'operator'])
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
    Match.when('warpDef', () =>
      profile(Option.some('variable'), { navigation: true }),
    ),
    Match.when('specifier', () =>
      profile(Option.some('keyword'), { verification: true }),
    ),
    Match.when('sink', () =>
      profile(Option.some('string'), { verification: true }),
    ),
    Match.when('arrow', () => profile(Option.some('operator'), {})),
    Match.when('tilde', () => profile(Option.some('operator'), {})),
    Match.when('prose', () => profile(Option.none(), { structure: true })),
    Match.when('frontmatterMembership', () =>
      profile(Option.some('namespace'), { structure: true }),
    ),
    Match.when('frontmatterValue', () =>
      profile(Option.some('string'), { structure: true }),
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
    Match.when('tocPart', () =>
      profile(Option.some('namespace'), { navigation: true, structure: true }),
    ),
    Match.when('tocEntry', () =>
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

const anchorKind = (
  warpsInScope: ReadonlySet<string>,
  anchor: WarpAnchorToken,
): SymbolKind =>
  warpsInScope.has(anchor.name.value) ? 'warpAnchor' : 'sectionAnchor'

const namesOf = (warps: ReadonlyArray<WarpToken>): ReadonlyArray<string> =>
  Array.map(warps, (warp) => warp.name.value)

const at = (kind: SymbolKind, position: Position): Symbol => ({ kind, position })

const optSymbol = (
  kind: SymbolKind,
  token: { readonly position: Position } | undefined,
): ReadonlyArray<Symbol> =>
  Option.toArray(
    Option.map(Option.fromNullishOr(token), (t) => at(kind, t.position)),
  )

const frontmatterSymbols = (fm: LoomFrontmatter): ReadonlyArray<Symbol> => [
  ...optSymbol('frontmatterPart', fm.part),
  ...optSymbol('frontmatterPartName', fm.partName),
  ...optSymbol('frontmatterMembership', fm.chapter),
  ...optSymbol('frontmatterTitle', fm.title),
  ...optSymbol('frontmatterValue', fm.package),
  ...optSymbol('frontmatterValue', fm.language),
]

const tocSymbols = (weft: TocWeft): ReadonlyArray<Symbol> => [
  ...optSymbol('tocPart', weft.part),
  ...optSymbol('tocEntry', weft.title),
]

const headingSymbols = (heading: LoomHeading): ReadonlyArray<Symbol> => [
  ...Option.toArray(
    Option.map(Option.fromNullishOr(heading.title), (t) =>
      at('headingTitle', t.position),
    ),
  ),
  ...Option.toArray(
    Option.map(Option.fromNullishOr(heading.specifier), (s) =>
      at('specifier', s.label.position),
    ),
  ),
  ...Option.toArray(
    Option.map(Option.fromNullishOr(heading.sink), (s) => at('sink', s.position)),
  ),
]

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
    ...Array.map(anchors, (anchor) =>
      at(anchorKind(scope, anchor), anchor.name.position),
    ),
    ...Array.flatMap(section.code, delimiterOf),
    ...Array.flatMap(section.entries ?? [], tocSymbols),
  ]
}

export const symbolsOf = (doc: LoomDocument): ReadonlyArray<Symbol> => {
  const warps = Array.flatMap(doc.preamble, (weft) => weft.warps)
  const scope = new Set(namesOf(warps))
  return [
    ...Array.flatMap(
      Option.toArray(Option.fromNullishOr(doc.frontmatter)),
      frontmatterSymbols,
    ),
    ...Array.map(warps, (warp) => at('warpDef', warp.name.position)),
    ...Array.map(
      Array.flatMap(doc.preamble, (weft) => weft.anchors),
      (anchor) => at(anchorKind(scope, anchor), anchor.name.position),
    ),
    ...Array.flatMap(doc.sections, (section) =>
      sectionSymbols(section, namesOf(warps)),
    ),
  ]
}

export const symbolAt = (
  doc: LoomDocument,
  offset: number,
): Option.Option<Symbol> =>
  Array.findFirst(
    symbolsOf(doc),
    (symbol) =>
      symbol.position.start.offset <= offset &&
      offset <= symbol.position.end.offset,
  )
