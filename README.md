# Loom Literate Framework

> **Pre-release · experimental.** Research baseline. No published
> artifacts, no API stability, no support guarantees.

The Loom Literate Framework (Loom) treats prose interleaved with code as the
single source of truth, in the literate-programming tradition established
by Knuth (1984, *The Computer Journal* 27(2)). The `loom` CLI tangles
the code from Manifests into runnable artifacts and weaves the prose into
readable documentation.

## Maintainers — packaging assumption

The Vite build for `packages/loom-lang` and `packages/loom-vscode`
**externalizes all runtime `dependencies`** rather than bundling them.
This is deliberate: rolldown (Vite 8's bundler) cannot statically rewrite
the `require()` calls inside UMD wrappers used by packages such as
`vscode-html-languageservice`, so attempting to bundle them produces a
`MODULE_NOT_FOUND` at runtime.

The externals list is derived automatically from each package's
`dependencies` field — any package added there is excluded from the
bundle and resolved by Node against `node_modules` at runtime.

Consequences:

- **Dev (Extension Development Host):** works as-is. pnpm fully links
  `packages/*/node_modules/` with symlinks into `.pnpm/`, so the spawned
  language-server process resolves its deps normally.
- **VSIX packaging:** `vsce package` does not follow pnpm's symlinks
  correctly. Before publishing, flatten the dep tree first:

  ```sh
  pnpm deploy --filter @athrio/loom-lang <staging-dir>
  ```

  Then either run `vsce package` from the staged directory, or have
  the VS Code extension's `vscode:prepublish` step copy the deployed
  server into the extension before packaging.

## Licence

Dual-licensed under [MIT](./LICENSE-MIT) and [Apache-2.0](./LICENSE-APACHE).
