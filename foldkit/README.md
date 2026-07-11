# Vendored Foldkit

This directory mirrors the upstream **foldkit** monorepo
(https://github.com/foldkit/foldkit), so that Loom runs Foldkit on the same
Effect version as the rest of the repository rather than the `effect` beta
Foldkit pins. The `packages/` layout here matches upstream's `packages/`
one-to-one, so a subtree reconciles against upstream as a single diff.

Vendored at base commit `a81f7d6c42215d9d6c733e3dbfdd596e0394dcf0`
(`foldkit@0.127.0`). Each package keeps its own `UPSTREAM.md` recording what was
taken and the delta from upstream.

- `packages/foldkit` — `@athrio/foldkit`, the framework.
- `packages/vite-plugin-foldkit` — `@athrio/foldkit-vite-plugin`: hot module
  reloading with model preservation, and the DevTools relay port.
- `packages/devtools-mcp` — `@athrio/foldkit-devtools-mcp`: the DevTools MCP
  server an agent drives the running app through.

This is third-party source, copied verbatim apart from the mechanical delta each
`UPSTREAM.md` describes. It is not authored in Loom and is not tangled. To change
it, reconcile against upstream — do not hand-edit it as if it were ours.
