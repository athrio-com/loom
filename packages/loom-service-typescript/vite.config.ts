import { defineConfig, type Plugin } from 'vite'
import { builtinModules } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]

const runtimeKey = '__loomRuntime'
const runtimeSpecifiers = [
  'effect',
  '@athrio/loom-lang-services/LanguageService',
  'typescript',
]

const runtimePrefix = '\0loom-runtime:'

const loomRuntimeBridge = (): Plugin => ({
  name: 'loom-runtime-bridge',
  enforce: 'pre',
  apply: 'build',
  resolveId: (source) =>
    runtimeSpecifiers.includes(source) ? runtimePrefix + source : null,
  load: async (id) => {
    if (!id.startsWith(runtimePrefix)) return null
    const specifier = id.slice(runtimePrefix.length)
    const namespace = await import(specifier)
    const names = Object.keys(namespace).filter(
      (name) => name !== 'default' && /^[A-Za-z_$][\w$]*$/.test(name),
    )
    const head =
      `const __runtime = globalThis[${JSON.stringify(runtimeKey)}]\n` +
      `if (__runtime === undefined) throw new Error(${JSON.stringify(
        `the Loom host runtime is not installed; ${specifier} cannot load`,
      )})\n` +
      `const __module = __runtime.modules[${JSON.stringify(specifier)}]\n`
    const bindings = names
      .map((name) => `export const ${name} = __module[${JSON.stringify(name)}]`)
      .join('\n')
    const fallback =
      'default' in namespace
        ? 'export default __module.default ?? __module'
        : 'export default __module'
    return `${head}${bindings}\n${fallback}\n`
  },
})

export default defineConfig({
  plugins: [loomRuntimeBridge()],
  build: {
    target: 'node20',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    commonjsOptions: { transformMixedEsModules: true },
    lib: {
      entry: resolve(here, 'src/TypescriptService.ts'),
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: nodeBuiltins,
    },
  },
})
