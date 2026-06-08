import type { LanguagePlugin } from '@volar/language-core'
import type {} from '@volar/typescript'
import { Runtime } from 'effect'
import type * as ts from 'typescript'
import type { URI } from 'vscode-uri'
import type { Loom } from '#ast/Loom'
import type { FrameAstBuilder } from '#ast/FrameAstBuilder'
import { loomVirtualCode } from './LoomCompiler'

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
  runtime: Runtime.Runtime<Loom | FrameAstBuilder>,
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
  // TS integration: tell @volar/typescript that the `frame` embedded code is the
  // TypeScript service script, so Volar type-checks the generated frame and
  // maps its diagnostics back to the `.loom` through the frame's mappings.
  typescript: {
    extraFileExtensions: [
      { extension: 'loom', isMixedContent: true, scriptKind: 7 as ts.ScriptKind },
    ],
    getServiceScript(root) {
      const frame = root.embeddedCodes?.find((code) => code.id === 'frame')
      return frame
        ? { code: frame, extension: '.ts', scriptKind: 3 as ts.ScriptKind }
        : undefined
    },
  },
})
