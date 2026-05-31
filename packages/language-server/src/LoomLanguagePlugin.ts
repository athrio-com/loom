import type { LanguagePlugin, VirtualCode } from '@volar/language-core'
import type { URI } from 'vscode-uri'
import type * as ts from 'typescript'

// =============================================================================
// loomLanguagePlugin — three pure functions Volar dispatches:
//
//   Uri                                   → string | undefined   (languageId)
//   (Uri, languageId, Snapshot)           → VirtualCode | undefined
//   (Uri, oldVirtualCode, Snapshot)       → VirtualCode
//
// The `oldVirtualCode` argument is intentionally ignored: rebuild from
// snapshot, let the old one become collectable.
// =============================================================================

export const loomLanguagePlugin: LanguagePlugin<URI> = {
  getLanguageId(uri) {
    if (uri.path.endsWith('.loom')) return 'loom'
  },
  createVirtualCode(_uri, languageId, snapshot) {
    if (languageId === 'loom') return buildVirtualCode(snapshot)
  },
  updateVirtualCode(_uri, _old, snapshot) {
    return buildVirtualCode(snapshot)
  },
}

const buildVirtualCode = (snapshot: ts.IScriptSnapshot): VirtualCode => ({
  id: 'root',
  languageId: 'loom',
  snapshot,
  mappings: [],
  embeddedCodes: [],
})

// Full VirtualCode interface:
// id: string;
// languageId: string;
// snapshot: IScriptSnapshot;
// mappings: CodeMapping[];
// embeddedCodes?: VirtualCode[];
// associatedScriptMappings?: Map<unknown, CodeMapping[]>;
// linkedCodeMappings?: Mapping[];
