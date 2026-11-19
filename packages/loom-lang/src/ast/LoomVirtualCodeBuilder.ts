import { Array, Context, Effect, Layer, Option, pipe } from 'effect'
import {
  isMeant,
  keyOf,
  type Code,
  type Fragment,
  type ModuleRef,
  type Part,
  type Provided,
  type Ref,
  type SectionId,
} from '@athrio/loom-ast/ProductAst'
import { byType, type Position } from '@athrio/loom-ast/LoomNode'
import {
  catalogueOf,
  type Catalogue,
  type LoomModule,
  type Location,
  promisedThrough,
  type TropeContract,
  tropeContractsIn,
} from '@athrio/loom-ast/LoomCorpusAst'
import {
  type Landing,
  landingOf,
  ModuleFile,
  moduleFileOf,
  sectionNameOf,
  targetOf,
} from '#ast/ProductBuilder'
import { type LoomDocument } from '@athrio/loom-ast/LoomAst'
import { symbolsOf } from '@athrio/loom-ast/LoomSymbol'
import {
  type LoomVirtualCode,
  type Mapping,
  type MappingKind,
} from '@athrio/loom-ast/LoomVirtualCode'

const lookup = (modules: ReadonlyMap<Location, LoomModule>, id: SectionId): Option.Option<Code> =>
  pipe(
    Option.fromNullishOr(modules.get(id.path)),
    Option.flatMapNullishOr((m) => m.product),
    Option.flatMap((product) => Array.findFirst(product.code, (c) => c.origin.name === id.name)),
  )

const leaf = (
  id: string,
  languageId: string,
  code: string,
  mappings: ReadonlyArray<Mapping>,
): LoomVirtualCode => ({ id, languageId, code, mappings, embeddedCodes: [] })

const emptyLeaf: LoomVirtualCode = leaf('', '', '', [])

const concat = (a: LoomVirtualCode, b: LoomVirtualCode): LoomVirtualCode => ({
  id: a.id,
  languageId: a.languageId,
  code: a.code + b.code,
  mappings: [
    ...a.mappings,
    ...b.mappings.map((m) => ({
      ...m,
      genStart: m.genStart + a.code.length,
    })),
  ],
  embeddedCodes: a.embeddedCodes,
})

const clipMappings = (mappings: ReadonlyArray<Mapping>, genLen: number): ReadonlyArray<Mapping> =>
  Array.getSomes(
    mappings.map((m) =>
      m.genStart >= genLen
        ? Option.none()
        : Option.some(
            m.genStart + m.genLength <= genLen ? m : { ...m, genLength: genLen - m.genStart },
          ),
    ),
  )

const absorbTrailingNewline = (vc: LoomVirtualCode): LoomVirtualCode => {
  const code = vc.code.replace(/\n+$/, '')
  return code.length === vc.code.length
    ? vc
    : { ...vc, code, mappings: clipMappings(vc.mappings, code.length) }
}

export type Specifiers = (owner: Location, ref: ModuleRef) => Option.Option<string>

export const noSpecifiers: Specifiers = () => Option.none()

const mappedIn = (text: string, source: Position, owner: Location, home: Location) =>
  leaf(
    '',
    '',
    text,
    owner === home ? [{ genStart: 0, genLength: text.length, source, kind: 'product' }] : [],
  )

const inlinePart = byType<
  Part,
  [
    within: {
      readonly modules: ReadonlyMap<Location, LoomModule>
      readonly catalogue: Catalogue
      readonly seen: ReadonlySet<string>
      readonly home: Location
      readonly owner: Location
      readonly specifiers: Specifiers
    },
  ]
>()<LoomVirtualCode>({
  Fragment: (fragment, { home, owner }) =>
    mappedIn(fragment.text, fragment.origin, owner, home),
  ModuleRef: (ref, { home, owner, specifiers }) =>
    Option.match(specifiers(owner, ref), {
      onNone: () => emptyLeaf,
      onSome: (specifier) => mappedIn(specifier, ref.anchor, owner, home),
    }),
  NameRef: (ref, { modules, catalogue, seen, home, owner, specifiers }) =>
    pipe(
      targetOf(catalogue, owner, ref),
      Option.filter((t) => !seen.has(keyOf(t))),
      Option.flatMap((t) => Option.map(lookup(modules, t), (node) => [t, node] as const)),
      Option.match({
        onNone: () => emptyLeaf,
        onSome: ([t, node]) =>
          absorbTrailingNewline(
            inlineComposed(
              modules,
              catalogue,
              new Set([...seen, keyOf(t)]),
              home,
              specifiers,
            )(node),
          ),
      }),
    ),
})

type Inlined = { readonly vc: LoomVirtualCode; readonly trim: boolean }

const withPart = byType<
  Part,
  [
    within: {
      readonly acc: Inlined
      readonly build: (part: Part) => LoomVirtualCode
      readonly node: Code
      readonly i: number
    },
  ]
>()<Inlined>({
  Fragment: (fragment, { acc, build }) => ({
    vc: concat(acc.vc, build(acc.trim ? trimLeadingBlank(fragment) : fragment)),
    trim: false,
  }),
  ModuleRef: (ref, { acc, build }) =>
    ({ vc: concat(acc.vc, build(ref)), trim: false }),
  NameRef: (ref, { acc, build, node, i }) => {
    const owns = aloneBefore(acc.vc.code) && aloneAfter(node.fragments[i + 1])
    return {
      vc: concat(
        acc.vc,
        owns ? indentBlock(build(ref), lineIndentOf(acc.vc.code)) : build(ref),
      ),
      trim: owns,
    }
  },
})

const inlineComposed =
  (
    modules: ReadonlyMap<Location, LoomModule>,
    catalogue: Catalogue,
    seen: ReadonlySet<string>,
    home: Location,
    specifiers: Specifiers,
  ) =>
  (node: Code): LoomVirtualCode => {
    const build = (part: Part): LoomVirtualCode =>
      inlinePart(part, { modules, catalogue, seen, home, owner: node.origin.path, specifiers })
    const seed: Inlined = { vc: emptyLeaf, trim: false }
    return pipe(
      node.fragments.reduce((acc, part, i) => withPart(part, { acc, build, node, i }), seed),
      (acc) => acc.vc,
    )
  }

export type Unsettled = {
  readonly path: Location
  readonly anchor: Position
  readonly name: string
  readonly section: Option.Option<SectionId>
  readonly provides: ReadonlyArray<Provided>
  readonly moduleAnchor: boolean
  readonly declared: boolean
}

const unsettledAt = (owner: Location, ref: Ref, section: Option.Option<SectionId>): Unsettled => ({
  path: owner,
  anchor: ref.anchor,
  name: ref.name,
  section,
  provides: ref.provides,
  moduleAnchor: false,
  declared: Option.isSome(section),
})

const unsettledModuleRef = (
  modules: ReadonlyMap<Location, LoomModule>,
  catalogue: Catalogue,
  host: Code,
  ref: ModuleRef,
): Option.Option<Unsettled> =>
  Option.flatMap(Option.fromNullishOr(modules.get(host.origin.path)), (module) =>
    ModuleFile.$match(moduleFileOf(catalogue, modules, {}, module, host, ref), {
      Unsettled: ({ declared }) =>
        Option.some<Unsettled>({
          path: host.origin.path,
          anchor: ref.anchor,
          name: ref.name,
          section: Option.none(),
          provides: ref.provides,
          moduleAnchor: true,
          declared,
        }),
      Named: () => Option.none(),
      Faulted: () => Option.none(),
    }),
  )

export const unsettledRef = (
  modules: ReadonlyMap<Location, LoomModule>,
  catalogue: Catalogue,
  owner: Location,
  ref: Ref,
): Option.Option<Unsettled> =>
  Option.match(targetOf(catalogue, owner, ref), {
    onNone: () => {
      const promised = promisedThrough(catalogue, owner, ref.name)
      return isMeant(ref) || Array.isReadonlyArrayNonEmpty(promised)
        ? Option.some(
            unsettledAt(owner, { ...ref, provides: [...ref.provides, ...promised] }, Option.none()),
          )
        : Option.none()
    },
    onSome: (target) =>
      pipe(
        lookup(modules, target),
        Option.filter((code) => !Array.isReadonlyArrayNonEmpty(code.fragments)),
        Option.map(() => unsettledAt(owner, ref, Option.some(target))),
      ),
  })

const unsettledInPart = byType<
  Part,
  [
    within: {
      readonly modules: ReadonlyMap<Location, LoomModule>
      readonly catalogue: Catalogue
      readonly seen: ReadonlySet<string>
      readonly node: Code
    },
  ]
>()<ReadonlyArray<Unsettled>>({
  Fragment: (): ReadonlyArray<Unsettled> => [],
  ModuleRef: (ref, { modules, catalogue, node }) =>
    Option.toArray(unsettledModuleRef(modules, catalogue, node, ref)),
  NameRef: (ref, { modules, catalogue, seen, node }) =>
    Option.match(unsettledRef(modules, catalogue, node.origin.path, ref), {
      onSome: (unsettled): ReadonlyArray<Unsettled> => [unsettled],
      onNone: () =>
        pipe(
          targetOf(catalogue, node.origin.path, ref),
          Option.filter((reached) => !seen.has(keyOf(reached))),
          Option.flatMap((reached) =>
            Option.map(lookup(modules, reached), (code) =>
              unsettledFrom(modules, catalogue, new Set([...seen, keyOf(reached)]))(code),
            ),
          ),
          Option.getOrElse((): ReadonlyArray<Unsettled> => []),
        ),
    }),
})

const unsettledFrom =
  (modules: ReadonlyMap<Location, LoomModule>, catalogue: Catalogue, seen: ReadonlySet<string>) =>
  (node: Code): ReadonlyArray<Unsettled> =>
    node.fragments.flatMap((part) => unsettledInPart(part, { modules, catalogue, seen, node }))

export const unsettledIn = (
  modules: ReadonlyMap<Location, LoomModule>,
  root: Code,
  catalogue: Catalogue = catalogueOf(modules),
): ReadonlyArray<Unsettled> =>
  unsettledFrom(modules, catalogue, new Set([keyOf(root.origin)]))(root)

export interface HeldModuleRef {
  readonly owner: Location
  readonly host: Code
  readonly ref: ModuleRef
}

const moduleRefsInPart = byType<
  Part,
  [
    within: {
      readonly modules: ReadonlyMap<Location, LoomModule>
      readonly catalogue: Catalogue
      readonly seen: ReadonlySet<string>
      readonly node: Code
    },
  ]
>()<ReadonlyArray<HeldModuleRef>>({
  Fragment: (): ReadonlyArray<HeldModuleRef> => [],
  ModuleRef: (ref, { node }): ReadonlyArray<HeldModuleRef> => [
    { owner: node.origin.path, host: node, ref },
  ],
  NameRef: (ref, { modules, catalogue, seen, node }) =>
    pipe(
      targetOf(catalogue, node.origin.path, ref),
      Option.filter((reached) => !seen.has(keyOf(reached))),
      Option.flatMap((reached) =>
        Option.map(lookup(modules, reached), (code) =>
          moduleRefsFrom(modules, catalogue, new Set([...seen, keyOf(reached)]))(code),
        ),
      ),
      Option.getOrElse((): ReadonlyArray<HeldModuleRef> => []),
    ),
})

const moduleRefsFrom =
  (modules: ReadonlyMap<Location, LoomModule>, catalogue: Catalogue, seen: ReadonlySet<string>) =>
  (node: Code): ReadonlyArray<HeldModuleRef> =>
    node.fragments.flatMap((part) => moduleRefsInPart(part, { modules, catalogue, seen, node }))

export const moduleRefsIn = (
  modules: ReadonlyMap<Location, LoomModule>,
  root: Code,
  catalogue: Catalogue = catalogueOf(modules),
): ReadonlyArray<HeldModuleRef> =>
  moduleRefsFrom(modules, catalogue, new Set([keyOf(root.origin)]))(root)

const unfoundInPart = byType<
  Part,
  [
    within: {
      readonly modules: ReadonlyMap<Location, LoomModule>
      readonly catalogue: Catalogue
      readonly seen: ReadonlySet<string>
      readonly node: Code
    },
  ]
>()<ReadonlyArray<string>>({
  Fragment: (): ReadonlyArray<string> => [],
  ModuleRef: (): ReadonlyArray<string> => [],
  NameRef: (ref, { modules, catalogue, seen, node }) =>
    Option.match(targetOf(catalogue, node.origin.path, ref), {
      onNone: (): ReadonlyArray<string> => [ref.name],
      onSome: (reached) =>
        pipe(
          Option.some(reached),
          Option.filter((found) => !seen.has(keyOf(found))),
          Option.flatMap((found) => lookup(modules, found)),
          Option.map(unfoundFrom(modules, catalogue, new Set([...seen, keyOf(reached)]))),
          Option.getOrElse((): ReadonlyArray<string> => []),
        ),
    }),
})

const unfoundFrom =
  (modules: ReadonlyMap<Location, LoomModule>, catalogue: Catalogue, seen: ReadonlySet<string>) =>
  (node: Code): ReadonlyArray<string> =>
    node.fragments.flatMap((part) => unfoundInPart(part, { modules, catalogue, seen, node }))

export const unfoundIn = (
  modules: ReadonlyMap<Location, LoomModule>,
  root: Code,
  catalogue: Catalogue = catalogueOf(modules),
): ReadonlyArray<string> => unfoundFrom(modules, catalogue, new Set([keyOf(root.origin)]))(root)

export type Contract = {
  readonly section: string
  readonly target: Location
  readonly span: Position
  readonly language: string
  readonly provides: ReadonlyArray<Provided>
  readonly trope: Option.Option<string>
}

const writtenSpan = (code: Code): Option.Option<Position> =>
  pipe(
    code.fragments.map((part) =>
      part.type === 'Fragment' ? Option.some(part.origin) : Option.none(),
    ),
    Array.getSomes,
    Array.match({
      onEmpty: () => Option.none(),
      onNonEmpty: (origins) =>
        Option.some({
          start: Array.headNonEmpty(origins).start,
          end: Array.lastNonEmpty(origins).end,
        }),
    }),
  )

const contractOf = (
  modules: ReadonlyMap<Location, LoomModule>,
  catalogue: Catalogue,
  path: Location,
  ref: Ref,
): Option.Option<Contract> =>
  Option.gen(function* () {
    const provides = yield* Option.liftPredicate(ref.provides, Array.isReadonlyArrayNonEmpty)
    const target = yield* targetOf(catalogue, path, ref)
    const code = yield* lookup(modules, target)
    const span = yield* writtenSpan(code)
    return {
      section: ref.name,
      target: target.path,
      span,
      language: code.languageId,
      provides,
      trope: Option.none(),
    }
  })

const composedOf =
  (modules: ReadonlyMap<Location, LoomModule>, catalogue: Catalogue, seen: ReadonlySet<string>) =>
  (node: Code): ReadonlyArray<Code> => [
    node,
    ...node.fragments.flatMap((part) =>
      part.type === 'NameRef'
        ? pipe(
            targetOf(catalogue, node.origin.path, part),
            Option.filter((reached) => !seen.has(keyOf(reached))),
            Option.flatMap((reached) =>
              Option.map(lookup(modules, reached), (code) =>
                composedOf(modules, catalogue, new Set([...seen, keyOf(reached)]))(code),
              ),
            ),
            Option.getOrElse((): ReadonlyArray<Code> => []),
          )
        : [],
    ),
  ]

const composedSpan = (
  modules: ReadonlyMap<Location, LoomModule>,
  catalogue: Catalogue,
  root: Code,
): Option.Option<Position> =>
  pipe(
    composedOf(
      modules,
      catalogue,
      new Set([keyOf(root.origin)]),
    )(root)
      .filter((code) => code.origin.path === root.origin.path)
      .map(writtenSpan),
    Array.getSomes,
    Array.match({
      onEmpty: () => Option.none(),
      onNonEmpty: (spans) =>
        Option.some(
          Array.tailNonEmpty(spans).reduce(
            (whole, span) => ({
              start: span.start.offset < whole.start.offset ? span.start : whole.start,
              end: span.end.offset > whole.end.offset ? span.end : whole.end,
            }),
            Array.headNonEmpty(spans),
          ),
        ),
    }),
  )

const moduleContractOf = (
  modules: ReadonlyMap<Location, LoomModule>,
  catalogue: Catalogue,
  landing: Landing,
  module: LoomModule,
  host: Code,
  ref: ModuleRef,
): Option.Option<Contract> =>
  Option.gen(function* () {
    const provides = yield* Option.liftPredicate(ref.provides, Array.isReadonlyArrayNonEmpty)
    const landed = yield* ModuleFile.$match(
      moduleFileOf(catalogue, modules, landing, module, host, ref),
      {
        Named: ({ landed }) => Option.some(landed),
        Unsettled: () => Option.none(),
        Faulted: () => Option.none(),
      },
    )
    const span = yield* composedSpan(modules, catalogue, landed.file.code)
    return {
      section: ref.name,
      target: landed.loom,
      span,
      language: landed.file.code.languageId,
      provides,
      trope: Option.none(),
    }
  })

const tropeContractOf = (
  modules: ReadonlyMap<Location, LoomModule>,
  contract: TropeContract,
): Option.Option<Contract> =>
  Option.gen(function* () {
    const code = yield* lookup(modules, {
      path: contract.entry.module,
      name: sectionNameOf(contract.entry.section),
    })
    const span = yield* writtenSpan(code)
    return {
      section: contract.entry.section.heading.title?.source ?? contract.trope,
      target: contract.entry.module,
      span,
      language: code.languageId,
      provides: contract.provides,
      trope: Option.some(contract.trope),
    }
  })

const contractOfPart = byType<
  Part,
  [
    within: {
      readonly modules: ReadonlyMap<Location, LoomModule>
      readonly catalogue: Catalogue
      readonly path: Location
      readonly landing: Landing
      readonly module: LoomModule
      readonly host: Code
    },
  ]
>()<Option.Option<Contract>>({
  NameRef: (ref, { modules, catalogue, path }) =>
    contractOf(modules, catalogue, path, ref),
  ModuleRef: (ref, { modules, catalogue, landing, module, host }) =>
    moduleContractOf(modules, catalogue, landing, module, host, ref),
  Fragment: () => Option.none<Contract>(),
})

export const contractsIn = (
  modules: ReadonlyMap<Location, LoomModule>,
  path: Location,
  catalogue: Catalogue = catalogueOf(modules),
): ReadonlyArray<Contract> =>
  Option.match(Option.fromNullishOr(modules.get(path)), {
    onNone: (): ReadonlyArray<Contract> => [],
    onSome: (module) => {
      const landing = landingOf(modules)
      return [
        ...Array.getSomes(
          module.product.code.flatMap((host) =>
            host.fragments.map((part) =>
              contractOfPart(part, { modules, catalogue, path, landing, module, host }),
            ),
          ),
        ),
        ...Array.getSomes(
          tropeContractsIn(catalogue, path).map((contract) => tropeContractOf(modules, contract)),
        ),
      ]
    },
  })

const aloneBefore = (code: string): boolean =>
  /^[\t ]*$/.test(code.slice(code.lastIndexOf('\n') + 1))

const aloneAfter = (next: Part | undefined): boolean =>
  next === undefined || (next.type === 'Fragment' && /^[\t ]*(?:\n|$)/.test(next.text))

const lineIndentOf = (code: string): string => code.slice(code.lastIndexOf('\n') + 1)

const advance = (base: Position['start'], text: string): Position['start'] => {
  const newlines = text.split('\n').length - 1
  const lastNewline = text.lastIndexOf('\n')
  return {
    line: base.line + newlines,
    column:
      base.column === undefined
        ? undefined
        : newlines === 0
          ? base.column + text.length
          : text.length - lastNewline,
    offset: base.offset + text.length,
  }
}

const trimLeadingBlank = (fragment: Fragment): Fragment => {
  const blank = /^[\t ]+/.exec(fragment.text)
  return blank === null
    ? fragment
    : {
        ...fragment,
        text: fragment.text.slice(blank[0].length),
        origin: {
          ...fragment.origin,
          start: advance(fragment.origin.start, blank[0]),
        },
      }
}

const lineStartsOf = (lines: ReadonlyArray<string>): ReadonlyArray<number> =>
  Array.mapAccum(lines, 0, (start, line) => [start + line.length + 1, start])[1]

const newStartsOf = (
  lines: ReadonlyArray<string>,
  oldStarts: ReadonlyArray<number>,
  width: number,
): ReadonlyArray<number> =>
  Array.mapAccum(Array.zip(lines, oldStarts), 0, (indented, [line, start]) => {
    const next = start !== 0 && line !== '' ? indented + 1 : indented
    return [next, start + width * next]
  })[1]

const lineIndexOf = (starts: ReadonlyArray<number>, offset: number): number =>
  pipe(
    Array.findLastIndex(starts, (s) => s <= offset),
    Option.getOrElse(() => 0),
  )

const reindentMapping = (
  m: Mapping,
  block: string,
  oldStarts: ReadonlyArray<number>,
  newStarts: ReadonlyArray<number>,
): ReadonlyArray<Mapping> => {
  const end = m.genStart + m.genLength
  const cuts = [m.genStart, ...oldStarts.filter((s) => s > m.genStart && s < end), end]
  return Array.zip(cuts, Array.drop(cuts, 1)).map(([a, b]) => {
    const line = lineIndexOf(oldStarts, a)
    return {
      genStart: newStarts[line] + (a - oldStarts[line]),
      genLength: b - a,
      source: {
        start: advance(m.source.start, block.slice(m.genStart, a)),
        end: advance(m.source.start, block.slice(m.genStart, b)),
      },
      kind: m.kind,
    }
  })
}

const indentBlock = (vc: LoomVirtualCode, indent: string): LoomVirtualCode => {
  if (indent.length === 0) return vc
  const lines = vc.code.split('\n')
  if (lines.length <= 1) return vc
  const oldStarts = lineStartsOf(lines)
  const newStarts = newStartsOf(lines, oldStarts, indent.length)
  return {
    ...vc,
    code: lines.map((line, i) => (i === 0 || line === '' ? line : indent + line)).join('\n'),
    mappings: vc.mappings.flatMap((m) => reindentMapping(m, vc.code, oldStarts, newStarts)),
  }
}

const spanOf = (position: Position, kind: MappingKind): Mapping => ({
  genStart: position.start.offset,
  genLength: position.end.offset - position.start.offset,
  source: position,
  kind,
})

export const symbolMappings = (doc: LoomDocument): ReadonlyArray<Mapping> =>
  symbolsOf(doc).map((symbol) => spanOf(symbol.position, symbol.kind))

export const fromCode = (
  modules: ReadonlyMap<Location, LoomModule>,
  node: Code,
  catalogue: Catalogue = catalogueOf(modules),
  specifiers: Specifiers = noSpecifiers,
): LoomVirtualCode => ({
  ...inlineComposed(
    modules,
    catalogue,
    new Set([keyOf(node.origin)]),
    node.origin.path,
    specifiers,
  )(node),
  id: node.origin.name.toLowerCase(),
  languageId: node.languageId,
})

export const fromProduct = (
  modules: ReadonlyMap<Location, LoomModule>,
  root: SectionId,
  catalogue: Catalogue = catalogueOf(modules),
  specifiers: Specifiers = noSpecifiers,
): LoomVirtualCode =>
  pipe(
    lookup(modules, root),
    Option.match({
      onNone: () => leaf(root.name.toLowerCase(), '', '', []),
      onSome: (node) => fromCode(modules, node, catalogue, specifiers),
    }),
  )

const isCodeWeft = (weft: { readonly type: string }): boolean =>
  weft.type === 'ArrowWeft' || weft.type === 'CodeWeft'

const proseMappings = (doc: LoomDocument): ReadonlyArray<Mapping> =>
  [
    ...doc.preamble,
    ...doc.sections.flatMap((section) => [
      section.heading,
      ...section.preamble,
      ...section.code.filter((weft) => !isCodeWeft(weft)),
    ]),
  ].map((token) => spanOf(token.position, 'prose'))

const blank = (text: string): string => text.replace(/[^\n]/g, ' ')

const proseOf = (module: LoomModule): string => {
  const spans = module.doc.sections
    .flatMap((section) => section.code)
    .filter(isCodeWeft)
    .map((weft) => [weft.position.start.offset, weft.position.end.offset] as const)
  const ends: Array.NonEmptyReadonlyArray<number> = [0, ...spans.map(([, end]) => end)]
  return [
    ...spans.map(
      ([start, end], at) =>
        module.text.slice(ends[at], start) + blank(module.text.slice(start, end)),
    ),
    module.text.slice(Array.lastNonEmpty(ends)),
  ].join('')
}

export const fromProse = (modules: ReadonlyMap<Location, LoomModule>, path: Location): LoomVirtualCode =>
  Option.match(Option.fromNullishOr(modules.get(path)), {
    onNone: () => leaf('prose', 'prose', '', []),
    onSome: (module) => ({
      id: 'prose',
      languageId: 'prose',
      code: proseOf(module),
      mappings: proseMappings(module.doc),
      embeddedCodes: [],
    }),
  })

export const rootVirtualCode = (
  text: string,
  embeddedCodes: ReadonlyArray<LoomVirtualCode>,
  symbols: ReadonlyArray<Mapping> = [],
): LoomVirtualCode => ({
  id: 'root',
  languageId: 'loom',
  code: text,
  mappings: [
    {
      genStart: 0,
      genLength: text.length,
      source: {
        start: { line: 1, offset: 0 },
        end: { line: 1, offset: text.length },
      },
      kind: 'source',
    },
    ...symbols,
  ],
  embeddedCodes,
})

export const rootNamesAt = (
  modules: ReadonlyMap<Location, LoomModule>,
  path: Location,
): ReadonlySet<string> => {
  const here = modules.get(path)?.product?.code ?? []
  const named = new Set(
    Array.getSomes(
      here
        .flatMap((code) => code.fragments)
        .map((part) =>
          part.type === 'NameRef'
            ? part.target.pipe(
                Option.filter((t) => t.path === path),
                Option.map((t) => t.name.toLowerCase()),
              )
            : Option.none(),
        ),
    ),
  )
  return new Set(here.map((code) => code.origin.name.toLowerCase()).filter((id) => !named.has(id)))
}

export class LoomVirtualCodeBuilder extends Context.Service<LoomVirtualCodeBuilder>()(
  'LoomVirtualCodeBuilder',
  {
    make: Effect.succeed({
      fromProduct: (
        modules: ReadonlyMap<Location, LoomModule>,
        root: SectionId,
      ): Effect.Effect<LoomVirtualCode> => Effect.sync(() => fromProduct(modules, root)),
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make)
}
