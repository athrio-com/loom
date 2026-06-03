import type { CodeMapping, VirtualCode } from '@volar/language-core'
import { Effect } from 'effect'
import type * as ts from 'typescript'
import { Loom } from '#ast/Loom'
import { Resolver } from '#projectors/Resolver'
import { type Mapping, Synthesiser } from '#projectors/Synthesiser'
import { Transducer } from '#projectors/Transducer'

// =============================================================================
// VirtualCode — the dispatcher, and the only module that speaks Volar. It runs
// the projections over a `.loom` snapshot and assembles the Volar virtual-code
// tree:
//
//   root (loom)
//   ├── frame   (typescript)    ← Synthesiser: the de dicto gencode + mappings
//   └── <name>  (per language)  ← Resolver: a de re product document per Service
//
// This is an Effect over Loom / Transducer / Synthesiser, not a sync function:
// Effect builds layers *asynchronously*, so the runtime must be warmed before
// it can run synchronously. The entry point (an Effect program) provides the
// layers — warming them once — and hands the plugin that warm runtime; the
// plugin then `Runtime.runSync`s this projection per callback. The per-call work
// (parse → transduce → synthesise) is synchronous, so it resolves cleanly on a
// warm runtime; a cold one would throw on the async layer build.
//
// Volar coupling lives here alone — the projections stay Volar-agnostic; this
// module converts their `Mapping`s to `CodeMapping`s and shapes the tree.
// =============================================================================

// A minimal IScriptSnapshot over a string — Volar's unit of source text.
export const stringSnapshot = (text: string): ts.IScriptSnapshot => ({
  getText: (start, end) => text.slice(start, end),
  getLength: () => text.length,
  getChangeRange: () => undefined,
})

// kind → which language-service features Volar forwards at the mapped span.
// Prose (titles, preambles) is locate-only; identifiers and code get the full
// set. (Plane-aware suppression of the *frame's* product spans — so the de re
// documents are the sole answer for product code — is still pending.)
const featuresOf = (kind: Mapping['kind']): CodeMapping['data'] =>
  kind === 'prose'
    ? { navigation: true, structure: true }
    : {
        verification: true,
        completion: true,
        semantic: true,
        navigation: true,
        structure: true,
      }

// Our Mapping (a `.loom` source span ⟷ a generated span) → Volar's CodeMapping.
// Lengths differ wherever text was escaped into the frame, so both sides are
// carried; identifiers and verbatim frame code are 1:1.
const toCodeMapping = (m: Mapping): CodeMapping => ({
  sourceOffsets: [m.source.start.offset],
  generatedOffsets: [m.genStart],
  lengths: [m.source.end.offset - m.source.start.offset],
  generatedLengths: [m.genLength],
  data: featuresOf(m.kind),
})

// loomVirtualCode — snapshot → the virtual-code tree: the de dicto `frame` from
// the Synthesiser, then one de re product document per Service from the Resolver,
// all as children of the `loom` root.
export const loomVirtualCode = (
  snapshot: ts.IScriptSnapshot,
): Effect.Effect<
  VirtualCode,
  never,
  Loom | Transducer | Synthesiser | Resolver
> =>
  Effect.gen(function* () {
    const loom = yield* Loom
    const transducer = yield* Transducer
    const synthesiser = yield* Synthesiser
    const resolver = yield* Resolver

    const text = snapshot.getText(0, snapshot.getLength())
    const document = yield* loom.ast(text)
    const frame = yield* transducer.run(document)
    const { genCode, mappings } = yield* synthesiser.run(frame)
    const products = yield* resolver.run(frame, text)

    const frameCode: VirtualCode = {
      id: 'frame',
      languageId: 'typescript',
      snapshot: stringSnapshot(genCode),
      mappings: mappings.map(toCodeMapping),
      embeddedCodes: [],
    }

    // de re — one product virtual code per Service, in its own language.
    const productCodes = products.map(
      (p): VirtualCode => ({
        id: p.id,
        languageId: p.languageId,
        snapshot: stringSnapshot(p.code),
        mappings: p.mappings.map(toCodeMapping),
        embeddedCodes: [],
      }),
    )

    return {
      id: 'root',
      languageId: 'loom',
      snapshot,
      mappings: [],
      embeddedCodes: [frameCode, ...productCodes],
    }
  })
