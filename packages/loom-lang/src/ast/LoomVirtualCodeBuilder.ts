import { Array, Effect, Match, Option, Schema, SchemaAST, pipe } from 'effect'
import * as FrameAst from '@athrio/loom-ast/FrameAst'
import {
  keyOf,
  type Code,
  type Fragment,
  type Ref,
  type SectionId,
} from '@athrio/loom-ast/ProductAst'
import { type Position } from '@athrio/loom-ast/LoomNode'
import { type LoomModule, type Path } from '@athrio/loom-ast/LoomCorpusAst'
import {
  type LoomVirtualCode,
  type Mapping,
  type MappingKind,
} from '@athrio/loom-ast/LoomVirtualCode'

const lookup = (
  modules: ReadonlyMap<Path, LoomModule>,
  id: SectionId,
): Option.Option<Code> =>
  pipe(
    Option.fromNullable(modules.get(id.path)),
    Option.flatMapNullable((m) => m.product),
    Option.flatMap((product) =>
      Array.findFirst(product.code, (c) => c.origin.name === id.name),
    ),
  )

const typeTagOf = (schema: Schema.Schema.Any): Option.Option<string> =>
  pipe(
    schema.ast,
    Option.liftPredicate(SchemaAST.isTypeLiteral),
    Option.flatMap((ast) =>
      Array.findFirst(ast.propertySignatures, (p) => p.name === 'type'),
    ),
    Option.map((p) => p.type),
    Option.filter(SchemaAST.isLiteral),
    Option.map((lit) => String(lit.literal)),
  )

const orderByType: ReadonlyMap<string, ReadonlyArray<string>> = new Map(
  pipe(
    Object.values(FrameAst),
    Array.filterMap((v) =>
      Schema.isSchema(v)
        ? Option.all([typeTagOf(v), FrameAst.renderOrderOf(v)])
        : Option.none(),
    ),
  ),
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

const emitText = (parent: any, text: string): LoomVirtualCode =>
  leaf(
    '',
    '',
    text,
    pipe(
      Option.fromNullable(parent.position as Position | undefined),
      Option.match({
        onNone: (): ReadonlyArray<Mapping> => [],
        onSome: (source) => [
          {
            genStart: 0,
            genLength: text.length,
            source,
            kind: parent.kind as MappingKind | undefined,
          },
        ],
      }),
    ),
  )

const emitField = (parent: any, field: unknown): LoomVirtualCode =>
  Match.value(field).pipe(
    Match.when(Match.string, (text) => emitText(parent, text)),
    Match.when(Array.isArray, (nodes) =>
      pipe(nodes, Array.map(emitNode), Array.reduce(emptyLeaf, concat)),
    ),
    Match.orElse((node) =>
      Option.match(Option.fromNullable(node), {
        onNone: () => emptyLeaf,
        onSome: emitNode,
      }),
    ),
  )

const emitNode = (node: any): LoomVirtualCode =>
  pipe(
    Option.fromNullable(orderByType.get(node.type)),
    Option.getOrElse((): ReadonlyArray<string> => []),
    Array.map((name) => emitField(node, node[name])),
    Array.reduce(emptyLeaf, concat),
  )

const clipMappings = (
  mappings: ReadonlyArray<Mapping>,
  genLen: number,
): ReadonlyArray<Mapping> =>
  Array.filterMap(mappings, (m) =>
    m.genStart >= genLen
      ? Option.none()
      : Option.some(
          m.genStart + m.genLength <= genLen
            ? m
            : { ...m, genLength: genLen - m.genStart },
        ),
  )

const absorbTrailingNewline = (vc: LoomVirtualCode): LoomVirtualCode => {
  const code = vc.code.replace(/\n+$/, '')
  return code.length === vc.code.length
    ? vc
    : { ...vc, code, mappings: clipMappings(vc.mappings, code.length) }
}

const inlinePart =
  (modules: ReadonlyMap<Path, LoomModule>, seen: ReadonlySet<string>) =>
  (part: Fragment | Ref): LoomVirtualCode => {
    if (part.type === 'Fragment') {
      return leaf('', '', part.text, [
        {
          genStart: 0,
          genLength: part.text.length,
          source: part.origin,
          kind: 'product',
        },
      ])
    }
    return pipe(
      part.target,
      Option.filter((t) => !seen.has(keyOf(t))),
      Option.flatMap((t) =>
        Option.map(lookup(modules, t), (node) => [t, node] as const),
      ),
      Option.match({
        onNone: () => emptyLeaf,
        onSome: ([t, node]) =>
          absorbTrailingNewline(
            inlineComposed(modules, new Set([...seen, keyOf(t)]))(node),
          ),
      }),
    )
  }

const inlineComposed =
  (modules: ReadonlyMap<Path, LoomModule>, seen: ReadonlySet<string>) =>
  (node: Code): LoomVirtualCode => {
    const build = inlinePart(modules, seen)
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
            owns
              ? indentBlock(build(part), lineIndentOf(acc.vc.code))
              : build(part),
          ),
          trim: owns,
        }
      }),
      (acc) => acc.vc,
    )
  }

const aloneBefore = (code: string): boolean =>
  /^[\t ]*$/.test(code.slice(code.lastIndexOf('\n') + 1))

const aloneAfter = (next: Fragment | Ref | undefined): boolean =>
  next === undefined ||
  (next.type === 'Fragment' && /^[\t ]*(?:\n|$)/.test(next.text))

const lineIndentOf = (code: string): string =>
  code.slice(code.lastIndexOf('\n') + 1)

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
  Array.mapAccum(lines, 0, (start, line) => [
    start + line.length + 1,
    start,
  ])[1]

const newStartsOf = (
  lines: ReadonlyArray<string>,
  oldStarts: ReadonlyArray<number>,
  width: number,
): ReadonlyArray<number> =>
  Array.mapAccum(Array.zip(lines, oldStarts), 0, (indented, [line, start]) => {
    const next = start !== 0 && line !== '' ? indented + 1 : indented
    return [next, start + width * next]
  })[1]

const lineIndexOf = (
  starts: ReadonlyArray<number>,
  offset: number,
): number =>
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
  const cuts = [
    m.genStart,
    ...Array.filter(oldStarts, (s) => s > m.genStart && s < end),
    end,
  ]
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

const indentBlock = (
  vc: LoomVirtualCode,
  indent: string,
): LoomVirtualCode => {
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
    mappings: Array.flatMap(vc.mappings, (m) =>
      reindentMapping(m, vc.code, oldStarts, newStarts),
    ),
  }
}

export const fromFrame = (frame: FrameAst.FrameModule): LoomVirtualCode => ({
  ...emitNode(frame),
  id: 'frame',
  languageId: 'loom',
})

export const fromProduct = (
  modules: ReadonlyMap<Path, LoomModule>,
  root: SectionId,
): LoomVirtualCode =>
  pipe(
    lookup(modules, root),
    Option.match({
      onNone: () => leaf(root.name.toLowerCase(), '', '', []),
      onSome: (node) => ({
        ...inlineComposed(modules, new Set([keyOf(root)]))(node),
        id: root.name.toLowerCase(),
        languageId: node.languageId,
      }),
    }),
  )

export const rootVirtualCode = (
  text: string,
  embeddedCodes: ReadonlyArray<LoomVirtualCode>,
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
  ],
  embeddedCodes,
})

export const rootNamesAt = (
  modules: ReadonlyMap<Path, LoomModule>,
  path: Path,
): ReadonlySet<string> => {
  const here = modules.get(path)?.product?.code ?? []
  const named = new Set(
    pipe(
      here,
      Array.flatMap((code) => code.fragments),
      Array.filterMap((part) =>
        part.type === 'Fragment'
          ? Option.none()
          : part.target.pipe(
              Option.filter((t) => t.path === path),
              Option.map((t) => t.name.toLowerCase()),
            ),
      ),
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

export class LoomVirtualCodeBuilder extends Effect.Service<LoomVirtualCodeBuilder>()(
  'LoomVirtualCodeBuilder',
  {
    succeed: {
      fromFrame: (frame: FrameAst.FrameModule): Effect.Effect<LoomVirtualCode> =>
        Effect.sync(() => fromFrame(frame)),
      fromProduct: (
        modules: ReadonlyMap<Path, LoomModule>,
        root: SectionId,
      ): Effect.Effect<LoomVirtualCode> =>
        Effect.sync(() => fromProduct(modules, root)),
    },
  },
) {}
