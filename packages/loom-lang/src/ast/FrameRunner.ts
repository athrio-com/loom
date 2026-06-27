import { Array as Arr, Effect, Layer, pipe } from 'effect'
import * as effect from 'effect'
import * as dsl from '../dsl'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, resolve as resolvePath } from 'node:path'
import type { Code, File, Product } from '@athrio/loom-ast/ProductAst'

type AnyLayer = Layer.Layer<never, never, never>

interface ServiceTag {
  readonly key: string
}

interface ServiceNode {
  readonly layer: AnyLayer
  readonly self: ServiceTag
  readonly deps: ReadonlyArray<ServiceTag | undefined>
}

interface ManifestResult {
  readonly sections: ReadonlyMap<string, Code>
  readonly files: ReadonlyArray<File>
}

interface EvaledFrame {
  readonly __services: Record<string, ServiceNode>
  readonly __run: Effect.Effect<ManifestResult>
}

const stripFrame = (frame: string): string =>
  stripTypeScriptTypes(frame, { mode: 'strip' })

const maskTemplates = (
  source: string,
): { readonly masked: string; readonly restore: (s: string) => string } => {
  const literals: Array<string> = []
  const masked = source.replace(/`(?:\\.|[^`\\])*`/g, (literal) => {
    literals.push(literal)
    return `\u0000${literals.length - 1}\u0000`
  })
  const restore = (s: string): string =>
    s.replace(/\u0000(\d+)\u0000/g, (_, i) => literals[Number(i)]!)
  return { masked, restore }
}

const toEvalable = (frame: string): string => {
  const { masked, restore } = maskTemplates(stripFrame(frame))
  const names = pipe(
    [...masked.matchAll(/^export (?:class|const|function|async function) (\w+)/gm)],
    Arr.map((m) => m[1]),
  )
  const cjs = masked
    .replace(/^import \* as (\w+) from ["']([^"']+)["'];?\s*$/gm, 'const $1 = require("$2");')
    .replace(/^import \{([^}]+)\} from ["']([^"']+)["'];?\s*$/gm, 'const {$1} = require("$2");')
    .replace(/^import ["']([^"']+)["'];?\s*$/gm, 'require("$1");')
    .replace(/^export (class|const|function|async function) /gm, '$1 ')
  return `${restore(cjs)}\nObject.assign(module.exports, {${names.join(', ')}})`
}

const evalFrame = (
  frame: string,
  require: (id: string) => unknown,
): EvaledFrame => {
  const module = { exports: {} as Record<string, unknown> }
  new Function('require', 'module', 'exports', toEvalable(frame))(
    require,
    module,
    module.exports,
  )
  return { ...emptyEvaled, ...module.exports } as unknown as EvaledFrame
}

const importsOf = (path: string, frame: string): ReadonlyArray<string> =>
  pipe(
    [...frame.matchAll(/from ["'](\.[^"']*\.loom)["']/g)],
    Arr.map((m) => resolvePath(dirname(path), m[1])),
  )

const topoSort = <A>(
  nodes: ReadonlyArray<A>,
  keyOf: (a: A) => string,
  depsOf: (a: A) => ReadonlyArray<string>,
): ReadonlyArray<A> => {
  const byKey = new Map(nodes.map((n) => [keyOf(n), n] as const))
  type Acc = { readonly order: ReadonlyArray<A>; readonly seen: ReadonlySet<string> }
  const visit = (acc: Acc, key: string): Acc => {
    if (acc.seen.has(key)) return acc
    const node = byKey.get(key)
    const seen = new Set(acc.seen).add(key)
    return node === undefined
      ? { order: acc.order, seen }
      : pipe(
          Arr.reduce(depsOf(node), { order: acc.order, seen } as Acc, visit),
          (after) => ({ order: [...after.order, node], seen: after.seen }),
        )
  }
  return Arr.reduce(
    nodes,
    { order: [], seen: new Set<string>() } as Acc,
    (acc, n) => visit(acc, keyOf(n)),
  ).order
}

const emptyEvaled: EvaledFrame = {
  __services: {},
  __run: Effect.suspend(() => Effect.succeed(emptyManifest)),
}

const evalFrameSafe = (
  frame: string,
  require: (id: string) => unknown,
): EvaledFrame => {
  try {
    return evalFrame(frame, require)
  } catch {
    return emptyEvaled
  }
}

const evalCorpus = (
  frames: ReadonlyMap<string, string>,
): ReadonlyMap<string, EvaledFrame> =>
  pipe(
    topoSort(
      [...frames.keys()],
      (p) => p,
      (p) => importsOf(p, frames.get(p) ?? ''),
    ),
    Arr.reduce(new Map<string, EvaledFrame>(), (evaled, path) => {
      const require = (id: string): unknown =>
        id === '@athrio/loom-lang/dsl'
          ? dsl
          : id === 'effect'
            ? effect
            : evaled.get(resolvePath(dirname(path), id))
      return new Map(evaled).set(
        path,
        evalFrameSafe(frames.get(path) ?? '', require),
      )
    }),
  )

type Services = ReadonlyMap<string, ServiceNode>

const depKeys = (node: ServiceNode): ReadonlyArray<string> =>
  node.deps.flatMap((d) => (d ? [d.key] : []))

const indexServices = (evaled: ReadonlyMap<string, EvaledFrame>): Services =>
  new Map(
    pipe(
      [...evaled.values()],
      Arr.flatMap((m) => Object.values(m.__services)),
      Arr.map((node) => [node.self.key, node] as const),
    ),
  )

const coneOf = (
  services: Services,
  seeds: ReadonlyArray<string>,
): ReadonlyArray<ServiceNode> => {
  const visit = (seen: ReadonlySet<string>, key: string): ReadonlySet<string> => {
    if (seen.has(key)) return seen
    const node = services.get(key)
    return node === undefined
      ? seen
      : Arr.reduce(depKeys(node), new Set(seen).add(key), visit)
  }
  return pipe(
    Arr.reduce(seeds, new Set<string>(), visit),
    (keys) =>
      Arr.flatMap([...keys], (key) => {
        const node = services.get(key)
        return node === undefined ? [] : [node]
      }),
  )
}

const wireCone = (cone: ReadonlyArray<ServiceNode>): AnyLayer =>
  pipe(
    topoSort(cone, (node) => node.self.key, depKeys),
    Arr.map((node) => node.layer),
    Arr.matchLeft({
      onEmpty: () => Layer.empty as AnyLayer,
      onNonEmpty: (head, tail) =>
        Arr.reduce(tail, head, (ctx, layer) => Layer.provideMerge(layer, ctx)),
    }),
  )

const emptyManifest: ManifestResult = {
  sections: new Map(),
  files: [],
}

const collect = (
  evaled: ReadonlyMap<string, EvaledFrame>,
): Effect.Effect<ReadonlyMap<string, Product>> => {
  const services = indexServices(evaled)
  return pipe(
    Effect.forEach([...evaled.entries()], ([path, m]) => {
      const seeds = Object.values(m.__services).map((node) => node.self.key)
      const wired = wireCone(coneOf(services, seeds))
      return m.__run.pipe(
        Effect.provide(wired),
        Effect.map((result) => [path, result] as const),
        Effect.catchAllCause(() => Effect.succeed([path, emptyManifest] as const)),
      )
    }),
    Effect.map(
      (results) =>
        new Map(
          results.map(([path, r]) => [
            path,
            { code: [...r.sections.values()], files: [...r.files] },
          ]),
        ),
    ),
  )
}

export class FrameRunner extends Effect.Service<FrameRunner>()('FrameRunner', {
  succeed: {
    produce: (
      frames: ReadonlyMap<string, string>,
    ): Effect.Effect<ReadonlyMap<string, Product>> =>
      Effect.suspend(() => collect(evalCorpus(frames))).pipe(
        Effect.catchAllCause(() => Effect.succeed(new Map<string, Product>())),
      ),
  },
}) {}
