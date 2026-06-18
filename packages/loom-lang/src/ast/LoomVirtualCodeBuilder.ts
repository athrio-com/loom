import { Array, Effect, Match, Option, Schema, SchemaAST, pipe } from 'effect'
import * as FrameAst from '#ast/FrameAst'
import {
  keyOf,
  type ComposedCode,
  type Fragment,
  type Ref,
  type SectionId,
} from '#ast/ProductAst'
import { type Position } from '#ast/LoomNode'
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
    rootPath: Path,
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
              rootPath,
              Option.orElse(pin, () =>
                t.path === rootPath
                  ? Option.none<Position>()
                  : Option.some(part.anchor),
              ),
              new Set([...seen, keyOf(t)]),
            )(node),
          ),
      }),
    )
  }

const inlineComposed =
  (
    codeByPath: CodeByPath,
    rootPath: Path,
    pin: Option.Option<Position>,
    seen: ReadonlySet<string>,
  ) =>
  (node: ComposedCode): LoomVirtualCode =>
    pipe(
      node.parts,
      Array.map(inlinePart(codeByPath, rootPath, pin, seen)),
      Array.reduce(emptyLeaf, concat),
    )

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
          root.path,
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
  mappings: [],
  embeddedCodes,
})

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
