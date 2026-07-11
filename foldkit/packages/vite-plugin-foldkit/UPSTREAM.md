# Upstream provenance

`@athrio/foldkit-vite-plugin` is a vendored fork of **@foldkit/vite-plugin**,
kept in-tree for the same reason as `@athrio/foldkit`: to run on the Effect
version the rest of Loom uses rather than the `effect` beta the upstream plugin
pins. It gives the site state-preserving hot module reloading, and it opens the
DevTools relay port the Foldkit DevTools MCP connects through.

- **Upstream**: https://github.com/foldkit/foldkit (`packages/vite-plugin-foldkit`)
- **Base version**: `@foldkit/vite-plugin@0.10.0`
- **Base commit**: `a81f7d6c42215d9d6c733e3dbfdd596e0394dcf0`
- **Vendored**: 2026-07-11
- **License**: MIT (see `LICENSE`, retained from upstream)

## What was taken

`src/index.ts` verbatim, and `README.md`. The upstream `tsconfig.base.json` /
`tsconfig.json` build chain is replaced by a single `tsconfig.json` that checks
`src` in place, since the package serves from source like `@athrio/foldkit`
rather than emitting a `dist`.

## Our delta

Two mechanical patches, both the same kind as the framework fork's:

- **Import repoint.** The three bare `foldkit` specifiers become their
  `@athrio/foldkit` equivalents — `foldkit/devtools-protocol` and
  `foldkit/hmr-protocol` in the imports, and `'foldkit'` in the
  `FOLDKIT_SINGLETON_PACKAGES` dedupe list (with the optional `@foldkit/ui` and
  `@foldkit/devtools` entries renamed to `@athrio/foldkit-ui` and
  `@athrio/foldkit-devtools` for when those are vendored).
- **Manifest.** The `effect` peer pin moves to `4.0.0-beta.93`, `foldkit`
  becomes the `@athrio/foldkit` workspace dependency, and the package exports
  `./src/index.ts` directly.

The source itself compiles against `beta.93` unchanged, so — as with the
framework — the port costs nothing at the source level.

## Reconciling with upstream

The `src/index.ts` here begins as the pristine base commit above, so an upstream
fix reconciles as a standard diff: cherry-pick it, re-apply the import repoint
where it touches the changed lines, and re-test. Keep the source close to
upstream so that diff stays clean.
