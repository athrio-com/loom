import type { LanguagePlugin } from '@volar/language-core'
import { Runtime } from 'effect'
import type { URI } from 'vscode-uri'
import type { Loom } from '#ast/Loom'
import type { Resolver } from '#projectors/Resolver'
import type { Synthesiser } from '#projectors/Synthesiser'
import type { Transducer } from '#projectors/Transducer'
import { loomVirtualCode } from './VirtualCode'

// =============================================================================
// loomLanguagePlugin — Volar's three hooks:
//
//   Uri                             → string | undefined   (languageId)
//   (Uri, languageId, Snapshot)     → VirtualCode | undefined
//   (Uri, oldVirtualCode, Snapshot) → VirtualCode
//
// `VirtualCode.ts` projects a `.loom` snapshot to its virtual-code tree as an
// Effect. Volar's hooks are synchronous, so the plugin is built from the entry
// point's *warm* runtime (the layers built once at startup) and runs the
// projection against it via `Runtime.runSync` — the single Volar↔Effect seam.
// The runtime must be warm: Effect builds layers asynchronously, so a cold
// runtime would throw on `runSync`; the per-call projection is synchronous.
// `oldVirtualCode` is ignored: rebuild from the snapshot.
// =============================================================================

export const loomLanguagePlugin = (
  runtime: Runtime.Runtime<Loom | Transducer | Synthesiser | Resolver>,
): LanguagePlugin<URI> => ({
  getLanguageId(uri) {
    if (uri.path.endsWith('.loom')) return 'loom'
  },
  createVirtualCode(_uri, languageId, snapshot) {
    if (languageId === 'loom') {
      return Runtime.runSync(runtime)(loomVirtualCode(snapshot))
    }
  },
  updateVirtualCode(_uri, _old, snapshot) {
    return Runtime.runSync(runtime)(loomVirtualCode(snapshot))
  },
})
