import { Array, Effect, Match, Option, Schema, SchemaAST, pipe } from 'effect'
import * as FrameAst from '#ast/FrameAst'
import {
  keyOf,
  type ComposedCode,
  type Fragment,
  type Ref,
  type SectionId,
} from '@athrio/loom-core/ProductAst'
import { type Position } from '@athrio/loom-core/LoomNode'
import { type Path } from '#ast/LoomCorpusAst'
import {
  type LoomVirtualCode,
  type Mapping,
  type MappingKind,
} from '#ast/LoomVirtualCode'

export type CodeByPath = ReadonlyMap<Path, ReadonlyMap<string, ComposedCode>>

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

const lookup = (
  codeByPath: CodeByPath,
  id: SectionId,
): Option.Option<ComposedCode> =>
  pipe(
    Option.fromNullable(codeByPath.get(id.path)),
    Option.flatMap((code) => Option.fromNullable(code.get(id.name))),
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
  (
    codeByPath: CodeByPath,
    pin: Option.Option<Position>,
    seen: ReadonlySet<string>,
  ) =>
  (part: Fragment | Ref): LoomVirtualCode => {
    if (part.type === 'Fragment') {
      return leaf('', '', part.text, [
        {
          genStart: 0,
          genLength: part.text.length,
          source: Option.getOrElse(pin, () => part.origin),
          kind: 'product',
        },
      ])
    }
    const childPin =
      part.type === 'TagRef'
        ? Option.orElse(pin, () => Option.some(part.anchor))
        : pin
    return pipe(
      part.target,
      Option.filter((t) => !seen.has(keyOf(t))),
      Option.flatMap((t) =>
        Option.map(lookup(codeByPath, t), (node) => [t, node] as const),
      ),
      Option.match({
        onNone: () => emptyLeaf,
        onSome: ([t, node]) =>
          absorbTrailingNewline(
            inlineComposed(
              codeByPath,
              childPin,
              new Set([...seen, keyOf(t)]),
            )(node),
          ),
      }),
    )
  }

const inlineComposed =
  (
    codeByPath: CodeByPath,
    pin: Option.Option<Position>,
    seen: ReadonlySet<string>,
  ) =>
  (node: ComposedCode): LoomVirtualCode => {
    const build = inlinePart(codeByPath, pin, seen)
    const seed: { vc: LoomVirtualCode; trim: boolean } = {
      vc: emptyLeaf,
      trim: false,
    }
    return pipe(
      node.parts,
      Array.reduce(seed, (acc, part, i) => {
        if (part.type === 'Fragment') {
          return {
            vc: concat(acc.vc, build(acc.trim ? trimLeadingBlank(part) : part)),
            trim: false,
          }
        }
        const owns = aloneBefore(acc.vc.code) && aloneAfter(node.parts[i + 1])
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
  const aligned = m.source.end.offset - m.source.start.offset >= m.genLength
  return Array.map(Array.zip(cuts, Array.drop(cuts, 1)), ([a, b]) => {
    const line = lineIndexOf(oldStarts, a)
    return {
      genStart: newStarts[line] + (a - oldStarts[line]),
      genLength: b - a,
      source: aligned
        ? {
            start: advance(m.source.start, block.slice(m.genStart, a)),
            end: advance(m.source.start, block.slice(m.genStart, b)),
          }
        : m.source,
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
  codeByPath: CodeByPath,
  root: SectionId,
): LoomVirtualCode =>
  pipe(
    lookup(codeByPath, root),
    Option.match({
      onNone: () => leaf(root.name.toLowerCase(), '', '', []),
      onSome: (node) => ({
        ...inlineComposed(
          codeByPath,
          Option.none(),
          new Set([keyOf(root)]),
        )(node),
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
  codeByPath: CodeByPath,
  path: Path,
): ReadonlySet<string> => {
  const here = codeByPath.get(path) ?? new Map<string, ComposedCode>()
  const named = new Set(
    pipe(
      Array.fromIterable(here.values()),
      Array.flatMap((code) => code.parts),
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
      Array.fromIterable(here.keys()),
      Array.map((name) => name.toLowerCase()),
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
        codeByPath: CodeByPath,
        root: SectionId,
      ): Effect.Effect<LoomVirtualCode> =>
        Effect.sync(() => fromProduct(codeByPath, root)),
    },
  },
) {}
