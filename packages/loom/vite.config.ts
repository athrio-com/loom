import { defineConfig } from 'vite'
import { builtinModules, createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const requireFromHere = createRequire(import.meta.url)

const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]

const bunBuiltins = ['bun', /^bun:/]

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

const overlayFile = resolve(here, '..', 'loom-notes', 'dist', 'overlay.js')

const inlineOverlay = {
  name: 'inline-overlay',
  renderChunk(code: string) {
    if (!code.includes('__LOOM_OVERLAY_B64__')) return null
    const base64 = readFileSync(overlayFile).toString('base64')
    return { code: code.replaceAll('__LOOM_OVERLAY_B64__', base64), map: { mappings: '' } }
  },
}

export default defineConfig({
  plugins: [umd2esm, inlineOverlay],
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
    target: 'esnext',
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
      external: [...nodeBuiltins, ...bunBuiltins],
      output: { banner: '#!/usr/bin/env bun' },
    },
  },
})
