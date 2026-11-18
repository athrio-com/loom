import { Array, Context, Effect, Layer, Match, Option, pipe, Result } from 'effect'
import { type Health, okHealth, type Position } from '@athrio/loom-ast/LoomNode'
import type {
  ClaimedDocument,
  ClaimedSection,
  ExpandedDocument,
  ExpandedHeading,
  ExpandedSection,
  LoomDocument,
  LoomFrontmatter,
  ParsedDocument,
  ParsedHeading,
} from '@athrio/loom-ast/LoomAst'
import {
  anchorKeys,
  anchorKinds,
  boxKeys,
  type BoxToken,
  codelessKinds,
  eachType,
  type FrontmatterKindToken,
  headingKeys,
  holdsReferences,
  isList,
  type Keys,
  keyType,
  kindNamed,
  labelKey,
  loomKinds,
  ParameterKeyTokenSchema,
  type ParameterToken,
  ParameterTokenSchema,
  type ParameterValueToken,
  ParameterValueTokenSchema,
  type ParametersToken,
  ParametersTokenSchema,
  readAs,
  renamedTo,
  type ScalarType,
  sectionKinds,
  specifierKind,
  type SpecifierLabelToken,
  type SpecifierToken,
  type Standing,
  type ValueType,
  type WarpAnchorToken,
  type Zone,
} from '@athrio/loom-ast/LoomTokens'
import { rewritten } from '@athrio/loom-ast/TreeFold'
import {
  type ArrowWeft,
  type CodeWeft,
  type FenceWeft,
  type PreambleWeft,
  type ProseWeft,
  type SectionBodyWeft,
  standingOf,
  type TildeWeft,
} from '@athrio/loom-ast/Weft'
import {
  type BracesOn,
  faulty,
  KindOutsideLoom,
  LabelBesideParameter,
  type LoomFault,
  ManyValues,
  MisplacedAnchor,
  NumberOnKind,
  RenamedKind,
  RepeatedKey,
  UnknownKey,
  UnknownKind,
  WrongValue,
} from '#ast/LoomFault'

export type KeyedKind = { readonly kind: string; readonly parameters: Keys }

export type SectionKind = KeyedKind & { readonly codeless: boolean }

export type AnchorKind = KeyedKind & { readonly standsIn: Option.Option<Standing> }

export type KindOfLoom = {
  readonly kind: string
  readonly numbered: boolean
  readonly zone: Zone
  readonly codeless: boolean
  readonly holds: ReadonlyArray<string>
}

export type Declared = {
  readonly section: ReadonlyArray<SectionKind>
  readonly anchor: ReadonlyArray<AnchorKind>
  readonly box: ReadonlyArray<KeyedKind>
  readonly loom: ReadonlyArray<KindOfLoom>
  readonly headings: Keys
}

export const nothingDeclared: Declared = {
  section: [],
  anchor: [],
  box: [],
  loom: [],
  headings: {},
}

const kindsOf = (declared: ReadonlyArray<{ readonly kind: string }>): ReadonlyArray<string> =>
  Array.map(declared, (each) => each.kind)

export class LoomDocumentBuilder extends Context.Service<LoomDocumentBuilder>()(
  'LoomDocumentBuilder',
  {
    make: Effect.succeed({
      build: (parsed: ParsedDocument, declared: Declared = nothingDeclared): LoomDocument => {
        const kinds = [...sectionKinds, ...kindsOf(declared.section)]
        const codeless = [
          ...codelessKinds,
          ...kindsOf(Array.filter(declared.section, (each) => each.codeless)),
        ]
        return pipe(
          parsed,
          expandedDocument(kinds),
          claimedDocument(kinds, codeless, declared.loom),
          checkedDocument(coreKeys, declared),
          referringDocument(coreKeys, declared),
          placedDocument(declared.anchor),
        )
      },
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make)
}

export const expandedDocument =
  (kinds: ReadonlyArray<string>) =>
  (parsed: ParsedDocument): ExpandedDocument =>
    rewritten(parsed, {
      LoomHeading: expandedHeading(kinds),
      WarpAnchor: (anchor: WarpAnchorToken): WarpAnchorToken => judged(besideParameters(kindKey))(anchor),
      Box: (box: BoxToken): BoxToken => judged(besideParameters(kindKey))(box),
    })

const expandedHeading =
  (kinds: ReadonlyArray<string>) =>
  (heading: ParsedHeading): ExpandedHeading =>
    judged(besideParameters(labelKey(kinds)))({
      ...heading,
      specifier: Option.getOrUndefined(
        Option.map(Option.fromNullishOr(heading.specifier), inFull(kinds)),
      ),
    })

const inFull =
  (kinds: ReadonlyArray<string>) =>
  (specifier: SpecifierToken | ParametersToken): ParametersToken =>
    Match.value(specifier).pipe(
      Match.when({ type: 'Parameters' }, (held) => held),
      Match.when({ type: 'Specifier' }, expandedLabel(kinds)),
      Match.exhaustive,
    )

const expandedLabel =
  (kinds: ReadonlyArray<string>) =>
  (labelled: SpecifierToken): ParametersToken =>
    ParametersTokenSchema.make({
      position: labelled.position,
      source: labelled.source,
      health: {
        status: labelled.health.status,
        diagnostics: [...labelled.health.diagnostics, ...labelled.label.health.diagnostics],
      },
      unexpected: [...(labelled.unexpected ?? []), ...(labelled.label.unexpected ?? [])],
      open: labelled.open,
      parameters:
        labelled.label.health.status === 'ok' ? [labelParameter(kinds)(labelled.label)] : [],
      labels: [],
      close: labelled.close,
    })

const labelParameter =
  (kinds: ReadonlyArray<string>) =>
  (label: SpecifierLabelToken): ParameterToken =>
    ParameterTokenSchema.make({
      position: label.position,
      source: label.source,
      health: okHealth,
      key: ParameterKeyTokenSchema.make({
        position: { start: label.position.start, end: label.position.start },
        source: '',
        health: okHealth,
        value: labelKey(kinds)(label.value),
      }),
      values: [
        ParameterValueTokenSchema.make({
          position: label.position,
          source: label.source,
          health: okHealth,
          value: label.value,
        }),
      ],
    })

const kindKey = (): string => 'kind'

const faultedLabels =
  (keyOf: (label: string) => string) =>
  (held: ParametersToken): Option.Option<ParametersToken> =>
    Array.match(held.labels, {
      onEmpty: () => Option.none(),
      onNonEmpty: (labels) => {
        const faulted = Array.map(labels, (label) => ({
          ...label,
          health: faulty(
            LabelBesideParameter({ label: label.value, key: keyOf(label.value) }),
            label.position,
          ),
        }))
        return Option.some({
          ...held,
          health: { ...held.health, status: Array.headNonEmpty(faulted).health.status },
          labels: faulted,
        })
      },
    })

const besideParameters =
  (keyOf: (label: string) => string) =>
  (braces: Braces): Option.Option<Braces> =>
    braces.type === 'Parameters' ? faultedLabels(keyOf)(braces) : Option.none()

type Held = { readonly kind: string; readonly looms: ReadonlyArray<string> }

type Scope = {
  readonly kinds: ReadonlyArray<string>
  readonly codeless: ReadonlyArray<string>
  readonly elsewhere: ReadonlyArray<Held>
  readonly loom: Option.Option<KindOfLoom>
}

const sameWord = (one: string, other: string): boolean => one.toLowerCase() === other.toLowerCase()

const holdsKind =
  (kind: string) =>
  (loom: KindOfLoom): boolean =>
    Array.some(loom.holds, (held) => sameWord(held, kind))

const loomNamed = (looms: ReadonlyArray<KindOfLoom>, word: string): Option.Option<KindOfLoom> =>
  Array.findFirst(looms, (loom) => sameWord(loom.kind, word))

const ownKind = (
  looms: ReadonlyArray<KindOfLoom>,
  expanded: ExpandedDocument,
): Option.Option<KindOfLoom> =>
  Option.flatMap(Option.fromNullishOr(expanded.frontmatter?.kind), (named) =>
    loomNamed(looms, named.value),
  )

const heldElsewhere = (
  looms: ReadonlyArray<KindOfLoom>,
  own: Option.Option<KindOfLoom>,
): ReadonlyArray<Held> =>
  pipe(
    Array.flatMap(looms, (loom) => loom.holds),
    Array.dedupeWith(sameWord),
    Array.filter((kind) => !Option.exists(own, holdsKind(kind))),
    Array.map((kind): Held => ({ kind, looms: kindsOf(Array.filter(looms, holdsKind(kind))) })),
  )

const isHeld =
  (kind: string) =>
  (held: Held): boolean =>
    sameWord(held.kind, kind)

export const claimedDocument =
  (
    kinds: ReadonlyArray<string>,
    codeless: ReadonlyArray<string> = codelessKinds,
    looms: ReadonlyArray<KindOfLoom> = [],
  ) =>
  (expanded: ExpandedDocument): ClaimedDocument => {
    const loom = ownKind(looms, expanded)
    const elsewhere = heldElsewhere(looms, loom)
    const scope: Scope = {
      kinds: Array.filter(kinds, (kind) => !Array.some(elsewhere, isHeld(kind))),
      codeless,
      elsewhere,
      loom,
    }
    return rewritten(expanded, {
      LoomFrontmatter: claimedFrontmatter(looms),
      LoomSection: claimedSection(scope),
    })
  }

type KindStated = {
  readonly held: ParametersToken
  readonly parameter: ParameterToken
  readonly value: ParameterValueToken
}

const kindStated = (heading: ExpandedHeading): Option.Option<KindStated> =>
  pipe(
    Option.fromNullishOr(heading.specifier),
    Option.flatMap((held) =>
      pipe(
        Array.findFirst(held.parameters, (parameter) => parameter.key.value === 'kind'),
        Option.flatMap((parameter) =>
          Option.map(Array.head(parameter.values), (value) => ({ held, parameter, value })),
        ),
      ),
    ),
  )

const inCodelessLoom =
  (loom: Option.Option<KindOfLoom>) =>
  (section: ClaimedSection): ClaimedSection =>
    Option.match(
      Option.filter(loom, (own) => own.codeless && section.codeless === undefined),
      {
        onNone: () => section,
        onSome: (own) => ({ ...section, codeless: { kind: own.kind, of: 'loom' as const } }),
      },
    )

const claimedSection =
  (scope: Scope) =>
  (section: ExpandedSection): ClaimedSection =>
    inCodelessLoom(scope.loom)(
      Option.match(kindStated(section.heading), {
        onNone: (): ClaimedSection => section,
        onSome: (stated) =>
          Option.match(kindNamed(scope.kinds)(stated.value.value), {
            onSome: (kind): ClaimedSection =>
              Array.contains(scope.codeless, kind)
                ? { ...section, kind, codeless: { kind, of: 'section' as const } }
                : { ...section, kind },
            onNone: (): ClaimedSection => ({
              ...section,
              heading: unclaimed(scope)(section.heading, stated),
            }),
          }),
      }),
    )

const unclaimed =
  (scope: Scope) =>
  (heading: ExpandedHeading, stated: KindStated): ExpandedHeading => {
    const fault = faulty(
      Option.match(Array.findFirst(scope.elsewhere, isHeld(stated.value.value)), {
        onNone: (): LoomFault =>
          UnknownKind({ kind: stated.value.value, kinds: scope.kinds, on: 'heading' }),
        onSome: (held): LoomFault => KindOutsideLoom(held),
      }),
      stated.value.position,
    )
    return {
      ...heading,
      health: { ...heading.health, status: fault.status },
      specifier: {
        ...stated.held,
        health: { ...stated.held.health, status: fault.status },
        parameters: Array.map(stated.held.parameters, (parameter) =>
          parameter === stated.parameter ? { ...parameter, health: fault } : parameter,
        ),
      },
    }
  }

const claimedKind =
  (looms: ReadonlyArray<KindOfLoom>) =>
  (named: FrontmatterKindToken): FrontmatterKindToken =>
    Option.match(loomNamed(looms, named.value), {
      onNone: () => ({
        ...named,
        health: faulty(
          UnknownKind({ kind: named.value, kinds: [...loomKinds, ...kindsOf(looms)], on: 'loom' }),
          named.position,
        ),
      }),
      onSome: (loom) => ({
        ...named,
        value: loom.kind,
        zone: loom.zone,
        health:
          loom.numbered || named.number === ''
            ? named.health
            : faulty(NumberOnKind({ kind: loom.kind }), named.position),
      }),
    })

const claimedFrontmatter =
  (looms: ReadonlyArray<KindOfLoom>) =>
  (frontmatter: LoomFrontmatter): LoomFrontmatter =>
    Option.match(Option.fromNullishOr(frontmatter.kind), {
      onNone: () => frontmatter,
      onSome: (named) => ({ ...frontmatter, kind: claimedKind(looms)(named) }),
    })

type Takes = {
  readonly on: BracesOn
  readonly keys: Keys
  readonly kinds: Option.Option<ReadonlyArray<string>>
}

export const coreKeys: Record<BracesOn, Keys> = {
  heading: headingKeys,
  anchor: anchorKeys,
  box: boxKeys,
}

const takesOn =
  (keys: Record<BracesOn, Keys>, declared: Declared) =>
  (on: BracesOn): Takes =>
    Match.value(on).pipe(
      Match.when('heading', () => ({
        on,
        keys: { ...keys.heading, ...declared.headings },
        kinds: Option.none(),
      })),
      Match.when('anchor', () => ({
        on,
        keys: keys.anchor,
        kinds: Option.some([...anchorKinds, ...kindsOf(declared.anchor)]),
      })),
      Match.when('box', () => ({ on, keys: keys.box, kinds: Option.none() })),
      Match.exhaustive,
    )

const withKind = (
  takes: Takes,
  declared: ReadonlyArray<KeyedKind>,
  kind: Option.Option<string>,
): Takes =>
  pipe(
    kind,
    Option.flatMap((named) =>
      Array.findFirst(declared, (each) => each.kind.toLowerCase() === named.toLowerCase()),
    ),
    Option.match({
      onNone: () => takes,
      onSome: (found) => ({ ...takes, keys: { ...takes.keys, ...found.parameters } }),
    }),
  )

const bracedKind = (bearer: Braced): Option.Option<string> =>
  Option.flatMap(Option.fromNullishOr(bearer.specifier), specifierKind)

type OnBearer = (takes: Takes) => <Bearer extends Braced>(bearer: Bearer) => Bearer

const bracedSection =
  (takes: Takes, declared: ReadonlyArray<KeyedKind>, step: OnBearer) =>
  (section: ClaimedSection): ClaimedSection => {
    const ofKind = withKind(takes, declared, Option.fromNullishOr(section.kind))
    const heading = step(ofKind)(section.heading)
    return heading === section.heading ? section : { ...section, heading }
  }

const overBraces =
  (keys: Record<BracesOn, Keys>, declared: Declared, step: OnBearer) =>
  (claimed: ClaimedDocument): ClaimedDocument => {
    const takes = takesOn(keys, declared)
    const inside: ClaimedDocument = rewritten(claimed, {
      WarpAnchor: (anchor: WarpAnchorToken): WarpAnchorToken =>
        step(withKind(takes('anchor'), declared.anchor, bracedKind(anchor)))(anchor),
      Box: (box: BoxToken): BoxToken =>
        step(withKind(takes('box'), declared.box, bracedKind(box)))(box),
    })
    return rewritten(inside, {
      LoomSection: bracedSection(takes('heading'), declared.section, step),
    })
  }

export const checkedDocument = (
  keys: Record<BracesOn, Keys>,
  declared: Declared = nothingDeclared,
): ((claimed: ClaimedDocument) => ClaimedDocument) =>
  overBraces(keys, declared, (takes) => judged(faultedBraces(takes)))

const faultedBraces =
  (takes: Takes) =>
  (braces: Braces): Option.Option<Braces> =>
    Match.value(braces).pipe(
      Match.when({ type: 'Parameters' }, faultedParameters(takes)),
      Match.when({ type: 'Specifier' }, faultedLabel(takes)),
      Match.exhaustive,
    )

type Valued = { readonly value: string; readonly position: Position }

const kindFault = (takes: Takes, kinds: ReadonlyArray<string>, kind: string): LoomFault =>
  Option.match(renamedTo(kind), {
    onNone: () => UnknownKind({ kind, kinds, on: takes.on }),
    onSome: (now) => RenamedKind({ kind, now }),
  })

const unknownKind = (takes: Takes, values: ReadonlyArray<Valued>): Option.Option<Health> =>
  Option.flatMap(takes.kinds, (kinds) =>
    Option.map(
      Array.findFirst(values, (stated) => Option.isNone(kindNamed(kinds)(stated.value))),
      (stated) => faulty(kindFault(takes, kinds, stated.value), stated.position),
    ),
  )

const namedKindFault = (takes: Takes, parameter: ParameterToken): Option.Option<Health> =>
  parameter.key.value === 'kind' ? unknownKind(takes, parameter.values) : Option.none()

const unreadValue = (
  key: string,
  type: ScalarType,
  values: ReadonlyArray<ParameterValueToken>,
): Option.Option<Health> =>
  Array.findFirst(values, (value) =>
    Result.match(readAs(type)(value.value), {
      onSuccess: () => Option.none(),
      onFailure: (unread) =>
        Option.some(faulty(WrongValue({ key, value: value.value, unread }), value.position)),
    }),
  )

const valueFault = (type: ValueType, parameter: ParameterToken): Option.Option<Health> =>
  !isList(type) && parameter.values.length > 1
    ? Option.some(faulty(ManyValues({ key: parameter.key.value }), parameter.position))
    : unreadValue(parameter.key.value, eachType(type), parameter.values)

const parameterFault = (
  takes: Takes,
  parameter: ParameterToken,
  earlier: ReadonlyArray<ParameterToken>,
): Option.Option<Health> => {
  const key = parameter.key.value
  return Array.some(earlier, (before) => before.key.value === key)
    ? Option.some(faulty(RepeatedKey({ key }), parameter.key.position))
    : Option.match(keyType(takes.keys, key), {
        onNone: () =>
          Option.some(
            faulty(
              UnknownKey({ key, keys: Object.keys(takes.keys), on: takes.on }),
              parameter.key.position,
            ),
          ),
        onSome: (type) =>
          Option.orElse(valueFault(type, parameter), () => namedKindFault(takes, parameter)),
      })
}

const faultedParameters =
  (takes: Takes) =>
  (held: ParametersToken): Option.Option<ParametersToken> => {
    const faults = Array.map(held.parameters, (parameter, at) =>
      parameterFault(takes, parameter, Array.take(held.parameters, at)),
    )
    return Option.map(Array.head(Array.getSomes(faults)), (first) => ({
      ...held,
      health: { ...held.health, status: first.status },
      parameters: Array.zipWith(held.parameters, faults, (parameter, fault) =>
        Option.match(fault, {
          onNone: () => parameter,
          onSome: (health) => ({ ...parameter, health }),
        }),
      ),
    }))
  }

const faultedLabel =
  (takes: Takes) =>
  (labelled: SpecifierToken): Option.Option<SpecifierToken> =>
    pipe(
      Option.liftPredicate(labelled.label, (label) => label.health.status === 'ok'),
      Option.flatMap((label) => unknownKind(takes, [label])),
      Option.map((fault) => ({
        ...labelled,
        health: { ...labelled.health, status: fault.status },
        label: { ...labelled.label, health: fault },
      })),
    )

type Braces = SpecifierToken | ParametersToken

type Braced = { readonly health: Health; readonly specifier?: Braces | undefined }

const judged =
  (faulted: (braces: Braces) => Option.Option<Braces>) =>
  <Bearer extends Braced>(bearer: Bearer): Bearer =>
    pipe(
      Option.fromNullishOr(bearer.specifier),
      Option.flatMap(faulted),
      Option.match({
        onNone: () => bearer,
        onSome: (braces) => ({
          ...bearer,
          health: { ...bearer.health, status: braces.health.status },
          specifier: braces,
        }),
      }),
    )

const referringBraces =
  (takes: Takes) =>
  (braces: Braces): Option.Option<Braces> => {
    const refers = (parameter: ParameterToken): boolean =>
      Option.exists(keyType(takes.keys, parameter.key.value), holdsReferences)
    return Match.value(braces).pipe(
      Match.when({ type: 'Parameters' }, (held) =>
        Array.some(held.parameters, refers)
          ? Option.some<Braces>({
              ...held,
              parameters: Array.map(held.parameters, (parameter) =>
                refers(parameter) ? { ...parameter, refers: true as const } : parameter,
              ),
            })
          : Option.none<Braces>(),
      ),
      Match.when({ type: 'Specifier' }, () => Option.none<Braces>()),
      Match.exhaustive,
    )
  }

const rebraced =
  (rewrite: (braces: Braces) => Option.Option<Braces>) =>
  <Bearer extends Braced>(bearer: Bearer): Bearer =>
    pipe(
      Option.fromNullishOr(bearer.specifier),
      Option.flatMap(rewrite),
      Option.match({
        onNone: () => bearer,
        onSome: (braces) => ({ ...bearer, specifier: braces }),
      }),
    )

export const referringDocument = (
  keys: Record<BracesOn, Keys>,
  declared: Declared = nothingDeclared,
): ((claimed: ClaimedDocument) => ClaimedDocument) =>
  overBraces(keys, declared, (takes) => rebraced(referringBraces(takes)))

const kindFaulted =
  (fault: LoomFault) =>
  (braces: Braces): Option.Option<Braces> =>
    Match.value(braces).pipe(
      Match.when({ type: 'Specifier' }, (labelled) => {
        const health = faulty(fault, labelled.label.position)
        return Option.some<Braces>({
          ...labelled,
          health: { ...labelled.health, status: health.status },
          label: { ...labelled.label, health },
        })
      }),
      Match.when({ type: 'Parameters' }, (held) =>
        Option.map(
          Array.findFirst(held.parameters, (parameter) => parameter.key.value === 'kind'),
          (stated): Braces => {
            const health = faulty(
              fault,
              Option.getOrElse(
                Option.map(Array.head(stated.values), (value) => value.position),
                () => stated.position,
              ),
            )
            return {
              ...held,
              health: { ...held.health, status: health.status },
              parameters: Array.map(held.parameters, (parameter) =>
                parameter === stated ? { ...parameter, health } : parameter,
              ),
            }
          },
        ),
      ),
      Match.exhaustive,
    )

const placedAnchor =
  (kinds: ReadonlyArray<AnchorKind>, standing: Standing) =>
  (anchor: WarpAnchorToken): WarpAnchorToken =>
    pipe(
      bracedKind(anchor),
      Option.flatMap((named) =>
        Array.findFirst(kinds, (each) => each.kind.toLowerCase() === named.toLowerCase()),
      ),
      Option.flatMap((kind) =>
        Option.map(
          Option.filter(kind.standsIn, (place) => place !== standing),
          (place) => MisplacedAnchor({ kind: kind.kind, standsIn: place }),
        ),
      ),
      Option.match({
        onNone: () => anchor,
        onSome: (fault) => judged(kindFaulted(fault))(anchor),
      }),
    )

type Lined = { readonly anchors: ReadonlyArray<WarpAnchorToken> }

const placedLine =
  (kinds: ReadonlyArray<AnchorKind>, standing: Standing) =>
  <Line extends Lined>(line: Line): Line => {
    const anchors = Array.map(line.anchors, placedAnchor(kinds, standing))
    return Array.every(anchors, (anchor, at) => anchor === line.anchors[at])
      ? line
      : { ...line, anchors }
  }

export const placedDocument =
  (kinds: ReadonlyArray<AnchorKind>) =>
  (claimed: ClaimedDocument): ClaimedDocument => {
    const placed = <Line extends PreambleWeft | SectionBodyWeft>(line: Line): Line =>
      placedLine(kinds, standingOf(line))(line)
    return Array.some(kinds, (each) => Option.isSome(each.standsIn))
      ? rewritten(claimed, {
          PreambleWeft: (line: PreambleWeft): PreambleWeft => placed(line),
          TildeWeft: (line: TildeWeft): TildeWeft => placed(line),
          ProseWeft: (line: ProseWeft): ProseWeft => placed(line),
          ArrowWeft: (line: ArrowWeft): ArrowWeft => placed(line),
          CodeWeft: (line: CodeWeft): CodeWeft => placed(line),
          FenceWeft: (line: FenceWeft): FenceWeft => placed(line),
        })
      : claimed
  }
