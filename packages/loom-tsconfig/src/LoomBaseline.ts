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

const bakedParse = <A extends ReadonlyArray<unknown>, R extends { options: CompilerOptions }>(
  ts: TypeScript,
  parse: (...args: A) => R,
) => (...args: A): R => {
  const parsed = parse(...args)
  return { ...parsed, options: loomBaseline(ts) }
}

export const withLoomBaseline = (ts: TypeScript): TypeScript =>
  Object.create(ts, {
    parseJsonConfigFileContent: {
      enumerable: true,
      configurable: true,
      writable: true,
      value: bakedParse(ts, ts.parseJsonConfigFileContent),
    },
    parseJsonSourceFileConfigFileContent: {
      enumerable: true,
      configurable: true,
      writable: true,
      value: bakedParse(ts, ts.parseJsonSourceFileConfigFileContent),
    },
  })
