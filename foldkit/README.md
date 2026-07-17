# Vendored Foldkit

`packages/foldkit` is a vendored fork of the upstream **foldkit** framework
(https://github.com/foldkit/foldkit). Loom keeps it in-tree because it carries
one change upstream does not ship — the server-side hydration seam its SSR
needs. The vendored package takes Foldkit's own name, `foldkit`, shadowing the
registry, so Loom's code and Foldkit's own sibling packages resolve `foldkit` to
this copy.

Vendored at base commit `9439cbf30c3d31baded144eca36a9897d00030a0`
(`foldkit@0.128.1`). `UPSTREAM.md` beside the source records what was taken and
the delta from upstream.

Only the framework is vendored. Loom pins the same `effect` beta as upstream
now, so Foldkit's other packages — the Vite plugin, the DevTools MCP server —
are taken from the registry directly rather than forked; the version mismatch
that once forced forking them is gone.

- `packages/foldkit` — `foldkit`, the framework. Third-party source, vendored.
- `packages/foldkit-ssr`, `packages/foldkit-hydration` — Loom's own
  loom-authored packages: the server renderer and the hydration strategy that
  plug into the framework's seam. Not vendored.

The framework source is third-party, copied verbatim apart from the mechanical
delta `UPSTREAM.md` describes. It is not authored in Loom and is not tangled. To
change it, reconcile against upstream — do not hand-edit it as if it were ours.
