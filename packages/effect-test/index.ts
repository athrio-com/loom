import { Effect, Scope } from 'effect'

// bun:test binds `describe`/`it`/`expect` to the file that imports them, so every
// test file imports those from 'bun:test' directly. `effectify` adds the one thing
// bun lacks — `it.effect` — to a file's own `it`: it runs an Effect-returning body
// to a promise bun awaits, under a fresh Scope and the live default services. This
// mirrors @effect/vitest's `it.effect` for the subset Loom uses — no TestClock, no
// TestServices, just run the program. It imports no test binding of its own, so it
// never steals another file's registration context.
type BunIt = typeof import('bun:test')['it']

export const effectify = (
  it: BunIt,
): BunIt & {
  readonly effect: (
    name: string,
    body: () => Effect.Effect<unknown, unknown, Scope.Scope>,
    timeout?: number,
  ) => void
} =>
  Object.assign(it, {
    effect: (
      name: string,
      body: () => Effect.Effect<unknown, unknown, Scope.Scope>,
      timeout?: number,
    ) => it(name, () => Effect.runPromise(Effect.scoped(body())), timeout),
  })
