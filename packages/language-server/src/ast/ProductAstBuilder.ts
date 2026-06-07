import { Array, Effect, Option, pipe } from 'effect'
import { okHealth, type Position } from '#ast/LoomNode'
import type {
  CodeRef,
  Compose,
  EmbeddedCode,
  FrameModule,
  ServiceBody,
  ServiceClass,
} from '#ast/FrameAst'
import {
  type ComposedCode,
  type Fragment,
  type Ref,
  type SectionId,
} from '#ast/ProductAst'

// =============================================================================
// ProductAstBuilder — the de re pass of the spine, per module: a module's Frame
// AST → its `code` map (`name → ComposedCode`). Every content section / tangle
// sink becomes a `ComposedCode`; each `compose` argument becomes a `Fragment`
// (its product text, sliced from the module's source) or a `Ref` (resolved to a
// key — a local section, or cross-file via the module's import bindings).
//
// Per-module and pure: it never reads another module, so a module's `code` is
// atomic with its `frame` (built together, cannot drift). Cross-file resolution
// is deferred to `fromProduct` (LoomVirtualCodeBuilder), which follows the `Ref`
// keys across the corpus. Uniform with `FrameAstBuilder` (doc → frame).
// =============================================================================

// ModuleInput — the per-module slice the builder needs: `path` (identity for the
// `SectionId`s it stamps), `text` (to slice Fragment bodies), the Frame AST, and
// the `{Loom}` imports as bound name → resolved `.loom` path (which file each
// cross-file tag lives in).
export interface ModuleInput {
  readonly path: string
  readonly text: string
  readonly frame: FrameModule
  readonly imports: ReadonlyMap<string, string>
}

// Node constructors — `type` and ok `health` are the only defaults.
const fragment = (text: string, origin: Position): Fragment => ({
  type: 'Fragment',
  health: okHealth,
  text,
  origin,
})
const ref = (target: Option.Option<SectionId>, anchor: Position): Ref => ({
  type: 'Ref',
  health: okHealth,
  target,
  anchor,
})
const composedCode = (
  origin: SectionId,
  languageId: string,
  parts: ReadonlyArray<Fragment | Ref>,
): ComposedCode => ({
  type: 'ComposedCode',
  health: okHealth,
  origin,
  languageId,
  parts,
})

// The module's content sections and tangle sinks (a `{Loom}` FrameCode is de
// dicto — skipped). `ServiceName` is a union; both arms carry `.text`.
const servicesOf = (frame: FrameModule): ReadonlyArray<ServiceClass> =>
  pipe(
    frame.members,
    Array.map((m) => m.value),
    Array.filter((v): v is ServiceClass => v.type === 'ServiceClass'),
  )

// A body's bindings as local-name → tag (the class name a `yield*` names). Static
// bodies have none.
const tagsOf = (body: ServiceBody): ReadonlyMap<string, string> =>
  body.type === 'StaticBody'
    ? new Map()
    : new Map(
        Array.map(
          body.bindings,
          (it) => [it.value.name.text, it.value.tag.text] as const,
        ),
      )

// A `compose`'s arguments in composition order — the optional head, then the tail.
const argsOf = (compose: Compose): ReadonlyArray<EmbeddedCode | CodeRef> =>
  pipe(
    Option.fromNullable(compose.head),
    Option.match({
      onNone: () => Array.map(compose.tail, (it) => it.value),
      onSome: (head) => [head, ...Array.map(compose.tail, (it) => it.value)],
    }),
  )

// targetOf — a `CodeRef`'s local binding → the section it names, as
// `Option<SectionId>`. The binding resolves to a tag (a class name): defined in
// this module → a local target; in the module's imports → a cross-file target;
// neither (or the binding names no Warp) → `None`, an unresolved anchor that
// `fromProduct` emits nothing for.
const targetOf = (
  mod: ModuleInput,
  localNames: ReadonlySet<string>,
  tags: ReadonlyMap<string, string>,
  refNode: CodeRef,
): Option.Option<SectionId> =>
  pipe(
    Option.fromNullable(tags.get(refNode.binding.text)),
    Option.flatMap((tag) =>
      localNames.has(tag)
        ? Option.some<SectionId>({ path: mod.path, name: tag })
        : Option.map(
            Option.fromNullable(mod.imports.get(tag)),
            (path): SectionId => ({ path, name: tag }),
          ),
    ),
  )

// composedCodeOf — one ServiceClass → its ComposedCode node.
const composedCodeOf =
  (mod: ModuleInput, localNames: ReadonlySet<string>) =>
  (svc: ServiceClass): ComposedCode => {
    const tags = tagsOf(svc.body)
    const parts = Array.map(
      argsOf(svc.body.code),
      (arg): Fragment | Ref =>
        arg.type === 'EmbeddedCode'
          ? fragment(
              mod.text.slice(arg.position.start.offset, arg.position.end.offset),
              arg.position,
            )
          : ref(targetOf(mod, localNames, tags, arg), arg.binding.position),
    )
    return composedCode({ path: mod.path, name: svc.name.text }, svc.languageId, parts)
  }

// buildCode — one module's Frame AST → its `code` map (name → ComposedCode). The
// pure spine transform; `ProductAstBuilder` (below) is its Effect.Service wrapper.
export const buildCode = (
  mod: ModuleInput,
): ReadonlyMap<string, ComposedCode> => {
  const services = servicesOf(mod.frame)
  const localNames = new Set(Array.map(services, (s) => s.name.text))
  return new Map(
    Array.map(services, (svc) => {
      const node = composedCodeOf(mod, localNames)(svc)
      return [node.origin.name, node] as const
    }),
  )
}

// =============================================================================
// ProductAstBuilder — the de re structure pass as an Effect.Service, uniform with
// LoomAstBuilder / FrameAstBuilder. Wraps the pure `buildCode`.
// =============================================================================

export class ProductAstBuilder extends Effect.Service<ProductAstBuilder>()(
  'ProductAstBuilder',
  {
    succeed: {
      build: (
        mod: ModuleInput,
      ): Effect.Effect<ReadonlyMap<string, ComposedCode>> =>
        Effect.sync(() => buildCode(mod)),
    },
  },
) {}
