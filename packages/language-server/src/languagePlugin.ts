import type { CodeMapping, LanguagePlugin, VirtualCode } from "@volar/language-core";
import type { URI } from "vscode-uri";
import type * as ts from "typescript";
import type { LoomDocument } from "./ast/LoomDocument";

// =============================================================================
// Loom language plugin — activation stub.
//
// No parsing. Every entry point logs its invocation so we can verify the
// expected sequence when a .loom file is opened, changed, and closed:
//
//   1. getLanguageId(uri)            once per file URI Volar inspects
//   2. createVirtualCode(...)        on open, returns a LoomVirtualCode
//   3. LoomVirtualCode constructor   triggers onSnapshotUpdated once
//   4. updateVirtualCode(...)        on every textDocument/didChange
//   5. LoomVirtualCode.update(...)   triggers onSnapshotUpdated again
//
// Logs surface in VSCode's Output panel under the "Loom Language Server"
// channel (View → Output, select from dropdown).
// =============================================================================

export const loomLanguagePlugin = {
  getLanguageId(uri) {
    console.log("[Loom] getLanguageId:", uri.path);
    if (uri.path.endsWith(".loom")) {
      console.log("[Loom]   -> matched 'loom'");
      return "loom";
    }
  },
  createVirtualCode(uri, languageId, _snapshot) {
    console.log("[Loom] createVirtualCode:", uri.path, "languageId=", languageId);
    if (languageId === "loom") {
      console.log("[Loom]   -> constructing LoomVirtualCode");
      return new LoomVirtualCode(_snapshot);
    }
  },
  updateVirtualCode(uri, languageCode: LoomVirtualCode, snapshot) {
    console.log("[Loom] updateVirtualCode:", uri.path);
    languageCode.update(snapshot);
    return languageCode;
  },
} satisfies LanguagePlugin<URI>;

export class LoomVirtualCode implements VirtualCode {
  id = "root";
  languageId = "loom";
  mappings: CodeMapping[] = [];
  embeddedCodes: VirtualCode[] = [];
  // Stash the parsed AST so custom services can read it later
  // without re-parsing — same pattern the starter uses with htmlDocument.
  document: LoomDocument | undefined;

  constructor(public snapshot: ts.IScriptSnapshot) {
    console.log("[Loom]   LoomVirtualCode constructor: length =", snapshot.getLength());
    this.onSnapshotUpdated();
  }

  update(newSnapshot: ts.IScriptSnapshot) {
    console.log("[Loom]   LoomVirtualCode.update: length =", newSnapshot.getLength());
    this.snapshot = newSnapshot;
    this.onSnapshotUpdated();
  }

  private onSnapshotUpdated() {
    const text = this.snapshot.getText(0, this.snapshot.getLength());

    // Identity mapping over the whole document.
    // Required by the VirtualCode interface; without it, Volar treats this
    // file as opaque and downstream services see no source coordinates.
    this.mappings = [{
      sourceOffsets: [0],
      generatedOffsets: [0],
      lengths: [text.length],
      data: {
        completion: true,
        format: true,
        navigation: true,
        semantic: true,
        structure: true,
        verification: true,
      },
    }];

    console.log("[Loom]   onSnapshotUpdated: text length =", text.length);
    console.log("[Loom]   first 200 chars:", JSON.stringify(text.slice(0, 200)));

    // Real work goes here once activation is confirmed:
    // this.document = parseLoom(text)
    // this.embeddedCodes = [...this.collectEmbeddedCodes()]
  }
}
