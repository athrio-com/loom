import type { CompilerOptions } from 'typescript'

type TypeScript = typeof import('typescript')

const loomBaseline = (ts: TypeScript): CompilerOptions => ({
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
})

const resolvesPackageExports = (
  ts: TypeScript,
  mode: CompilerOptions['moduleResolution'],
): boolean =>
  mode === ts.ModuleResolutionKind.Bundler ||
  mode === ts.ModuleResolutionKind.Node16 ||
  mode === ts.ModuleResolutionKind.NodeNext

const mergeBaseline = (
  ts: TypeScript,
  consumer: CompilerOptions,
): CompilerOptions => {
  const base = loomBaseline(ts)
  const merged: CompilerOptions = { ...base, ...consumer, noEmit: true }
  if (!resolvesPackageExports(ts, consumer.moduleResolution)) {
    merged.module = base.module
    merged.moduleResolution = base.moduleResolution
  }
  return merged
}

const mergingParse = <A extends ReadonlyArray<unknown>, R extends { options: CompilerOptions }>(
  ts: TypeScript,
  parse: (...args: A) => R,
) => (...args: A): R => {
  const parsed = parse(...args)
  return { ...parsed, options: mergeBaseline(ts, parsed.options) }
}

export const withLoomBaseline = (ts: TypeScript): TypeScript =>
  Object.create(ts, {
    parseJsonConfigFileContent: {
      enumerable: true,
      configurable: true,
      writable: true,
      value: mergingParse(ts, ts.parseJsonConfigFileContent),
    },
    parseJsonSourceFileConfigFileContent: {
      enumerable: true,
      configurable: true,
      writable: true,
      value: mergingParse(ts, ts.parseJsonSourceFileConfigFileContent),
    },
  })
