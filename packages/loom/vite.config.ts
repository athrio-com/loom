import { defineConfig } from 'vite'
import { builtinModules, createRequire } from 'node:module'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const requireFromHere = createRequire(import.meta.url)

const nodeBuiltins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)]

const umd2esm = {
  name: 'umd2esm',
  enforce: 'pre' as const,
  resolveId(source: string, importer: string | undefined) {
    if (/^(vscode-.*-languageservice|jsonc-parser)/.test(source)) {
      const fromDir = importer ? dirname(importer) : here
      const resolved = requireFromHere.resolve(source, { paths: [fromDir] })
      return resolved.replace(/\/umd\//, '/esm/').replace(/\\umd\\/g, '\\esm\\')
    }
    return null
  },
}

const grammarRoot = resolve(here, '..', 'tree-sitter-loom')

const grammarFiles = [
  'src/parser.c',
  'src/scanner.c',
  'src/tree_sitter',
  'queries',
  'editors/helix/queries/loom',
]

const filesUnder = (path: string): ReadonlyArray<string> =>
  statSync(resolve(grammarRoot, path)).isDirectory()
    ? readdirSync(resolve(grammarRoot, path)).flatMap((name) => filesUnder(`${path}/${name}`))
    : [path]

const grammarModule = 'virtual:tree-sitter-loom'

const editorGrammar = {
  name: 'editor-grammar',
  resolveId: (source: string) => (source === grammarModule ? `\0${grammarModule}` : null),
  load: (id: string) =>
    id === `\0${grammarModule}`
      ? `export default ${JSON.stringify(
          Object.fromEntries(
            grammarFiles
              .flatMap(filesUnder)
              .map((file) => [file, readFileSync(resolve(grammarRoot, file), 'utf8')]),
          ),
        )}`
      : null,
}

export default defineConfig({
  plugins: [umd2esm, editorGrammar],
  resolve: {
    conditions: ['node'],
    mainFields: ['main', 'module'],
    alias: {
      yaml: resolve(dirname(requireFromHere.resolve('yaml/package.json')), 'browser/index.js'),
      'vscode-uri': requireFromHere
        .resolve('vscode-uri')
        .replace(/esm[\\/]index\.mjs$/, 'umd/index.js'),
    },
  },
  build: {
    target: 'node20',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: {
      entry: resolve(here, 'src/main.ts'),
      formats: ['es'],
      fileName: () => 'main.js',
    },
    rollupOptions: {
      external: [...nodeBuiltins, 'bun:sqlite', 'node:sqlite'],
      output: { banner: '#!/usr/bin/env node' },
    },
  },
})
