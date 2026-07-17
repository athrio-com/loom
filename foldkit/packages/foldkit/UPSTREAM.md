# Upstream provenance

`@athrio/foldkit` is a vendored fork of **foldkit**, kept in-tree so the reader
can run on the same Effect version as the rest of Loom rather than the exact
`effect` beta foldkit pins.

- **Upstream**: https://github.com/foldkit/foldkit (`packages/foldkit`)
- **Base version**: `foldkit@0.128.1`
- **Base commit**: `9439cbf30c3d31baded144eca36a9897d00030a0`
- **Vendored**: 2026-07-17
- **License**: MIT (see `LICENSE`, retained from upstream)

## What was taken

The framework source under `src/`, verbatim, **excluding** the upstream test
and story files (`*.test.ts`, `*.story.ts`, `test/`, `story/`, `scene/`), and the
matching test-only export subpaths (`./scene`, `./story`, `./test`,
`./test/vitest`).

## Our delta

At `0.128.1` foldkit moved its own `effect` pin to `4.0.0-beta.97`, and Loom
moved to meet it, so the version mismatch that first justified the fork is gone:
both now pin `beta.97`. What remains is a capability foldkit does not ship —
server-side hydration. The fork adds one seam for it, in `runtime.ts` and the
`vdom.ts` it calls: a `hydrate?: HydrationStrategy` config field (the type
defined in `vdom.ts`, re-exported from `runtime`) and a branch in `__patchVNode`
that, on the first render with server DOM present, reads that DOM through the
strategy instead of building fresh. `@athrio/foldkit-hydration` supplies the
strategy; the fork holds only the hook.

The rest of the delta is packaging, not logic: the export map serves
`./src/*.ts` rather than a built `./dist`, adds `./vdom`, and `src/index.ts`
drops the two `./test/*` re-exports (`Scene`, `Story`), since the test files are
not vendored. The framework source itself compiles against `beta.97` unchanged.

## Reconciling with upstream

The `src/` here begins as the pristine base commit above, so upstream fixes
reconcile as a standard diff. The `0.127.0 → 0.128.1` upgrade is the worked
proof: re-copy the new `src/` (minus the excluded test files), rebuild the
export map from upstream's (minus the test-only subpaths, plus `./vdom`), and
replay the seam. The one real conflict was upstream's move of `patchVNode` out
of `runtime.ts` into `vdom.ts` as `__patchVNode` — the seam followed it there,
so the `hydrate` branch now lives beside the function it modifies. Keep the
source structure close to upstream so that diff stays clean, and treat the seam
as a candidate upstream pull request.
