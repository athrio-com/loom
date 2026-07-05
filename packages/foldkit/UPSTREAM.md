# Upstream provenance

`@athrio/foldkit` is a vendored fork of **foldkit**, kept in-tree so the reader
can run on the same Effect version as the rest of Loom rather than the exact
`effect` beta foldkit pins.

- **Upstream**: https://github.com/foldkit/foldkit (`packages/foldkit`)
- **Base version**: `foldkit@0.122.1`
- **Base commit**: `9717a2ac9bbe352ea8b612affcbc70d77436eed9`
- **Vendored**: 2026-07-05
- **License**: MIT (see `LICENSE`, retained from upstream)

## What was taken

The framework source under `src/`, verbatim, **excluding** the upstream test
and story files (`*.test.ts`, `*.story.ts`, `test/`, `story/`, `scene/`).

## Our delta

One change of substance: the port from `effect@4.0.0-beta.88` (foldkit's pin) to
`effect@4.0.0-beta.93` (Loom's). That delta is the fork's reason to exist and is
meant to shrink — or disappear — once upstream foldkit tracks a compatible
`effect`.

## Reconciling with upstream

The `src/` here begins as the pristine base commit above, so upstream fixes
reconcile as a standard diff: import the new upstream release over the base,
re-apply our port delta, resolve conflicts, re-test. Keep the source structure
close to upstream so that diff stays clean, and treat notable port fixes as
candidate upstream pull requests.
