# Upstream provenance

`@athrio/foldkit-devtools-mcp` is a vendored fork of **@foldkit/devtools-mcp**,
the Model Context Protocol server that connects to a running Foldkit app and
hands its DevTools to an AI agent as tools — reading the model, listing the
message history, replaying to a past state, and dispatching a message. It
reaches the app through the relay port `@athrio/foldkit-vite-plugin` opens, and
speaks the protocol to the agent over standard input and output.

- **Upstream**: https://github.com/foldkit/foldkit (`packages/devtools-mcp`)
- **Base version**: `@foldkit/devtools-mcp@0.13.2`
- **Base commit**: `9439cbf30c3d31baded144eca36a9897d00030a0`
- **Vendored**: 2026-07-17
- **License**: MIT (see `LICENSE`, retained from upstream)

## What was taken

`src/server.ts`, `src/tools.ts`, `src/webSocketClient.ts`, and `src/install.ts`
verbatim, and `README.md`. The upstream build chain is replaced by a single
`tsconfig.json` that checks `src` in place; the package serves from source and
runs under Bun, so its bin and its export both point at `./src/server.ts`.

## Our delta

The same mechanical patches the other forks carry. The two
`foldkit/devtools-protocol` import specifiers become
`@athrio/foldkit/devtools-protocol`. The manifest pins `effect` at
`4.0.0-beta.97`, takes `@athrio/foldkit` as a workspace dependency, and keeps
the upstream `@modelcontextprotocol/sdk` and `ws` dependencies. The source is
otherwise pristine `0.128.1`, which carries upstream's own move to `beta.97` —
including the reconnect schedule's shift to the `Schedule.modifyDelay` metadata
callback.

## Reconciling with upstream

The `src` here begins as the pristine base commit above, so an upstream fix
reconciles as a standard diff: cherry-pick it, re-apply the import repoint where
it touches the changed lines, and re-test.
