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

// =============================================================================
// LoomVirtualCodeBuilder — the pass that produces `LoomVirtualCode`, in two
// flavours because the two planes are walked differently but yield the same model:
//
//   fromFrame    : Frame AST   → the `frame` virtual code   (de dicto, TypeScript)
//   fromProduct  : a section   → its product virtual code   (de re, per language)
//
// `fromFrame` walks the Frame AST in each node's declared `RenderOrder`, emitting
// authored leaves mapped back to the `.loom`. `fromProduct` walks a section's
// `ComposedCode`, inlining transclusions by following `Ref`s across the corpus.
// Both fold their pieces with the same monoid (`concat`), so a multi-part document
// is one growing `LoomVirtualCode` — no separate "rendered text" structure: the
// pass's input and output are both models. `rootVirtualCode` assembles a file's
// tree from the two.
//
// Pure and total. The `LoomVirtualCodeBuilder` service (below) is the DI face for
// callers already inside Effect (the corpus compiler); the single-file editor path
// uses the functions directly, exactly as `buildCode` / `ProductAstBuilder` pair up.
// =============================================================================

// CodeByPath — the corpus's per-module `code` maps indexed by path: the view
// `fromProduct` walks to resolve a `Ref`'s `{ path, name }` target across files.
export type CodeByPath = ReadonlyMap<Path, ReadonlyMap<string, ComposedCode>>

// =============================================================================
// RenderOrder table — tag → the ordered renderable fields, derived once from the
// FrameAst exports that are Schemas carrying both a `type` literal and a
// `RenderOrder` annotation. `fromFrame` reads it to walk each node.
// =============================================================================

// typeTagOf — the `type` literal of a frameNode schema (e.g. 'ServiceClass'), read
// from its AST: a TypeLiteral whose `type` property is a Literal.
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

// =============================================================================
// The fold monoid — a childless `LoomVirtualCode` is the unit a walk produces and
// folds. `concat` appends `b` after `a`, shifting b's mapping offsets past a's
// code; `a`'s identity (`id` / `languageId`) wins, since the seed carries it and
// the public pass sets it on the result.
// =============================================================================

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

// =============================================================================
// De dicto walk — Frame AST node → its frame text + mappings. Each node emits its
// renderable fields in `RenderOrder`, then folds them. A `string` field is a leaf,
// mapped to its `.loom` span iff the node is authored (carries a `position`); synth
// glue carries none. The walk reads fields off schema-introspected nodes, so the
// node is untyped and `position` / `kind` are read by assertion.
// =============================================================================

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

// =============================================================================
// De re walk — a section's `ComposedCode` → its product text + mappings. A
// `Fragment` emits a 1:1 `product` mapping to its own `.loom` origin; a `Ref` is
// followed across the corpus and inlined. Crossing a `Ref` into another *file*
// pins the whole inlined subtree onto the consuming `{{…}}` anchor (so no mapping
// dangles into the dependency); a `Ref` that is unresolved, missing from the
// corpus, or already on the stack (a cycle) contributes nothing. An inlined block
// sheds its trailing newline (Transclusion's newline rule, below), so the sink's
// layout is the output's.
// =============================================================================

// lookup — a section's ComposedCode across the corpus (a two-level Option get).
const lookup = (
  codeByPath: CodeByPath,
  id: SectionId,
): Option.Option<ComposedCode> =>
  pipe(
    Option.fromNullable(codeByPath.get(id.path)),
    Option.flatMap((code) => Option.fromNullable(code.get(id.name))),
  )

// =============================================================================
// Transclusion's newline rule. An anchor `{{a}}` is replaced by block a's *lines*;
// the line break that ends the anchor's own line in the sink is the terminator of
// the block's last line — not an extra blank. So a transcluded block sheds its own
// trailing newline, and the sink's literal layout becomes the output's layout:
//
//     {{a}}            block a, then block b on the next line     (0 blank lines)
//     {{b}}
//
//     {{a}}            block a, one blank line, then block b       (1 blank line)
//
//     {{b}}
//
// and the last anchor's line break is the file's single final newline — no doubled
// gaps, no trailing blank. (This is noweb's chunk-reference semantics: a reference
// stands for the chunk's lines, and the reference's own line supplies the break.)
//
// Generated-side only: the shed newline's `.loom` origin simply stops being mapped
// (a newline is never a hover/diagnostic target), and `toCodeMapping` carries
// `generatedLengths` apart from source `lengths`, so trimming the generated span
// leaves every other mapping — and every source span — untouched.
// =============================================================================

// clipMappings — keep the mappings that still fit within `genLen` generated chars,
// shrinking the one (if any) that straddles the new end. Mappings are appended in
// generated order, so this only ever trims the tail.
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

// absorbTrailingNewline — a block sheds its trailing newline(s) as it is inlined;
// the consuming anchor's own line break terminates its last line.
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
              // the first cross-file boundary pins the cone onto this anchor
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

// =============================================================================
// The passes — Frame AST / section → `LoomVirtualCode`, and the tree assembly.
// =============================================================================

// fromFrame — de dicto pass: a module's Frame AST → the `frame` virtual code, the
// generated composition program. Always TypeScript; Volar type-checks it.
export const fromFrame = (frame: FrameAst.FrameModule): LoomVirtualCode => ({
  ...emitNode(frame),
  id: 'frame',
  languageId: 'typescript',
})

// fromProduct — de re pass: a section (`root`) → its product virtual code, the
// author's code with transclusions inlined across the corpus. The `id` is the
// section's name (unique within its module); the language is its own. A `root`
// absent from the corpus yields an empty document.
export const fromProduct = (
  codeByPath: CodeByPath,
  root: SectionId,
): LoomVirtualCode =>
  pipe(
    lookup(codeByPath, root),
    Option.match({
      onNone: () => leaf(root.name, '', '', []),
      onSome: (node) => ({
        ...inlineComposed(
          codeByPath,
          root.path,
          Option.none(),
          new Set([keyOf(root)]),
        )(node),
        id: root.name,
        languageId: node.languageId,
      }),
    }),
  )

// rootVirtualCode — assemble a file's tree: the `.loom` source as the `loom` root
// (Volar maps it 1:1 itself, so no mappings), with the frame + product documents
// as its embedded children.
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

// =============================================================================
// LoomVirtualCodeBuilder — the two passes as an Effect.Service, uniform with
// FrameAstBuilder / ProductAstBuilder. Wraps the pure functions for DI callers.
// =============================================================================

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
