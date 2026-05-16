import { defineConfig } from "vite"
import { builtinModules, createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const requireFromHere = createRequire(import.meta.url)

const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]

// vscode-*-languageservice and jsonc-parser ship UMD bundles that
// rolldown can't statically follow. Rewrite imports to their ESM
// siblings so the bundler can inline them. Same trick as volarjs/starter.
const umd2esm = {
  name: "umd2esm",
  enforce: "pre" as const,
  resolveId(source: string, importer: string | undefined) {
    if (/^(vscode-.*-languageservice|jsonc-parser)/.test(source)) {
      const fromDir = importer ? dirname(importer) : here
      const resolved = requireFromHere.resolve(source, { paths: [fromDir] })
      return resolved.replace(/\/umd\//, "/esm/").replace(/\\umd\\/g, "\\esm\\")
    }
    return null
  },
}

export default defineConfig({
  plugins: [umd2esm],
  resolve: {
    conditions: ["node"],
    mainFields: ["main", "module"],
  },
  build: {
    target: "node20",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: {
      entry: {
        client: resolve(here, "src/vscode-extension.ts"),
        server: resolve(here, "../language-server/src/index.ts"),
      },
      formats: ["cjs"],
    },
    rollupOptions: {
      external: ["vscode", ...nodeBuiltins],
      output: { entryFileNames: "[name].js" },
    },
  },
})
