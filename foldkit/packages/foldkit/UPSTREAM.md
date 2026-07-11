# Upstream provenance

`@athrio/foldkit` is a vendored fork of **foldkit**, kept in-tree so the reader
can run on the same Effect version as the rest of Loom rather than the exact
`effect` beta foldkit pins.

- **Upstream**: https://github.com/foldkit/foldkit (`packages/foldkit`)
- **Base version**: `foldkit@0.127.0`
- **Base commit**: `a81f7d6c42215d9d6c733e3dbfdd596e0394dcf0`
- **Vendored**: 2026-07-10
- **License**: MIT (see `LICENSE`, retained from upstream)

## What was taken

The framework source under `src/`, verbatim, **excluding** the upstream test
and story files (`*.test.ts`, `*.story.ts`, `test/`, `story/`, `scene/`), and the
matching test-only export subpaths (`./scene`, `./story`, `./test`,
`./test/vitest`).

## Our delta

The port from `effect@4.0.0-beta.88` (foldkit's pin) to `effect@4.0.0-beta.93`
(Loom's) is the fork's reason to exist. That port costs **nothing at the source
level**: from `0.122.1` through `0.127.0` the framework source compiles against
`beta.93` unchanged, so the delta lives entirely in `package.json` — the `effect`
and `@effect/platform-browser` pins. The one source patch we carry is mechanical:
`src/index.ts` drops the two `./test/*` re-exports, since the test files are not
vendored.

## Reconciling with upstream

The `src/` here begins as the pristine base commit above, so upstream fixes
reconcile as a standard diff. The `0.122.1 → 0.127.0` upgrade is the worked
proof: turn the vendored `src/` into one commit over the base, cherry-pick it
onto the new upstream tag, and the only conflict is the `index.ts` patch meeting
upstream's new neighbouring exports — resolved by keeping both. Then re-copy the
new `src/` (minus the excluded files), rebuild the export map from upstream's
(minus the test-only subpaths), and re-test. Keep the source structure close to
upstream so that diff stays clean, and treat notable port fixes as candidate
upstream pull requests.
