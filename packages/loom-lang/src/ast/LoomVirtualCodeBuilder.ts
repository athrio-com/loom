import { Array, Context, Effect, Layer, Option, pipe } from 'effect'
import {
  isMeant,
  keyOf,
  type Code,
  type Fragment,
  type Provided,
  type Ref,
  type SectionId,
} from '@athrio/loom-ast/ProductAst'
import { type Position } from '@athrio/loom-ast/LoomNode'
import { bookOf, type Book, type LoomModule, type Location } from '@athrio/loom-ast/LoomCorpusAst'
import { targetOf } from '#ast/ProductBuilder'
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
    ...Array.map(b.mappings, (m) => ({
      ...m,
      genStart: m.genStart + a.code.length,
    })),
  ],
  embeddedCodes: a.embeddedCodes,
})

const clipMappings = (mappings: ReadonlyArray<Mapping>, genLen: number): ReadonlyArray<Mapping> =>
  Array.getSomes(
    Array.map(mappings, (m) =>
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

const inlinePart =
  (
    modules: ReadonlyMap<Location, LoomModule>,
    book: Book,
    seen: ReadonlySet<string>,
    home: Location,
    owner: Location,
  ) =>
  (part: Fragment | Ref): LoomVirtualCode => {
    if (part.type === 'Fragment') {
      const origin: Mapping = {
        genStart: 0,
        genLength: part.text.length,
        source: part.origin,
        kind: 'product',
      }
      return leaf('', '', part.text, owner === home ? [origin] : [])
    }
    return pipe(
      targetOf(book, owner, part),
      Option.filter((t) => !seen.has(keyOf(t))),
      Option.flatMap((t) => Option.map(lookup(modules, t), (node) => [t, node] as const)),
      Option.match({
        onNone: () => emptyLeaf,
        onSome: ([t, node]) =>
          absorbTrailingNewline(
            inlineComposed(modules, book, new Set([...seen, keyOf(t)]), home)(node),
          ),
      }),
    )
  }

const inlineComposed =
  (
    modules: ReadonlyMap<Location, LoomModule>,
    book: Book,
    seen: ReadonlySet<string>,
    home: Location,
  ) =>
  (node: Code): LoomVirtualCode => {
    const build = inlinePart(modules, book, seen, home, node.origin.path)
    const seed: { vc: LoomVirtualCode; trim: boolean } = {
      vc: emptyLeaf,
      trim: false,
    }
    return pipe(
      node.fragments,
      Array.reduce(seed, (acc, part, i) => {
        if (part.type === 'Fragment') {
          return {
            vc: concat(acc.vc, build(acc.trim ? trimLeadingBlank(part) : part)),
            trim: false,
          }
        }
        const owns = aloneBefore(acc.vc.code) && aloneAfter(node.fragments[i + 1])
        return {
          vc: concat(
            acc.vc,
            owns ? indentBlock(build(part), lineIndentOf(acc.vc.code)) : build(part),
          ),
          trim: owns,
        }
      }),
      (acc) => acc.vc,
    )
  }

export type Unsettled = {
  readonly path: Location
  readonly anchor: Position
  readonly name: string
  readonly section: Option.Option<SectionId>
  readonly provides: ReadonlyArray<Provided>
}

const unsettledAt = (owner: Location, ref: Ref, section: Option.Option<SectionId>): Unsettled => ({
  path: owner,
  anchor: ref.anchor,
  name: ref.name,
  section,
  provides: ref.provides,
})

export const unsettledRef = (
  modules: ReadonlyMap<Location, LoomModule>,
  book: Book,
  owner: Location,
  ref: Ref,
): Option.Option<Unsettled> =>
  Option.match(targetOf(book, owner, ref), {
    onNone: () =>
      isMeant(ref) ? Option.some(unsettledAt(owner, ref, Option.none())) : Option.none(),
    onSome: (target) =>
      pipe(
        lookup(modules, target),
        Option.filter((code) => !Array.isReadonlyArrayNonEmpty(code.fragments)),
        Option.map(() => unsettledAt(owner, ref, Option.some(target))),
      ),
  })

const unsettledFrom =
  (modules: ReadonlyMap<Location, LoomModule>, book: Book, seen: ReadonlySet<string>) =>
  (node: Code): ReadonlyArray<Unsettled> =>
    Array.flatMap(node.fragments, (part) =>
      part.type === 'Fragment'
        ? []
        : Option.match(unsettledRef(modules, book, node.origin.path, part), {
            onSome: (unsettled) => [unsettled],
            onNone: () =>
              pipe(
                targetOf(book, node.origin.path, part),
                Option.filter((reached) => !seen.has(keyOf(reached))),
                Option.flatMap((reached) =>
                  Option.map(lookup(modules, reached), (code) =>
                    unsettledFrom(modules, book, new Set([...seen, keyOf(reached)]))(code),
                  ),
                ),
                Option.getOrElse((): ReadonlyArray<Unsettled> => []),
              ),
          }),
    )

export const unsettledIn = (
  modules: ReadonlyMap<Location, LoomModule>,
  root: Code,
  book: Book = bookOf(modules),
): ReadonlyArray<Unsettled> => unsettledFrom(modules, book, new Set([keyOf(root.origin)]))(root)

export type Contract = {
  readonly section: string
  readonly target: Location
  readonly span: Position
  readonly language: string
  readonly provides: ReadonlyArray<Provided>
}

const writtenSpan = (code: Code): Option.Option<Position> =>
  pipe(
    code.fragments,
    Array.map((part) => (part.type === 'Fragment' ? Option.some(part.origin) : Option.none())),
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
  book: Book,
  path: Location,
  ref: Ref,
): Option.Option<Contract> =>
  Option.gen(function* () {
    const provides = yield* Option.liftPredicate(ref.provides, Array.isReadonlyArrayNonEmpty)
    const target = yield* targetOf(book, path, ref)
    const code = yield* lookup(modules, target)
    const span = yield* writtenSpan(code)
    return { section: ref.name, target: target.path, span, language: code.languageId, provides }
  })

export const contractsIn = (
  modules: ReadonlyMap<Location, LoomModule>,
  path: Location,
  book: Book = bookOf(modules),
): ReadonlyArray<Contract> =>
  Option.match(Option.fromNullishOr(modules.get(path)), {
    onNone: (): ReadonlyArray<Contract> => [],
    onSome: (module) =>
      pipe(
        module.product.code,
        Array.flatMap((code) => code.fragments),
        Array.map((part) =>
          part.type === 'Fragment' ? Option.none() : contractOf(modules, book, path, part),
        ),
        Array.getSomes,
      ),
  })

const aloneBefore = (code: string): boolean =>
  /^[\t ]*$/.test(code.slice(code.lastIndexOf('\n') + 1))

const aloneAfter = (next: Fragment | Ref | undefined): boolean =>
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
  const cuts = [m.genStart, ...Array.filter(oldStarts, (s) => s > m.genStart && s < end), end]
  return Array.map(Array.zip(cuts, Array.drop(cuts, 1)), ([a, b]) => {
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
    code: pipe(
      lines,
      Array.map((line, i) => (i === 0 || line === '' ? line : indent + line)),
      Array.join('\n'),
    ),
    mappings: Array.flatMap(vc.mappings, (m) => reindentMapping(m, vc.code, oldStarts, newStarts)),
  }
}

const spanOf = (position: Position, kind: MappingKind): Mapping => ({
  genStart: position.start.offset,
  genLength: position.end.offset - position.start.offset,
  source: position,
  kind,
})

export const symbolMappings = (doc: LoomDocument): ReadonlyArray<Mapping> =>
  Array.map(symbolsOf(doc), (symbol) => spanOf(symbol.position, symbol.kind))

export const fromCode = (
  modules: ReadonlyMap<Location, LoomModule>,
  node: Code,
  book: Book = bookOf(modules),
): LoomVirtualCode => ({
  ...inlineComposed(modules, book, new Set([keyOf(node.origin)]), node.origin.path)(node),
  id: node.origin.name.toLowerCase(),
  languageId: node.languageId,
})

export const fromProduct = (
  modules: ReadonlyMap<Location, LoomModule>,
  root: SectionId,
  book: Book = bookOf(modules),
): LoomVirtualCode =>
  pipe(
    lookup(modules, root),
    Option.match({
      onNone: () => leaf(root.name.toLowerCase(), '', '', []),
      onSome: (node) => fromCode(modules, node, book),
    }),
  )

const isCodeWeft = (weft: { readonly type: string }): boolean =>
  weft.type === 'ArrowWeft' || weft.type === 'CodeWeft'

const proseMappings = (doc: LoomDocument): ReadonlyArray<Mapping> =>
  pipe(
    [
      ...doc.preamble,
      ...Array.flatMap(doc.sections, (section) => [
        section.heading,
        ...section.preamble,
        ...Array.filter(section.code, (weft) => !isCodeWeft(weft)),
      ]),
    ],
    Array.map((token) => spanOf(token.position, 'prose')),
  )

export const fromProse = (modules: ReadonlyMap<Location, LoomModule>, path: Location): LoomVirtualCode =>
  Option.match(Option.fromNullishOr(modules.get(path)), {
    onNone: () => leaf('prose', 'prose', '', []),
    onSome: (module) => {
      const code = pipe(
        module.doc.sections,
        Array.flatMap((section) => section.code),
        Array.filter(isCodeWeft),
        Array.reduce(module.text, (acc, weft) => {
          const start = weft.position.start.offset
          const end = weft.position.end.offset
          return acc.slice(0, start) + acc.slice(start, end).replace(/[^\n]/g, ' ') + acc.slice(end)
        }),
      )
      return {
        id: 'prose',
        languageId: 'prose',
        code,
        mappings: proseMappings(module.doc),
        embeddedCodes: [],
      }
    },
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
    pipe(
      here,
      Array.flatMap((code) => code.fragments),
      Array.map((part) =>
        part.type === 'Fragment'
          ? Option.none()
          : part.target.pipe(
              Option.filter((t) => t.path === path),
              Option.map((t) => t.name.toLowerCase()),
            ),
      ),
      Array.getSomes,
    ),
  )
  return new Set(
    pipe(
      here,
      Array.map((code) => code.origin.name.toLowerCase()),
      Array.filter((id) => !named.has(id)),
    ),
  )
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
