import { defineConfig } from 'vite'
import { builtinModules, createRequire } from 'node:module'
import { cpSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const requireFromHere = createRequire(import.meta.url)

const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]

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

const grammarFiles = [
  'src/parser.c',
  'src/scanner.c',
  'src/tree_sitter',
  'queries',
  'editors/helix/queries/loom',
]

const editorGrammar = {
  name: 'editor-grammar',
  closeBundle() {
    grammarFiles.forEach((file) =>
      cpSync(
        resolve(here, '..', 'tree-sitter-loom', file),
        resolve(here, 'dist', 'tree-sitter-loom', file),
        { recursive: true },
      ),
    )
  },
}

export default defineConfig({
  plugins: [umd2esm, editorGrammar],
  resolve: {
    conditions: ['node'],
    mainFields: ['main', 'module'],
    alias: {
      yaml: resolve(
        dirname(requireFromHere.resolve('yaml/package.json')),
        'browser/index.js',
      ),
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
